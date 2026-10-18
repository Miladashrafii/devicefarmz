import type { FileEntry, ScreenPreference, TouchContact } from '@devicefarmz/core'
import * as adb from './adb.js'
import { config, scrcpyAvailable } from './config.js'
import { registry } from './registry.js'
import { ScrcpyStream } from './scrcpy.js'
import { BaseWorker, ProviderBase, type ResetReport } from './worker-base.js'

const MEDIA_DIRS = ['/sdcard/Download', '/sdcard/DCIM', '/sdcard/Pictures', '/sdcard/Movies', '/sdcard/Documents']

function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

export class AndroidWorker extends BaseWorker {
  readonly platform = 'android' as const
  private inputShell: adb.PersistentShell
  private frameTimer: NodeJS.Timeout | null = null
  private frameSubs = 0
  private stream: ScrcpyStream | null = null
  private logcat: { stop: () => void } | null = null
  private touch: { x: number; y: number; at: number } | null = null
  private destroyed = false
  private capturing = false

  constructor(serial: string) {
    super(serial)
    this.inputShell = new adb.PersistentShell(serial)
  }

  async prepare(): Promise<void> {
    registry.upsert({ serial: this.serial, platform: 'android', presence: 'present', ready: false, status: 'preparing' })
    const prop = (p: string) => adb.adbGetProp(this.serial, p).catch(() => '')
    const [model, manufacturer, version, sdk, product, abi, marketName, battery, display] = await Promise.all([
      prop('ro.product.model'),
      prop('ro.product.manufacturer'),
      prop('ro.build.version.release'),
      prop('ro.build.version.sdk').then(Number),
      prop('ro.product.name'),
      prop('ro.product.cpu.abi'),
      prop('ro.product.marketname'),
      adb.parseBattery(this.serial).catch(() => null),
      adb.parseDisplay(this.serial).catch(() => null),
    ])

    const phone = {
      phoneNumber: null as string | null,
      imei: null as string | null,
      imsi: null as string | null,
      iccid: null as string | null,
      network: (await prop('gsm.operator.alpha')) || null,
    }
    try {
      const raw = await adb.adbShell(this.serial, 'service call iphonesubinfo 1 2>/dev/null')
      const digits = [...raw.matchAll(/'([^']*)'/g)].map((m) => m[1]).join('').replace(/[^\d]/g, '')
      if (/^\d{14,16}$/.test(digits)) phone.imei = digits
    } catch {
      /* needs privileged access on newer Android versions */
    }

    registry.upsert({
      serial: this.serial,
      platform: 'android',
      model: model || 'Unknown',
      manufacturer: manufacturer || 'Unknown',
      version,
      sdk,
      product,
      abi,
      marketName: marketName || model,
      phone,
      battery,
      display,
      provider: config.providerName,
      channel: `device-${this.serial}`,
      presence: 'present',
      ready: true,
      status: registry.get(this.serial)?.status === 'cleaning' ? 'cleaning' : 'available',
      lastSeenAt: new Date().toISOString(),
    })
  }

  override async refreshTelemetry(): Promise<void> {
    if (this.destroyed) return
    try {
      const [battery, display] = await Promise.all([adb.parseBattery(this.serial), adb.parseDisplay(this.serial)])
      registry.upsert({ serial: this.serial, battery, display, lastSeenAt: new Date().toISOString() })
    } catch {
      /* device may have disconnected */
    }
  }

  // ---------- screen ----------

  override supportsVideo(): boolean {
    return scrcpyAvailable()
  }

  protected override async startVideo(): Promise<void> {
    const stream = new ScrcpyStream(this.serial)
    stream.on('nal', (data: Buffer) => this.emit('video.nal', { serial: this.serial, data }))
    stream.on('close', () => {
      if (this.stream === stream) this.stream = null
    })
    try {
      await stream.start()
    } catch (err) {
      stream.stop()
      throw err
    }
    this.stream = stream
  }

  protected override stopVideo(): void {
    this.stream?.stop()
    this.stream = null
  }

  async subscribeScreen(prefer: ScreenPreference, fps = config.screencapFps): Promise<ScreenPreference> {
    if (prefer === 'h264' && this.supportsVideo()) {
      try {
        const alreadyRunning = this.stream !== null
        await this.acquireVideo()
        if (alreadyRunning) {
          // A late joiner needs a fresh key frame: restart the encoder
          this.stopVideo()
          await this.startVideo()
        }
        return 'h264'
      } catch (err) {
        console.warn(`[android ${this.serial}] H.264 stream unavailable, using still frames:`, (err as Error).message)
      }
    }
    this.frameSubs += 1
    if (!this.frameTimer) {
      const interval = Math.max(150, Math.floor(1000 / Math.max(1, fps)))
      const tick = async () => {
        if (this.destroyed || this.capturing || this.frameSubs <= 0) return
        this.capturing = true
        try {
          const png = await adb.adbScreencap(this.serial)
          const d = registry.get(this.serial)
          this.emit('screen.frame', {
            serial: this.serial,
            data: png.toString('base64'),
            mime: 'image/png',
            width: d?.display?.width ?? 0,
            height: d?.display?.height ?? 0,
            rotation: d?.display?.rotation ?? 0,
          })
        } catch {
          /* transient */
        } finally {
          this.capturing = false
        }
      }
      void tick()
      this.frameTimer = setInterval(() => void tick(), interval)
    }
    return 'frames'
  }

