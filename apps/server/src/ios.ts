/**
 * iOS support (experimental).
 *
 * Detection and metadata use libimobiledevice (`idevice_id`, `ideviceinfo`, `ideviceinstaller`).
 * Screen and input go through a WebDriverAgent instance running on the device; it is reached
 * either through an explicit URL (DEVICEFARMZ_WDA_URLS) or through `iproxy` port forwarding.
 * WebDriverAgent itself must already be installed and started on the device.
 */
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { promisify } from 'node:util'
import type { ScreenPreference, TouchContact } from '@devicefarmz/core'
import { config } from './config.js'
import { registry } from './registry.js'
import { BaseWorker, ProviderBase, UnsupportedError, type ResetReport } from './worker-base.js'

const execFileAsync = promisify(execFile)

async function run(bin: string, args: string[], timeoutMs = 20_000): Promise<string> {
  const { stdout } = await execFileAsync(bin, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 16 * 1024 * 1024 })
  return stdout.toString()
}

type ToolRunner = (bin: string, args: string[], timeoutMs?: number) => Promise<string>
let tool: ToolRunner = run

/** Seam for tests: replaces the libimobiledevice command-line tools with an in-process fake */
export function setIosToolRunner(next: ToolRunner | null): void {
  tool = next ?? run
}

class WdaClient {
  private sessionId: string | null = null

  constructor(private readonly base: string) {}

  private async call<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.base}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    })
    const json = (await res.json().catch(() => ({}))) as { value?: T }
    if (!res.ok) throw new Error(`WDA ${method} ${path} -> ${res.status}`)
    return json.value as T
  }

  async session(): Promise<string> {
    if (this.sessionId) return this.sessionId
    const value = await this.call<{ sessionId?: string }>('POST', '/session', {
      capabilities: { alwaysMatch: {} },
    })
    const id = (value as { sessionId?: string })?.sessionId
    if (!id) throw new Error('WDA did not return a session id')
    this.sessionId = id
    return id
  }

  async status(): Promise<boolean> {
    try {
      await this.call('GET', '/status')
      return true
    } catch {
      return false
    }
  }

  async screenshot(): Promise<string> {
    return this.call<string>('GET', '/screenshot')
  }

  async windowSize(): Promise<{ width: number; height: number }> {
    const id = await this.session()
    return this.call('GET', `/session/${id}/window/size`)
  }

  async tap(x: number, y: number): Promise<void> {
    const id = await this.session()
    await this.call('POST', `/session/${id}/wda/tap/0`, { x, y })
  }

  async drag(x1: number, y1: number, x2: number, y2: number, duration: number): Promise<void> {
    const id = await this.session()
    await this.call('POST', `/session/${id}/wda/dragfromtoforduration`, {
      fromX: x1,
      fromY: y1,
      toX: x2,
      toY: y2,
      duration,
    })
  }

  async keys(text: string): Promise<void> {
    const id = await this.session()
    await this.call('POST', `/session/${id}/wda/keys`, { value: [...text] })
  }

  async home(): Promise<void> {
    await this.call('POST', '/wda/homescreen')
  }

  async lock(): Promise<void> {
    await this.call('POST', '/wda/lock')
  }

  async openUrl(url: string): Promise<void> {
    const id = await this.session()
    await this.call('POST', `/session/${id}/url`, { url })
  }

  async terminateActive(): Promise<void> {
    const id = await this.session()
    const info = await this.call<{ bundleId?: string }>('GET', '/wda/activeAppInfo')
    if (info?.bundleId && info.bundleId !== 'com.apple.springboard') {
      await this.call('POST', `/session/${id}/wda/apps/terminate`, { bundleId: info.bundleId })
    }
  }
}

function parseInfo(raw: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of raw.split(/\r?\n/)) {
    const i = line.indexOf(':')
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim()
  }
  return out
}

export class IosWorker extends BaseWorker {
  readonly platform = 'ios' as const
  private wda: WdaClient | null = null
  private iproxy: ChildProcess | null = null
  private frameTimer: NodeJS.Timeout | null = null
  private frameSubs = 0
  private capturing = false
  private size = { width: 390, height: 844 }
  private touch: { x: number; y: number; at: number } | null = null

