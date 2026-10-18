/**
 * An in-process stand-in for the `adb` executable. It behaves like one or more Android phones:
 * property and telemetry queries, package management, an input shell, logcat, screenshots and a
 * scrcpy-style video server that streams raw H.264 NAL units over a forwarded TCP port.
 */
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { EventEmitter } from 'node:events'
import net from 'node:net'
import { PassThrough, Writable } from 'node:stream'
import type { AdbBackend } from '../../src/adb.js'

export const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
)

class FakeChild extends EventEmitter {
  stdout = new PassThrough()
  stderr = new PassThrough()
  stdin: Writable
  killed = false
  exitCode: number | null = null

  constructor(onStdinLine?: (line: string) => void) {
    super()
    let buffer = ''
    this.stdin = new Writable({
      write: (chunk, _enc, cb) => {
        buffer += chunk.toString()
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''
        for (const line of lines) onStdinLine?.(line)
        cb()
      },
    })
  }

  finish(code: number): void {
    if (this.exitCode !== null) return
    this.exitCode = code
    this.stdout.end()
    this.stderr.end()
    this.emit('exit', code, null)
    this.emit('close', code, null)
  }

  kill(): boolean {
    this.killed = true
    this.finish(143)
    return true
  }
}

export interface FakeAndroidSpec {
  serial: string
  model: string
  manufacturer: string
  release: string
  sdk: number
  battery: number
  width: number
  height: number
  packages?: string[]
  state?: 'device' | 'unauthorized' | 'offline'
}

export class FakeAndroid {
  state: 'device' | 'unauthorized' | 'offline'
  packages = new Map<string, { dataCleared: boolean }>()
  /** Every line written to the persistent input shell */
  inputLog: string[] = []
  /** Every `adb shell <command>` that was run (one-shot commands) */
  commandLog: string[] = []
  installs: string[] = []
  reversesRemoved = 0

  constructor(readonly spec: FakeAndroidSpec) {
    this.state = spec.state ?? 'device'
    for (const p of spec.packages ?? []) this.packages.set(p, { dataCleared: false })
  }

  private props(): Record<string, string> {
    return {
      'ro.product.model': this.spec.model,
      'ro.product.manufacturer': this.spec.manufacturer,
      'ro.build.version.release': this.spec.release,
      'ro.build.version.sdk': String(this.spec.sdk),
      'ro.product.name': this.spec.model.toLowerCase().replace(/\s+/g, '_'),
      'ro.product.cpu.abi': 'arm64-v8a',
      'ro.product.marketname': this.spec.model,
      'gsm.operator.alpha': 'FakeCell',
    }
  }

  shell(command: string): string {
    this.commandLog.push(command)
    let m: RegExpMatchArray | null
    if ((m = command.match(/^getprop (\S+)/))) return (this.props()[m[1]] ?? '') + '\n'
    if (command === 'dumpsys battery') {
      return [
        'Current Battery Service state:',
        '  AC powered: false',
        '  USB powered: true',
        '  status: 2',
        '  health: 2',
        `  level: ${this.spec.battery}`,
        '  voltage: 4100',
        '  temperature: 281',
      ].join('\n')
    }
    if (command === 'wm size') return `Physical size: ${this.spec.width}x${this.spec.height}\n`
    if (command === 'wm density') return 'Physical density: 420\n'
    if (command.startsWith('dumpsys window displays')) return '  mCurrentRotation=ROTATION_0\n'
    if (command.startsWith('service call iphonesubinfo')) return "Result: Parcel(00000000 '........')\n"
    if (command === 'pm list packages -3') return [...this.packages.keys()].map((p) => `package:${p}`).join('\n') + '\n'
    if ((m = command.match(/^am force-stop (\S+)/))) return ''
    if ((m = command.match(/^pm clear (\S+)/))) {
      const pkg = this.packages.get(m[1])
      if (!pkg) return 'Failed\n'
      pkg.dataCleared = true
      return 'Success\n'
    }
    if ((m = command.match(/^pm uninstall (\S+)/))) return this.packages.delete(m[1]) ? 'Success\n' : 'Failure [DELETE_FAILED_INTERNAL_ERROR]\n'
    if ((m = command.match(/^echo (.*)$/))) return m[1] + '\n'
    if (command.startsWith('dumpsys account')) return 'Accounts: 0\n'
    return ''
  }
}

export class FakeAdb implements AdbBackend {
  devices = new Map<string, FakeAndroid>()
  pushes: { serial: string; local: string; remote: string }[] = []
  /** argv of every scrcpy-style video server that was started */
  videoServers: string[][] = []
  videoClients = 0
  /** Artificial latency for one-shot shell commands, to observe in-between states */
  shellDelayMs = 0
  private forwards = new Map<string, net.Server>()
  private children = new Set<FakeChild>()

  add(spec: FakeAndroidSpec): FakeAndroid {
    const d = new FakeAndroid(spec)
    this.devices.set(spec.serial, d)
    return d
  }

  unplug(serial: string): void {
    this.devices.delete(serial)
  }

  async close(): Promise<void> {
    for (const c of this.children) c.kill()
    await Promise.all([...this.forwards.values()].map((s) => new Promise((r) => s.close(r))))
    this.forwards.clear()
  }

