#!/usr/bin/env node
import fs from 'node:fs'
import { spawn } from 'node:child_process'
import { Command } from 'commander'
import { APP_NAME, APP_VERSION, type AutomationLease } from '@devicefarmz/core'
import path from 'node:path'
import { config, repoRoot } from './config.js'

// Optional .env file (working directory first, then the repository root); real environment variables win
for (const dir of [process.cwd(), repoRoot]) {
  const file = path.join(dir, '.env')
  if (fs.existsSync(file) && typeof process.loadEnvFile === 'function') {
    process.loadEnvFile(file)
    break
  }
}

const program = new Command()
program.name('devicefarmz').description(APP_NAME).version(APP_VERSION)

program
  .command('local')
  .description('Run the hub, device providers and (optionally) simulated devices')
  .option('-p, --port <port>', 'hub port', String(config.hubPort))
  .option('--public-ip <ip>', 'public IP advertised to clients', config.publicIp)
  .option('--fake <count>', 'add simulated devices (no hardware needed)', '0')
  .argument('[serials...]', 'optional device serial whitelist')
  .action(async (serials: string[], opts: { port: string; publicIp: string; fake: string }) => {
    if (serials?.length) process.env.DEVICEFARMZ_SERIALS = serials.join(',')
    if (Number(opts.fake) > 0) process.env.DEVICEFARMZ_FAKE_DEVICES = opts.fake
    process.env.DEVICEFARMZ_PUBLIC_IP = opts.publicIp
    const { startHub, stopHub } = await import('./hub.js')
    let handle
    try {
      handle = await startHub({ port: Number(opts.port), publicIp: opts.publicIp })
    } catch (err) {
      console.error(`[hub] ${(err as Error).message}`)
      process.exit(1)
    }
    const shutdown = () => void stopHub(handle).finally(() => process.exit(0))
    process.on('SIGINT', shutdown)
    process.on('SIGTERM', shutdown)
  })

program
  .command('migrate')
  .description('Initialize the database and built-in objects')
  .action(async () => {
    const { initDb, closeDb } = await import('./db.js')
    initDb()
    closeDb()
    console.log('Database ready at', config.dataDir)
  })

program
  .command('doctor')
  .description('Check the environment (Node, ADB, video server, ffmpeg)')
  .action(async () => {
    const { scrcpyAvailable } = await import('./config.js')
    console.log('Node            ', process.version)
    console.log('Data dir        ', config.dataDir)
    console.log('adb             ', config.adbPath)
    console.log('H.264 video jar ', scrcpyAvailable() ? config.scrcpy.jar : 'missing (npm run setup:tools)')
    try {
      const { adbStartServer, adbDevices, runAdb } = await import('./adb.js')
      console.log('adb version     ', (await runAdb(['version'])).split('\n')[0])
      await adbStartServer()
      const devices = await adbDevices()
      console.log('Android devices ', devices.length ? JSON.stringify(devices) : '(none attached)')
    } catch (err) {
      console.error('ADB problem     ', err instanceof Error ? err.message : err)
      process.exitCode = 1
    }
  })

// ------------------------------------------------------------------ CI helpers

interface CiOptions {
  url: string
  token: string
  query?: string
  platform?: string
  count: string
  ttl: string
  wait: string
  label?: string
}

