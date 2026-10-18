import type { FileEntry, Platform, ScreenPreference, TouchContact } from '@devicefarmz/core'
import { config } from './config.js'
import { registry } from './registry.js'
import { BaseWorker, ProviderBase, UnsupportedError, type ResetReport } from './worker-base.js'

interface Spec {
  manufacturer: string
  model: string
  version: string
  sdk: number
  abi: string
  width: number
  height: number
  platform: Platform
}

const SPECS: Spec[] = [
  { manufacturer: 'Google', model: 'Pixel 8', version: '14', sdk: 34, abi: 'arm64-v8a', width: 1080, height: 2400, platform: 'android' },
  { manufacturer: 'Samsung', model: 'Galaxy S23', version: '13', sdk: 33, abi: 'arm64-v8a', width: 1080, height: 2340, platform: 'android' },
  { manufacturer: 'Xiaomi', model: 'Redmi Note 12', version: '13', sdk: 33, abi: 'arm64-v8a', width: 1080, height: 2400, platform: 'android' },
  { manufacturer: 'OnePlus', model: 'OnePlus 9', version: '11', sdk: 30, abi: 'arm64-v8a', width: 1080, height: 2400, platform: 'android' },
  { manufacturer: 'Motorola', model: 'Moto G Power', version: '10', sdk: 29, abi: 'arm64-v8a', width: 720, height: 1600, platform: 'android' },
  { manufacturer: 'Samsung', model: 'Galaxy A14', version: '12', sdk: 31, abi: 'arm64-v8a', width: 720, height: 1600, platform: 'android' },
  { manufacturer: 'Nokia', model: 'Nokia G20', version: '11', sdk: 30, abi: 'armeabi-v7a', width: 720, height: 1600, platform: 'android' },
  { manufacturer: 'Apple', model: 'iPhone 14', version: '17.0', sdk: 0, abi: 'arm64', width: 1170, height: 2532, platform: 'ios' },
]

const APPS = ['Settings', 'Browser', 'Camera', 'Messages', 'Maps', 'Clock', 'Gallery', 'Files', 'Store', 'Phone', 'Mail', 'Notes']

function hue(serial: string): number {
  let h = 0
  for (const c of serial) h = (h * 31 + c.charCodeAt(0)) % 360
  return h
}

function esc(s: string): string {
  return s.replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c]!)
}

export class SimulatedWorker extends BaseWorker {
  readonly platform: Platform
  private readonly spec: Spec
  private frameTimer: NodeJS.Timeout | null = null
  private logTimer: NodeJS.Timeout | null = null
  private frameSubs = 0
  private screenOn = true
  private currentApp = 'Launcher'
  private typed = ''
  private taps: { x: number; y: number; at: number }[] = []
  private packages = ['com.example.demo', 'com.acme.checkout']
  private downloads = ['report.pdf', 'logo.png']
  private identifyUntil = 0
  private bootingUntil = 0
  private battery = 70 + Math.floor(Math.random() * 28)
  private touch: { x: number; y: number } | null = null
  private proxy = ':0'
  private clipboard = ''
  private logCounter = 0

  constructor(serial: string, spec: Spec) {
    super(serial)
    this.spec = spec
    this.platform = spec.platform
  }

  async prepare(): Promise<void> {
    const s = this.spec
    registry.upsert({
      serial: this.serial,
      platform: s.platform,
      simulated: true,
      model: s.model,
      marketName: s.model,
      manufacturer: s.manufacturer,
      version: s.version,
      sdk: s.sdk,
      product: s.model.toLowerCase().replace(/\s+/g, '_'),
      abi: s.abi,
      phone: { phoneNumber: null, imei: null, imsi: null, iccid: null, network: 'SimNet' },
      battery: { level: this.battery, health: 'good', source: 'usb', status: 'charging', temp: 29.5, voltage: 4100 },
      display: { id: 0, width: s.width, height: s.height, xdpi: 420, ydpi: 420, fps: 60, density: 420, rotation: 0, secure: false },
      provider: 'simulator',
      channel: `sim-${this.serial}`,
      presence: 'present',
      ready: true,
      status: registry.get(this.serial)?.status === 'cleaning' ? 'cleaning' : 'available',
    })
  }

