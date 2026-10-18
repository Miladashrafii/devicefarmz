/**
 * Stand-ins for the iOS side: a WebDriverAgent HTTP server and the libimobiledevice command-line tools.
 */
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { PNG_1X1 } from './fake-adb.js'

export interface WdaRequest {
  method: string
  path: string
  body: any
}

export class FakeWda {
  requests: WdaRequest[] = []
  activeBundle = 'com.acme.ios'
  private server: http.Server
  url = ''

  constructor() {
    this.server = http.createServer((req, res) => {
      let raw = ''
      req.on('data', (c) => (raw += c))
      req.on('end', () => {
        let body: any = undefined
        try {
          body = raw ? JSON.parse(raw) : undefined
        } catch {
          /* not json */
        }
        const path = req.url ?? '/'
        this.requests.push({ method: req.method ?? 'GET', path, body })
        const reply = (value: unknown, status = 200) => {
          res.writeHead(status, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ value }))
        }
        if (path === '/status') return reply({ ready: true })
        if (path === '/session' && req.method === 'POST') return reply({ sessionId: 'S1', capabilities: {} })
        if (path === '/session/S1/window/size') return reply({ width: 390, height: 844 })
        if (path === '/screenshot') return reply(PNG_1X1.toString('base64'))
        if (path === '/wda/activeAppInfo') return reply({ bundleId: this.activeBundle })
        if (path.startsWith('/session/S1/') || path === '/wda/homescreen' || path === '/wda/lock') return reply(null)
        reply({ error: 'unknown command' }, 404)
      })
    })
  }

  start(): Promise<void> {
    return new Promise((resolve) =>
      this.server.listen(0, '127.0.0.1', () => {
        this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`
        resolve()
      }),
    )
  }

  stop(): Promise<void> {
    return new Promise((resolve) => this.server.close(() => resolve()))
  }

  find(method: string, path: string): WdaRequest[] {
    return this.requests.filter((r) => r.method === method && r.path === path)
  }
}

/** Fake `idevice_id`, `ideviceinfo` and `ideviceinstaller` */
export class FakeIosTools {
  calls: { bin: string; args: string[] }[] = []
  installed = ['com.acme.ios', 'com.acme.notes']
  udids = ['IOS000000001']

  readonly run = async (bin: string, args: string[]): Promise<string> => {
    this.calls.push({ bin, args })
    const name = bin.replace(/\\/g, '/').split('/').pop() ?? bin
    if (name.includes('idevice_id')) return this.udids.join('\n') + '\n'
    if (name.includes('ideviceinfo')) {
      if (args.includes('com.apple.mobile.battery')) return 'BatteryCurrentCapacity: 64\nBatteryIsCharging: true\n'
      return [
        'DeviceName: Lab iPhone',
        'ProductType: iPhone14,2',
        'ProductVersion: 17.4',
        'HardwareModel: D63AP',
        'CPUArchitecture: arm64',
        'InternationalMobileEquipmentIdentity: 356938035643809',
      ].join('\n')
    }
    if (name.includes('ideviceinstaller')) {
      if (args.includes('-i')) return 'Install: Complete\n'
      if (args.includes('-l')) return 'CFBundleIdentifier, CFBundleVersion, CFBundleDisplayName\n' + this.installed.map((b) => `${b}, "1.0", "App"`).join('\n') + '\n'
      if (args.includes('-U')) {
        const bundle = args[args.indexOf('-U') + 1]
        this.installed = this.installed.filter((b) => b !== bundle)
        return 'Uninstall: Complete\n'
      }
    }
    throw new Error(`fake tool: unsupported ${bin} ${args.join(' ')}`)
  }
}