async function api<T>(base: string, token: string, method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(base.replace(/\/$/, '') + '/api' + path, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const json = (await res.json().catch(() => ({}))) as { error?: string }
  if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`)
  return json as T
}

async function acquireLeases(o: CiOptions): Promise<AutomationLease[]> {
  const { leases } = await api<{ leases: AutomationLease[] }>(o.url, o.token, 'POST', '/automation/sessions', {
    query: o.query,
    platform: o.platform,
    count: Number(o.count),
    ttlSec: Number(o.ttl),
    waitSec: Number(o.wait),
    label: o.label ?? process.env.GITHUB_RUN_ID ?? process.env.CI_JOB_ID ?? 'ci',
  })
  return leases
}

function addCiOptions(cmd: Command): Command {
  return cmd
    .requiredOption('--url <url>', 'hub URL', process.env.DEVICEFARMZ_URL)
    .requiredOption('--token <token>', 'API token (dfz_...)', process.env.DEVICEFARMZ_TOKEN)
    .option('--query <q>', 'device query, e.g. "samsung android>=12"')
    .option('--platform <p>', 'android | ios')
    .option('--count <n>', 'number of devices', '1')
    .option('--ttl <seconds>', 'lease length', '1800')
    .option('--wait <seconds>', 'wait for devices to become free', '0')
    .option('--label <text>', 'label shown in the UI')
}

const ci = program.command('ci').description('Reserve devices from CI pipelines')

addCiOptions(ci.command('acquire').description('Reserve devices and print the leases as JSON')).action(
  async (o: CiOptions) => {
    const leases = await acquireLeases(o)
    const sessions = leases.map((l) => l.session.id)
    const serials = leases.map((l) => l.device.serial)
    console.log(JSON.stringify({ sessions, serials, leases }, null, 2))
    if (process.env.GITHUB_OUTPUT) {
      fs.appendFileSync(
        process.env.GITHUB_OUTPUT,
        `sessions=${sessions.join(',')}\nserials=${serials.join(',')}\nudid=${serials[0]}\n`,
      )
    }
  },
)

ci.command('release')
  .description('Release leases obtained with `ci acquire`')
  .requiredOption('--url <url>', 'hub URL', process.env.DEVICEFARMZ_URL)
  .requiredOption('--token <token>', 'API token', process.env.DEVICEFARMZ_TOKEN)
  .argument('<sessions...>', 'session ids (comma or space separated)')
  .action(async (sessions: string[], o: { url: string; token: string }) => {
    for (const id of sessions.flatMap((s) => s.split(',')).filter(Boolean)) {
      await api(o.url, o.token, 'DELETE', `/automation/sessions/${id}`)
      console.log('released', id)
    }
  })

addCiOptions(
  ci
    .command('run')
    .description('Reserve devices, run a command with DEVICE_UDID set, then always release them')
    .allowUnknownOption(),
)
  .argument('<command...>', 'command to run (put it after --)')
  .action(async (command: string[], o: CiOptions) => {
    const leases = await acquireLeases(o)
    const serials = leases.map((l) => l.device.serial)
    console.error(`[ci] reserved ${serials.join(', ')}`)

    const beat = setInterval(
      () => {
        for (const l of leases) {
          void api(o.url, o.token, 'POST', `/automation/sessions/${l.session.id}/heartbeat`).catch(() => undefined)
        }
      },
      Math.max(10, Number(o.ttl) / 3) * 1000,
    )

    const code = await new Promise<number>((resolve) => {
      // On Windows, `npm`, `gradlew.bat` & co. need a shell, so quote every argument ourselves
      const winQuote = (a: string) => (/[\s"&|<>^()%!]/.test(a) || a === '' ? `"${a.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1')}"` : a)
      const win = process.platform === 'win32'
      const child = spawn(win ? command.map(winQuote).join(' ') : command[0], win ? [] : command.slice(1), {
        stdio: 'inherit',
        shell: win,
        env: {
          ...process.env,
          DEVICE_UDID: serials[0],
          DEVICE_UDIDS: serials.join(','),
          ANDROID_SERIAL: leases[0].device.platform === 'android' ? serials[0] : process.env.ANDROID_SERIAL,
        },
      })
      child.on('exit', (c) => resolve(c ?? 1))
      child.on('error', () => resolve(127))
    })

    clearInterval(beat)
    for (const l of leases) {
      await api(o.url, o.token, 'DELETE', `/automation/sessions/${l.session.id}`).catch(() => undefined)
    }
    process.exit(code)
  })

program.parseAsync().catch((err) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