  constructor(
    serial: string,
    private readonly localPort: number,
  ) {
    super(serial)
  }

  async prepare(): Promise<void> {
    const info = parseInfo(await tool(config.ios.ideviceInfo, ['-u', this.serial]))
    const explicit = config.ios.wdaUrls[this.serial]
    let url = explicit
    if (!url) {
      this.iproxy = spawn(config.ios.iproxy, [`${this.localPort}:8100`, '-u', this.serial], { windowsHide: true })
      this.iproxy.on('error', () => undefined)
      this.iproxy.stdout?.on('data', () => undefined)
      this.iproxy.stderr?.on('data', () => undefined)
      url = `http://127.0.0.1:${this.localPort}`
    }
    this.wda = new WdaClient(url)

    let wdaReady = false
    for (let i = 0; i < 10 && !wdaReady; i++) {
      wdaReady = await this.wda.status()
      if (!wdaReady) await new Promise((r) => setTimeout(r, 500))
    }
    if (wdaReady) {
      try {
        this.size = await this.wda.windowSize()
      } catch {
        /* keep defaults */
      }
    }

    const battery = await tool(config.ios.ideviceInfo, ['-u', this.serial, '-q', 'com.apple.mobile.battery'])
      .then(parseInfo)
      .catch(() => ({}) as Record<string, string>)

    registry.upsert({
      serial: this.serial,
      platform: 'ios',
      model: info.ProductType || 'iPhone',
      marketName: info.DeviceName || info.ProductType || 'iPhone',
      manufacturer: 'Apple',
      version: info.ProductVersion || '',
      sdk: 0,
      product: info.HardwareModel ?? null,
      abi: info.CPUArchitecture ?? null,
      phone: {
        phoneNumber: info.PhoneNumber ?? null,
        imei: info.InternationalMobileEquipmentIdentity ?? null,
        imsi: null,
        iccid: info.IntegratedCircuitCardIdentity ?? null,
        network: null,
      },
      battery: battery.BatteryCurrentCapacity
        ? { level: Number(battery.BatteryCurrentCapacity), health: 'unknown', source: 'usb', status: battery.BatteryIsCharging === 'true' ? 'charging' : 'discharging', temp: 0, voltage: 0 }
        : null,
      display: { id: 0, width: this.size.width, height: this.size.height, xdpi: 0, ydpi: 0, fps: 60, density: 0, rotation: 0, secure: false },
      provider: config.providerName,
      channel: `ios-${this.serial}`,
      presence: 'present',
      ready: wdaReady,
      status: wdaReady ? 'available' : 'preparing',
      notes: wdaReady ? '' : 'WebDriverAgent is not reachable; start it on the device to enable control.',
      lastSeenAt: new Date().toISOString(),
    })
  }

  private requireWda(): WdaClient {
    if (!this.wda) throw new Error('WebDriverAgent is not connected')
    return this.wda
  }

  async subscribeScreen(_prefer: ScreenPreference, fps = 2): Promise<ScreenPreference> {
    this.frameSubs += 1
    if (!this.frameTimer) {
      const tick = async () => {
        if (this.capturing || this.frameSubs <= 0) return
        this.capturing = true
        try {
          const data = await this.requireWda().screenshot()
          this.emit('screen.frame', {
            serial: this.serial,
            data,
            mime: 'image/png',
            width: this.size.width,
            height: this.size.height,
            rotation: 0,
          })
        } catch {
          /* WDA busy */
        } finally {
          this.capturing = false
        }
      }
      void tick()
      this.frameTimer = setInterval(() => void tick(), Math.max(300, Math.floor(1000 / Math.max(1, fps))))
    }
    return 'frames'
  }

  unsubscribeScreen(_mode: ScreenPreference): void {
    this.frameSubs = Math.max(0, this.frameSubs - 1)
    if (this.frameSubs === 0 && this.frameTimer) {
      clearInterval(this.frameTimer)
      this.frameTimer = null
    }
  }

