import { spawn, execFile, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { promisify } from 'node:util'
import { config } from './config.js'

const execFileAsync = promisify(execFile)

export interface AdbDeviceLine {
  serial: string
  state: 'device' | 'offline' | 'unauthorized' | 'connecting' | string
}

/**
 * Seam for tests: lets an in-process implementation stand in for the adb executable,
 * so device behaviour (including the video stream) can be simulated without hardware.
 */
export interface AdbBackend {
  exec(args: string[], opts: { timeoutMs: number }): Promise<{ stdout: string | Buffer; stderr: string | Buffer }>
  spawn(args: string[]): ChildProcessWithoutNullStreams
}

let backend: AdbBackend | null = null

export function setAdbBackend(next: AdbBackend | null): void {
  backend = next
}

/** Starts a long-running adb process (shell, logcat, screen capture, video server) */
export function adbSpawn(args: string[]): ChildProcessWithoutNullStreams {
  return backend ? backend.spawn(args) : spawn(config.adbPath, args, { windowsHide: true })
}

export async function runAdb(
  args: string[],
  opts?: { timeoutMs?: number; serial?: string },
): Promise<string> {
  const full = opts?.serial ? ['-s', opts.serial, ...args] : args
  try {
    const { stdout, stderr } = backend
      ? await backend.exec(full, { timeoutMs: opts?.timeoutMs ?? 30_000 })
      : await execFileAsync(config.adbPath, full, {
          timeout: opts?.timeoutMs ?? 30_000,
          maxBuffer: 32 * 1024 * 1024,
          windowsHide: true,
        })
    return (stdout || stderr || '').toString()
  } catch (err) {
    const e = err as { stdout?: Buffer | string; stderr?: Buffer | string; message?: string }
    const msg = (e.stderr?.toString() || e.stdout?.toString() || e.message || 'adb failed').trim()
    throw new Error(msg)
  }
}

export async function adbStartServer(): Promise<void> {
  await runAdb(['start-server'])
}

export async function adbDevices(): Promise<AdbDeviceLine[]> {
  const out = await runAdb(['devices'])
  return out
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('List of') && !line.startsWith('*'))
    .map((line) => {
      const [serial, state] = line.split(/\s+/)
      return { serial, state }
    })
    .filter((d) => d.serial && d.state)
}

export async function adbShell(serial: string, command: string, timeoutMs = 20_000): Promise<string> {
  return runAdb(['shell', command], { serial, timeoutMs })
}

export async function adbGetProp(serial: string, prop: string): Promise<string> {
  return (await adbShell(serial, `getprop ${prop}`)).trim()
}

export async function adbScreencap(serial: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = adbSpawn(['-s', serial, 'exec-out', 'screencap', '-p'])
    const chunks: Buffer[] = []
    child.stdout.on('data', (c: Buffer) => chunks.push(c))
    child.stderr.on('data', () => undefined)
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve(Buffer.concat(chunks))
      else reject(new Error(`screencap exit ${code}`))
    })
  })
}

/**
 * Long-lived `adb shell` used for input events. Writing commands to its stdin avoids
 * paying the adb client start-up cost for every tap/swipe.
 */
export class PersistentShell {
  private child: ChildProcessWithoutNullStreams | null = null

  constructor(private readonly serial: string) {}

  private ensure(): ChildProcessWithoutNullStreams {
    if (this.child && !this.child.killed && this.child.exitCode === null) return this.child
    const child = adbSpawn(['-s', this.serial, 'shell'])
    child.stdout.on('data', () => undefined)
    child.stderr.on('data', () => undefined)
    child.on('error', () => {
      if (this.child === child) this.child = null
    })
    child.on('exit', () => {
      if (this.child === child) this.child = null
    })
    this.child = child
    return child
  }

  run(command: string): void {
    this.ensure().stdin.write(command + '\n')
  }

  close(): void {
    this.child?.kill()
    this.child = null
  }
}

export async function adbInstall(serial: string, apkPath: string): Promise<string> {
  return runAdb(['install', '-r', '-t', apkPath], { serial, timeoutMs: 180_000 })
}