  unsubscribeScreen(mode: ScreenPreference): void {
    if (mode === 'h264') {
      this.releaseVideo()
      return
    }
    this.frameSubs = Math.max(0, this.frameSubs - 1)
    if (this.frameSubs === 0 && this.frameTimer) {
      clearInterval(this.frameTimer)
      this.frameTimer = null
    }
  }

  // ---------- logs ----------

  protected override startLogs(): void {
    void adb.adbLogcatClear(this.serial)
    this.logcat = adb.adbLogcatStream(this.serial, (line) =>
      this.emit('log.line', { serial: this.serial, line }),
    )
  }

  protected override stopLogs(): void {
    this.logcat?.stop()
    this.logcat = null
  }

  // ---------- input ----------

  override async handleTouches(contacts: TouchContact[]): Promise<void> {
    for (const c of contacts) {
      const x = Math.round(c.x)
      const y = Math.round(c.y)
      if (c.action === 'down') {
        this.touch = { x, y, at: Date.now() }
      } else if (c.action === 'up' && this.touch) {
        const moved = Math.hypot(x - this.touch.x, y - this.touch.y)
        if (moved > 14) {
          const duration = Math.min(1500, Math.max(80, Date.now() - this.touch.at))
          this.inputShell.run(`input swipe ${this.touch.x} ${this.touch.y} ${x} ${y} ${duration}`)
        } else {
          this.inputShell.run(`input tap ${x} ${y}`)
        }
        this.touch = null
      }
    }
  }

  override async typeText(text: string): Promise<void> {
    // `input text` treats %s as space; shell-escape everything else
    const escaped = text.replace(/ /g, '%s').replace(/([^A-Za-z0-9%._@:/+=,-])/g, '\\$1')
    this.inputShell.run(`input text ${escaped}`)
  }

  override async key(code: number): Promise<void> {
    this.inputShell.run(`input keyevent ${Math.trunc(code)}`)
  }

  override async nav(kind: 'home' | 'back' | 'recent' | 'power'): Promise<void> {
    const map = { home: adb.KEY.HOME, back: adb.KEY.BACK, recent: adb.KEY.APP_SWITCH, power: adb.KEY.POWER }
    this.inputShell.run(`input keyevent ${map[kind]}`)
  }

  // ---------- tools ----------

  override async shell(command: string, onChunk: (chunk: string) => void): Promise<number> {
    try {
      onChunk(await adb.adbShell(this.serial, command, 60_000))
      return 0
    } catch (err) {
      onChunk(err instanceof Error ? err.message : String(err))
      return 1
    }
  }

  override async installApp(apkPath: string): Promise<string> {
    return adb.adbInstall(this.serial, apkPath)
  }

  override async openBrowser(url: string, packageName?: string): Promise<void> {
    await adb.openUrl(this.serial, url, packageName)
  }

  override async listFiles(path: string): Promise<FileEntry[]> {
    return adb.listRemoteDir(this.serial, path)
  }

  override async identify(): Promise<void> {
    await adb.showIdentifyOverlay(this.serial)
  }

  override async reboot(): Promise<void> {
    await adb.adbReboot(this.serial)
  }

  override async accounts() {
    return adb.listAccounts(this.serial)
  }

  override async browsers() {
    return adb.listBrowsers(this.serial)
  }

  override async reverse(devicePort: number, hostPort: number): Promise<void> {
    await adb.adbReverse(this.serial, `tcp:${devicePort}`, `tcp:${hostPort}`)
  }

  override async unreverse(devicePort: number): Promise<void> {
    await adb.adbRemoveReverse(this.serial, `tcp:${devicePort}`)
  }

  override async pullFile(remote: string, local: string): Promise<void> {
    await adb.adbPull(this.serial, remote, local)
  }

  override async getClipboard(): Promise<string> {
    const out = await adb.adbShell(this.serial, 'cmd clipboard get-primary-clip 2>/dev/null || true')
    return out.trim()
  }

  override async setClipboard(text: string): Promise<void> {
    await adb.adbShell(this.serial, `cmd clipboard set-primary-clip ${shQuote(text)} 2>/dev/null || true`)
  }

  // ---------- reset ----------