  override async handleTouches(contacts: TouchContact[]): Promise<void> {
    const wda = this.requireWda()
    for (const c of contacts) {
      if (c.action === 'down') this.touch = { x: c.x, y: c.y, at: Date.now() }
      else if (c.action === 'up' && this.touch) {
        const moved = Math.hypot(c.x - this.touch.x, c.y - this.touch.y)
        if (moved > 10) await wda.drag(this.touch.x, this.touch.y, c.x, c.y, Math.max(0.1, (Date.now() - this.touch.at) / 1000))
        else await wda.tap(c.x, c.y)
        this.touch = null
      }
    }
  }

  override async typeText(text: string): Promise<void> {
    await this.requireWda().keys(text)
  }

  override async nav(kind: 'home' | 'back' | 'recent' | 'power'): Promise<void> {
    if (kind === 'home') return this.requireWda().home()
    if (kind === 'power') return this.requireWda().lock()
    throw new UnsupportedError(kind === 'back' ? 'Back key' : 'Recents key', 'ios')
  }

  override async openBrowser(url: string): Promise<void> {
    await this.requireWda().openUrl(url)
  }

  override async installApp(path: string): Promise<string> {
    return tool(config.ios.ideviceInstaller, ['-u', this.serial, '-i', path], 180_000)
  }

  async reset(mode: 'clean' | 'uninstall'): Promise<ResetReport> {
    const report: ResetReport = { cleaned: [], errors: [], notes: [] }
    try {
      await this.wda?.terminateActive()
      await this.wda?.home()
    } catch (err) {
      report.errors.push((err as Error).message)
    }
    if (mode === 'uninstall') {
      try {
        const listing = await tool(config.ios.ideviceInstaller, ['-u', this.serial, '-l', '-o', 'list_user'])
        const bundles = listing
          .split(/\r?\n/)
          .map((l) => l.match(/^"?([A-Za-z0-9.\-_]+)"?\s*,/)?.[1])
          .filter((b): b is string => Boolean(b) && b !== 'CFBundleIdentifier')
        for (const b of bundles) {
          try {
            await tool(config.ios.ideviceInstaller, ['-u', this.serial, '-U', b], 60_000)
            report.cleaned.push(b)
          } catch (err) {
            report.errors.push(`${b}: ${(err as Error).message}`)
          }
        }
      } catch (err) {
        report.errors.push(`app listing: ${(err as Error).message}`)
      }
    } else {
      report.notes.push('iOS app data cannot be cleared remotely; active app was terminated. Use uninstall mode for a full wipe.')
    }
    return report
  }

  destroy(): void {
    if (this.frameTimer) clearInterval(this.frameTimer)
    this.iproxy?.kill()
    registry.markAbsent(this.serial)
    this.removeAllListeners()
  }
}

export class IosProvider extends ProviderBase {
  readonly name = 'ios'
  private timer: NodeJS.Timeout | null = null
  private ports = new Map<string, number>()
  private warned = false
  private scanning = false

  async start(): Promise<void> {
    await this.scan()
    this.timer = setInterval(() => void this.scan(), 5000)
    console.log('[ios] provider started (experimental)')
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    for (const w of this.workers.values()) w.destroy()
    this.workers.clear()
  }

  private portFor(udid: string): number {
    if (!this.ports.has(udid)) this.ports.set(udid, config.ios.wdaBasePort + this.ports.size)
    return this.ports.get(udid)!
  }

  private async scan(): Promise<void> {
    if (this.scanning) return
    this.scanning = true
    try {
      let udids: string[] = []
      try {
        udids = (await tool(config.ios.ideviceId, ['-l'])).split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
        this.warned = false
      } catch (err) {
        if (!this.warned) {
          console.warn('[ios] idevice_id failed (install libimobiledevice):', (err as Error).message)
          this.warned = true
        }
        return
      }
      for (const udid of udids) {
        if (this.workers.has(udid)) continue
        const worker = new IosWorker(udid, this.portFor(udid))
        this.register(worker)
        try {
          await worker.prepare()
        } catch (err) {
          console.warn(`[ios] failed to prepare ${udid}:`, (err as Error).message)
          worker.destroy()
          this.workers.delete(udid)
        }
      }
      for (const udid of [...this.workers.keys()]) {
        if (!udids.includes(udid)) {
          this.workers.get(udid)?.destroy()
          this.workers.delete(udid)
        }
      }
    } finally {
      this.scanning = false
    }
  }
}