  override async refreshTelemetry(): Promise<void> {
    this.battery = Math.max(5, this.battery - 1)
    registry.upsert({
      serial: this.serial,
      battery: { level: this.battery, health: 'good', source: 'usb', status: 'charging', temp: 29.5, voltage: 4100 },
    })
  }

  // ---------- screen ----------

  async subscribeScreen(_prefer: ScreenPreference, fps = 3): Promise<ScreenPreference> {
    this.frameSubs += 1
    if (!this.frameTimer) {
      const tick = () =>
        this.emit('screen.frame', {
          serial: this.serial,
          data: Buffer.from(this.renderSvg(), 'utf8').toString('base64'),
          mime: 'image/svg+xml',
          width: this.spec.width,
          height: this.spec.height,
          rotation: 0,
        })
      tick()
      this.frameTimer = setInterval(tick, Math.max(150, Math.floor(1000 / Math.max(1, fps))))
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

  private renderSvg(): string {
    const { width: w, height: h, model, manufacturer, version, platform } = this.spec
    const u = w / 360
    const hh = hue(this.serial)
    const now = Date.now()
    this.taps = this.taps.filter((t) => now - t.at < 1500)
    const booting = now < this.bootingUntil
    const clock = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

    const icons: string[] = []
    if (this.currentApp === 'Launcher' && this.screenOn && !booting) {
      APPS.forEach((name, i) => {
        const col = i % 3
        const row = Math.floor(i / 3)
        const cx = w * (0.2 + col * 0.3)
        const cy = h * (0.3 + row * 0.12)
        icons.push(
          `<rect x="${cx - 36 * u}" y="${cy - 36 * u}" width="${72 * u}" height="${72 * u}" rx="${18 * u}" fill="hsl(${(hh + i * 28) % 360} 60% 55%)"/>` +
            `<text x="${cx}" y="${cy + 58 * u}" font-size="${13 * u}" fill="#fff" text-anchor="middle">${name}</text>`,
        )
      })
    }

    const body =
      booting
        ? `<text x="${w / 2}" y="${h / 2}" font-size="${24 * u}" fill="#fff" text-anchor="middle">Rebooting…</text>`
        : this.currentApp === 'Launcher'
          ? icons.join('')
          : `<rect x="0" y="${70 * u}" width="${w}" height="${h - 150 * u}" fill="rgba(255,255,255,0.92)"/>` +
            `<text x="${24 * u}" y="${120 * u}" font-size="${26 * u}" fill="#123" font-weight="700">${esc(this.currentApp)}</text>` +
            `<rect x="${24 * u}" y="${150 * u}" width="${w - 48 * u}" height="${44 * u}" rx="${8 * u}" fill="#e6edf2" stroke="#9ab"/>` +
            `<text x="${36 * u}" y="${180 * u}" font-size="${18 * u}" fill="#123">${esc(this.typed.slice(-28))}▍</text>`

    const ripples = this.taps
      .map((t) => {
        const age = (now - t.at) / 1500
        return `<circle cx="${t.x}" cy="${t.y}" r="${(14 + age * 50) * u}" fill="none" stroke="rgba(255,255,255,${1 - age})" stroke-width="${4 * u}"/>`
      })
      .join('')

    const flash = now < this.identifyUntil
    const dim = this.screenOn ? '' : `<rect width="${w}" height="${h}" fill="#000"/>`
    const identify = flash
      ? `<rect width="${w}" height="${h}" fill="rgba(255,0,0,0.85)"/><text x="${w / 2}" y="${h / 2}" font-size="${34 * u}" fill="#fff" text-anchor="middle" font-weight="700">${esc(this.serial)}</text>`
      : ''

    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" font-family="sans-serif">
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${hh} 55% 28%)"/><stop offset="1" stop-color="hsl(${(hh + 60) % 360} 60% 14%)"/></linearGradient></defs>
<rect width="${w}" height="${h}" fill="url(#g)"/>
<text x="${24 * u}" y="${40 * u}" font-size="${16 * u}" fill="#fff">${clock}</text>
<text x="${w - 24 * u}" y="${40 * u}" font-size="${16 * u}" fill="#fff" text-anchor="end">${this.battery}%</text>
<text x="${w / 2}" y="${h * 0.12}" font-size="${22 * u}" fill="rgba(255,255,255,.85)" text-anchor="middle">${esc(manufacturer)} ${esc(model)}</text>
<text x="${w / 2}" y="${h * 0.12 + 28 * u}" font-size="${14 * u}" fill="rgba(255,255,255,.55)" text-anchor="middle">${platform === 'ios' ? 'iOS' : 'Android'} ${esc(version)} · simulated</text>
${body}
<rect x="${w * 0.35}" y="${h - 22 * u}" width="${w * 0.3}" height="${5 * u}" rx="${3 * u}" fill="rgba(255,255,255,.7)"/>
${ripples}${dim}${identify}
</svg>`
  }

  // ---------- logs ----------

  protected override startLogs(): void {
    this.logTimer = setInterval(() => {
      const tags = ['ActivityManager', 'WifiService', 'SurfaceFlinger', 'chatty']
      const line = `10-18 12:00:${String(this.logCounter % 60).padStart(2, '0')}.000 I/${tags[this.logCounter % tags.length]}( ${1000 + (this.logCounter % 50)}): simulated event #${this.logCounter} app=${this.currentApp}`
      this.logCounter += 1
      this.emit('log.line', { serial: this.serial, line })
    }, 400)
  }

  protected override stopLogs(): void {
    if (this.logTimer) clearInterval(this.logTimer)
    this.logTimer = null
  }

  // ---------- input ----------

  override async handleTouches(contacts: TouchContact[]): Promise<void> {
    for (const c of contacts) {
      if (c.action === 'down') this.touch = { x: c.x, y: c.y }
      if (c.action === 'up' && this.touch) {
        this.taps.push({ x: c.x, y: c.y, at: Date.now() })
        if (Math.hypot(c.x - this.touch.x, c.y - this.touch.y) < 20) this.tapAt(c.x, c.y)
        this.touch = null
      }
    }
  }

  private tapAt(x: number, y: number): void {
    if (!this.screenOn || this.currentApp !== 'Launcher') return
    const { width: w, height: h } = this.spec
    APPS.forEach((name, i) => {
      const cx = w * (0.2 + (i % 3) * 0.3)
      const cy = h * (0.3 + Math.floor(i / 3) * 0.12)
      if (Math.abs(x - cx) < 45 * (w / 360) && Math.abs(y - cy) < 45 * (w / 360)) this.currentApp = name
    })
  }

  override async typeText(text: string): Promise<void> {
    if (this.currentApp !== 'Launcher') this.typed += text
  }

  override async key(code: number): Promise<void> {
    if (code === 67) this.typed = this.typed.slice(0, -1)
  }

  override async nav(kind: 'home' | 'back' | 'recent' | 'power'): Promise<void> {
    if (kind === 'home' || kind === 'back') this.currentApp = 'Launcher'
    if (kind === 'recent') this.currentApp = 'Recents'
    if (kind === 'power') this.screenOn = !this.screenOn
  }

  // ---------- tools ----------

  override async shell(command: string, onChunk: (chunk: string) => void): Promise<number> {
    if (this.platform === 'ios') throw new UnsupportedError('Shell', 'ios')
    const cmd = command.trim()
    const [bin, ...rest] = cmd.split(/\s+/)
    const arg = rest.join(' ')
    const props: Record<string, string> = {
      'ro.product.model': this.spec.model,
      'ro.product.manufacturer': this.spec.manufacturer,
      'ro.build.version.release': this.spec.version,
      'ro.build.version.sdk': String(this.spec.sdk),
      'ro.build.display.id': `SIM.${this.spec.sdk}.${this.serial}`,
    }
    switch (bin) {
      case 'getprop':
        onChunk((props[arg] ?? '') + '\n')
        return 0
      case 'echo':
        onChunk(arg + '\n')
        return 0
      case 'date':
        onChunk(new Date().toString() + '\n')
        return 0
      case 'uname':
        onChunk('Linux localhost 5.15.0-sim #1 SMP aarch64\n')
        return 0
      case 'pm':
        if (arg.startsWith('list packages')) {
          onChunk(this.packages.map((p) => `package:${p}`).join('\n') + '\n')
          return 0
        }
        break
      case 'ls':
        onChunk(this.downloads.join('\n') + '\n')
        return 0
      case 'settings':
        if (arg.startsWith('get global http_proxy')) {
          onChunk(this.proxy + '\n')
          return 0
        }
        if (arg.startsWith('put global http_proxy')) {
          this.proxy = arg.split(/\s+/).pop() ?? ':0'
          return 0
        }
        break
    }
    onChunk(`/system/bin/sh: ${bin}: inaccessible or not found\n`)
    return 127
  }

  override async installApp(path: string, originalName?: string): Promise<string> {
    const name = originalName ?? path.split(/[\\/]/).pop() ?? 'app'
    const pkg = `com.sim.${name.replace(/\W+/g, '').toLowerCase().slice(0, 20) || 'app'}`
    if (!this.packages.includes(pkg)) this.packages.push(pkg)
    return `Performing Streamed Install\nSuccess (${pkg})`
  }

  override async openBrowser(url: string): Promise<void> {
    this.currentApp = `Browser · ${url.slice(0, 40)}`
  }

  override async listFiles(path: string): Promise<FileEntry[]> {
    if (this.platform === 'ios') throw new UnsupportedError('File explorer', 'ios')
    const base = path.replace(/\/$/, '')
    if (base === '/sdcard' || base === '') {
      return ['Download', 'DCIM', 'Documents'].map((n) => ({
        name: n,
        path: `/sdcard/${n}`,
        mode: 'drwxrwx---',
        size: 4096,
        mtime: '2026-10-18 10:00',
        isDir: true,
      }))
    }
    if (base === '/sdcard/Download') {
      return this.downloads.map((n) => ({
        name: n,
        path: `${base}/${n}`,
        mode: '-rw-rw----',
        size: 20480,
        mtime: '2026-10-18 10:05',
        isDir: false,
      }))
    }
    return []
  }

  override async identify(): Promise<void> {
    this.identifyUntil = Date.now() + 3500
  }

  override async reboot(): Promise<void> {
    this.bootingUntil = Date.now() + 3000
    this.currentApp = 'Launcher'
  }

  override async reverse(): Promise<void> {}
  override async unreverse(): Promise<void> {}
  override async getClipboard(): Promise<string> {
    return this.clipboard
  }
  override async setClipboard(text: string): Promise<void> {
    this.clipboard = text
  }

  async reset(mode: 'clean' | 'uninstall'): Promise<ResetReport> {
    const keep = new Set(config.resetKeepPackages)
    const targets = this.packages.filter((p) => !keep.has(p))
    if (mode === 'uninstall') this.packages = this.packages.filter((p) => keep.has(p))
    this.downloads = []
    this.typed = ''
    this.taps = []
    this.currentApp = 'Launcher'
    this.clipboard = ''
    this.proxy = ':0'
    await new Promise((r) => setTimeout(r, 150))
    return {
      cleaned: targets,
      errors: [],
      notes: this.platform === 'ios' ? ['iOS apps are terminated, not uninstalled'] : [],
    }
  }

  destroy(): void {
    if (this.frameTimer) clearInterval(this.frameTimer)
    if (this.logTimer) clearInterval(this.logTimer)
    registry.markAbsent(this.serial)
    this.removeAllListeners()
  }
}

export class SimulatedProvider extends ProviderBase {
  readonly name = 'simulator'
  private telemetry: NodeJS.Timeout | null = null

  constructor(private readonly count: number) {
    super()
  }

  async start(): Promise<void> {
    for (let i = 0; i < this.count; i++) {
      const serial = `SIM${String(i + 1).padStart(4, '0')}`
      const worker = new SimulatedWorker(serial, SPECS[i % SPECS.length])
      this.register(worker)
      await worker.prepare()
    }
    this.telemetry = setInterval(() => {
      for (const w of this.workers.values()) void w.refreshTelemetry()
    }, 60_000)
    console.log(`[simulator] ${this.count} virtual device(s) online`)
  }

  stop(): void {
    if (this.telemetry) clearInterval(this.telemetry)
    for (const w of this.workers.values()) w.destroy()
    this.workers.clear()
  }
}