  async reset(mode: 'clean' | 'uninstall'): Promise<ResetReport> {
    const report: ResetReport = { cleaned: [], errors: [], notes: [] }
    const keep = new Set(config.resetKeepPackages)

    await adb.adbShell(this.serial, `input keyevent ${adb.KEY.HOME}`).catch(() => undefined)

    try {
      const packages = (await adb.listThirdPartyPackages(this.serial)).filter((p) => !keep.has(p))
      for (const pkg of packages) {
        try {
          await adb.adbShell(this.serial, `am force-stop ${pkg}`)
          if (mode === 'uninstall') {
            const out = await adb.adbShell(this.serial, `pm uninstall ${pkg}`)
            if (!/success/i.test(out)) throw new Error(out.trim())
          } else {
            const out = await adb.adbShell(this.serial, `pm clear ${pkg}`)
            if (!/success/i.test(out)) throw new Error(out.trim())
          }
          report.cleaned.push(pkg)
        } catch (err) {
          report.errors.push(`${pkg}: ${(err as Error).message}`)
        }
      }
    } catch (err) {
      report.errors.push(`package listing: ${(err as Error).message}`)
    }

    for (const dir of MEDIA_DIRS) {
      await adb.adbShell(this.serial, `rm -rf ${dir}/* 2>/dev/null; true`).catch(() => undefined)
    }
    await adb.adbShell(this.serial, 'settings put global http_proxy :0').catch(() => undefined)
    await adb.adbRemoveAllReverse(this.serial)
    await adb.adbLogcatClear(this.serial)
    await this.setClipboard('').catch(() => undefined)

    try {
      const accounts = await adb.listAccounts(this.serial)
      if (accounts.length) {
        report.notes.push(
          `${accounts.length} account(s) remain signed in; accounts cannot be removed without root.`,
        )
      }
    } catch {
      /* optional */
    }
    return report
  }

  destroy(): void {
    this.destroyed = true
    if (this.frameTimer) clearInterval(this.frameTimer)
    this.frameTimer = null
    this.stream?.stop()
    this.stream = null
    this.logcat?.stop()
    this.inputShell.close()
    registry.markAbsent(this.serial)
    this.removeAllListeners()
  }
}

export class AndroidProvider extends ProviderBase {
  readonly name = 'android'
  private timer: NodeJS.Timeout | null = null
  private telemetryTimer: NodeJS.Timeout | null = null
  private running = false
  private adbWarned = false
  private scanning = false

  async start(): Promise<void> {
    if (this.running) return
    this.running = true
    try {
      await adb.adbStartServer()
    } catch (err) {
      console.warn(
        '[android] ADB not available: install platform-tools (npm run setup:tools) or set ADB_PATH.',
        err instanceof Error ? err.message : err,
      )
      this.adbWarned = true
    }
    await this.scan()
    this.timer = setInterval(() => void this.scan(), 3000)
    this.telemetryTimer = setInterval(() => {
      for (const w of this.workers.values()) void w.refreshTelemetry()
    }, 30_000)
    console.log(`[android] provider "${config.providerName}" started (adb: ${config.adbPath})`)
  }

  stop(): void {
    this.running = false
    if (this.timer) clearInterval(this.timer)
    if (this.telemetryTimer) clearInterval(this.telemetryTimer)
    for (const w of this.workers.values()) w.destroy()
    this.workers.clear()
  }

  private allowed(serial: string): boolean {
    const filter = config.serialFilter
    return !filter.length || filter.includes(serial)
  }

  private async scan(): Promise<void> {
    if (this.scanning) return
    this.scanning = true
    try {
      let devices: adb.AdbDeviceLine[]
      try {
        devices = await adb.adbDevices()
        this.adbWarned = false
      } catch (err) {
        if (!this.adbWarned) {
          console.warn('[android] adb devices failed:', err instanceof Error ? err.message : err)
          this.adbWarned = true
        }
        return
      }

      const seen = new Set<string>()
      for (const d of devices) {
        if (!this.allowed(d.serial)) continue
        seen.add(d.serial)
        if (d.state === 'unauthorized') registry.setPresence(d.serial, 'unauthorized', false)
        else if (d.state === 'offline') registry.setPresence(d.serial, 'offline', false)
        else if (d.state === 'device' && !this.workers.has(d.serial)) await this.attach(d.serial)
      }
      for (const serial of [...this.workers.keys()]) {
        if (!seen.has(serial)) this.detach(serial)
      }
    } finally {
      this.scanning = false
    }
  }

  private async attach(serial: string): Promise<void> {
    console.log(`[android] attaching ${serial}`)
    const worker = new AndroidWorker(serial)
    this.register(worker)
    try {
      await worker.prepare()
    } catch (err) {
      console.error(`[android] failed to prepare ${serial}:`, err)
      worker.destroy()
      this.workers.delete(serial)
      registry.setPresence(serial, 'offline', false)
    }
  }

  private detach(serial: string): void {
    console.log(`[android] detaching ${serial}`)
    this.workers.get(serial)?.destroy()
    this.workers.delete(serial)
  }
}