  private split(args: string[]): { serial?: string; rest: string[] } {
    if (args[0] === '-s') return { serial: args[1], rest: args.slice(2) }
    return { rest: args }
  }

  private device(serial: string | undefined): FakeAndroid {
    const d = serial ? this.devices.get(serial) : undefined
    if (!d) throw Object.assign(new Error(`device '${serial}' not found`), { stderr: `error: device '${serial}' not found` })
    return d
  }

  async exec(args: string[]): Promise<{ stdout: string | Buffer; stderr: string | Buffer }> {
    const { serial, rest } = this.split(args)
    const out = (stdout: string) => ({ stdout, stderr: '' })
    switch (rest[0]) {
      case 'start-server':
      case 'version':
        return out('Android Debug Bridge version 1.0.41 (fake)\n')
      case 'devices':
        return out(
          'List of devices attached\n' + [...this.devices.values()].map((d) => `${d.spec.serial}\t${d.state}`).join('\n') + '\n',
        )
      case 'shell':
        if (this.shellDelayMs) await new Promise((r) => setTimeout(r, this.shellDelayMs))
        return out(this.device(serial).shell(rest[1] ?? ''))
      case 'push':
        this.device(serial)
        this.pushes.push({ serial: serial!, local: rest[1], remote: rest[2] })
        return out('1 file pushed\n')
      case 'install': {
        const d = this.device(serial)
        const file = rest[rest.length - 1].split(/[\\/]/).pop() ?? 'app.apk'
        const pkg = `com.fake.${file.replace(/\W+/g, '').toLowerCase().slice(0, 18)}`
        d.packages.set(pkg, { dataCleared: false })
        d.installs.push(pkg)
        return out('Performing Streamed Install\nSuccess\n')
      }
      case 'forward':
        if (rest[1] === '--remove') {
          const s = this.forwards.get(rest[2])
          this.forwards.delete(rest[2])
          s?.close()
          return out('')
        }
        this.device(serial)
        return out(`${await this.startVideoServer()}\n`)
      case 'reverse':
        if (rest[1] === '--remove' || rest[1] === '--remove-all') this.device(serial).reversesRemoved += 1
        return out('')
      case 'reboot':
      case 'pull':
        return out('')
      default:
        throw new Error(`fake adb: unsupported command ${rest.join(' ')}`)
    }
  }

  spawn(args: string[]): ChildProcessWithoutNullStreams {
    const { serial, rest } = this.split(args)
    const dev = this.device(serial)

    let child: FakeChild
    if (rest[0] === 'exec-out' && rest[1] === 'screencap') {
      child = new FakeChild()
      setImmediate(() => {
        child.stdout.write(PNG_1X1)
        child.finish(0)
      })
    } else if (rest[0] === 'logcat') {
      child = new FakeChild()
      let n = 0
      const timer = setInterval(() => {
        n += 1
        child.stdout.write(`10-18 12:00:${String(n % 60).padStart(2, '0')}.000 I/FakeTag( 100): hello ${n}\n`)
      }, 40)
      child.once('exit', () => clearInterval(timer))
    } else if (rest[0] === 'shell' && rest.length === 1) {
      child = new FakeChild((line) => dev.inputLog.push(line))
    } else if (rest[0] === 'shell' && rest.some((a) => a === 'app_process')) {
      this.videoServers.push(rest)
      child = new FakeChild() // the video server just keeps running until it is killed
    } else {
      throw new Error(`fake adb: unsupported spawn ${rest.join(' ')}`)
    }
    this.children.add(child)
    child.once('exit', () => this.children.delete(child))
    return child as unknown as ChildProcessWithoutNullStreams
  }

  /** Streams SPS, PPS, an IDR frame (split across writes) and then P frames, like a scrcpy raw stream */
  private startVideoServer(): Promise<number> {
    const sps = Buffer.from([0, 0, 0, 1, 0x67, 0x42, 0xc0, 0x1f, 0xda, 0x05, 0x07, 0xe8, 0x40])
    const pps = Buffer.from([0, 0, 0, 1, 0x68, 0xce, 0x3c, 0x80])
    const idr = Buffer.from([0, 0, 0, 1, 0x65, 0x88, 0x84, 0x21, 0xa0, 0xff, 0xee, 0xdd, 0xcc, 0xbb])
    const server = net.createServer((sock) => {
      this.videoClients += 1
      sock.on('error', () => undefined)
      sock.write(Buffer.concat([sps, pps]))
      setTimeout(() => sock.write(idr.subarray(0, 7)), 15)
      setTimeout(() => sock.write(idr.subarray(7)), 30)
      let seq = 0
      const timer = setInterval(() => {
        seq += 1
        sock.write(Buffer.from([0, 0, 0, 1, 0x41, 0x9a, seq & 0xff, 0xaa, 0xbb]))
      }, 30)
      sock.on('close', () => clearInterval(timer))
    })
    return new Promise((resolve) =>
      server.listen(0, '127.0.0.1', () => {
        const port = (server.address() as net.AddressInfo).port
        this.forwards.set(`tcp:${port}`, server)
        resolve(port)
      }),
    )
  }
}