export async function adbPush(serial: string, local: string, remote: string): Promise<string> {
  return runAdb(['push', local, remote], { serial, timeoutMs: 120_000 })
}

export async function adbPull(serial: string, remote: string, local: string): Promise<string> {
  return runAdb(['pull', remote, local], { serial, timeoutMs: 120_000 })
}

export async function adbReboot(serial: string): Promise<void> {
  await runAdb(['reboot'], { serial, timeoutMs: 10_000 }).catch(() => undefined)
}

export async function adbForward(serial: string, localSpec: string, remoteSpec: string): Promise<string> {
  return runAdb(['forward', localSpec, remoteSpec], { serial })
}

export async function adbRemoveForward(serial: string, localSpec: string): Promise<void> {
  await runAdb(['forward', '--remove', localSpec], { serial }).catch(() => undefined)
}

export async function adbReverse(serial: string, deviceSpec: string, localSpec: string): Promise<void> {
  await runAdb(['reverse', deviceSpec, localSpec], { serial })
}

export async function adbRemoveReverse(serial: string, deviceSpec: string): Promise<void> {
  await runAdb(['reverse', '--remove', deviceSpec], { serial }).catch(() => undefined)
}

export async function adbRemoveAllReverse(serial: string): Promise<void> {
  await runAdb(['reverse', '--remove-all'], { serial }).catch(() => undefined)
}

export async function adbLogcatClear(serial: string): Promise<void> {
  await adbShell(serial, 'logcat -c').catch(() => undefined)
}

export function adbLogcatStream(serial: string, onLine: (line: string) => void): { stop: () => void } {
  const child = adbSpawn(['-s', serial, 'logcat', '-v', 'time'])
  let buffer = ''
  child.stdout.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8')
    const lines = buffer.split(/\r?\n/)
    buffer = lines.pop() ?? ''
    for (const line of lines) if (line) onLine(line)
  })
  child.stderr.on('data', () => undefined)
  child.on('error', () => undefined)
  return { stop: () => child.kill() }
}

export async function parseBattery(serial: string) {
  const raw = await adbShell(serial, 'dumpsys battery')
  const get = (key: string) => raw.match(new RegExp(`${key}\\s*:\\s*(.+)`, 'i'))?.[1]?.trim()
  const healthCodes: Record<string, string> = {
    '2': 'good',
    '3': 'overheat',
    '4': 'dead',
    '5': 'over_voltage',
    '6': 'failure',
    '7': 'cold',
  }
  const statusCodes: Record<string, string> = {
    '2': 'charging',
    '3': 'discharging',
    '4': 'not_charging',
    '5': 'full',
  }
  const health = get('health') ?? 'unknown'
  const status = get('status') ?? 'unknown'
  return {
    level: Number(get('level') ?? 0),
    health: healthCodes[health] ?? health,
    source: get('AC powered') === 'true' ? 'ac' : get('USB powered') === 'true' ? 'usb' : 'battery',
    status: statusCodes[status] ?? status,
    temp: Number(get('temperature') ?? 0) / 10,
    voltage: Number(get('voltage') ?? 0),
  }
}

export async function parseDisplay(serial: string) {
  const [size, density] = await Promise.all([adbShell(serial, 'wm size'), adbShell(serial, 'wm density')])
  const sizeMatch = size.match(/(?:Override size|Physical size):\s*(\d+)x(\d+)/g)?.pop()?.match(/(\d+)x(\d+)/)
  const densMatch = density.match(/(\d+)/)
  const dens = Number(densMatch?.[1] ?? 420)
  let rotation = 0
  try {
    const rot = await adbShell(serial, 'dumpsys window displays | grep -m1 mCurrentRotation')
    const m = rot.match(/mCurrentRotation=ROTATION_(\d+)|mCurrentRotation=(\d)/)
    rotation = Number(m?.[1] ?? m?.[2] ?? 0) / (m?.[1] ? 90 : 1)
  } catch {
    rotation = 0
  }
  return {
    id: 0,
    width: Number(sizeMatch?.[1] ?? 1080),
    height: Number(sizeMatch?.[2] ?? 1920),
    xdpi: dens,
    ydpi: dens,
    fps: 60,
    density: dens,
    rotation,
    secure: false,
  }
}

export async function listBrowsers(serial: string): Promise<{ packageName: string; label: string }[]> {
  const out = await adbShell(
    serial,
    `cmd package query-activities --brief -a android.intent.action.VIEW -d http://example.com 2>/dev/null || pm query-activities -a android.intent.action.VIEW -d http://example.com`,
  )
  const pkgs = new Set<string>()
  for (const m of out.matchAll(/([\w.]+)\/[\w.$]+/g)) pkgs.add(m[1])
  return [...pkgs].map((packageName) => ({
    packageName,
    label: packageName.split('.').pop() || packageName,
  }))
}

function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

export async function openUrl(serial: string, url: string, packageName?: string): Promise<void> {
  if (!/^[a-z][a-z0-9+.-]*:/i.test(url)) throw new Error('URL must include a scheme, e.g. https://')
  const pkg = packageName && /^[\w.]+$/.test(packageName) ? ` ${packageName}` : ''
  await adbShell(serial, `am start -a android.intent.action.VIEW -d ${shQuote(url)}${pkg}`)
}

export async function listAccounts(serial: string) {
  const out = await adbShell(serial, 'dumpsys account')
  const accounts: { name: string; type: string }[] = []
  for (const m of out.matchAll(/Account\s*\{name=([^,]+),\s*type=([^}]+)\}/g)) {
    accounts.push({ name: m[1].trim(), type: m[2].trim() })
  }
  return accounts
}

export async function listThirdPartyPackages(serial: string): Promise<string[]> {
  const out = await adbShell(serial, 'pm list packages -3')
  return out
    .split(/\r?\n/)
    .map((l) => l.trim().replace(/^package:/, ''))
    .filter((p) => /^[\w.]+$/.test(p))
}

export async function listRemoteDir(serial: string, remotePath: string) {
  const out = await adbShell(serial, `ls -la ${shQuote(remotePath)}`)
  const entries = []
  for (const line of out.split(/\r?\n/)) {
    const m = line.match(/^([dl\-rwxst]+)\s+\d+\s+\S+\s+\S+\s+(\d+)\s+(\S+\s+\S+(?:\s+\S+)?)\s+(.+)$/)
    if (!m) continue
    const name = m[4].replace(/ -> .*$/, '')
    if (name === '.' || name === '..') continue
    entries.push({
      name,
      path: remotePath.replace(/\/$/, '') + '/' + name,
      mode: m[1],
      size: Number(m[2]),
      mtime: m[3],
      isDir: m[1].startsWith('d') || m[1].startsWith('l'),
    })
  }
  return entries
}

/** Wakes the screen, pulses brightness and opens "About phone" so a person can find the device on a shelf */
export async function showIdentifyOverlay(serial: string): Promise<void> {
  const original =
    (await adbShell(serial, 'settings get system screen_brightness').catch(() => '128')).trim() || '128'
  await adbShell(serial, 'input keyevent 224')
  await adbShell(serial, 'am start -a android.settings.DEVICE_INFO_SETTINGS').catch(() => undefined)
  for (let i = 0; i < 6; i++) {
    await adbShell(serial, `settings put system screen_brightness ${i % 2 === 0 ? 255 : 5}`).catch(
      () => undefined,
    )
    await new Promise((r) => setTimeout(r, 350))
  }
  await adbShell(serial, `settings put system screen_brightness ${/^\d+$/.test(original) ? original : 128}`).catch(
    () => undefined,
  )
  await adbShell(serial, 'cmd vibrator vibrate 600 2>/dev/null || true').catch(() => undefined)
}

export const KEY = {
  HOME: 3,
  BACK: 4,
  MENU: 82,
  POWER: 26,
  APP_SWITCH: 187,
} as const
