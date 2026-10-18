import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test, { after, before } from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import WebSocket from 'ws'

const execFileAsync = promisify(execFile)
const here = path.dirname(fileURLToPath(import.meta.url))
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dfz-test-'))

process.env.DEVICEFARMZ_DATA = dataDir
process.env.DEVICEFARMZ_FAKE_DEVICES = '6'
process.env.DEVICEFARMZ_ANDROID = 'false'
process.env.DEVICEFARMZ_RESET_MODE = 'clean'
process.env.DEVICEFARMZ_RELEASE_GRACE_MS = '300'
process.env.DEVICEFARMZ_MOCK_AUTH = 'true'

type Hub = { server: http.Server; port: number }
let hub: Hub
let base: string
let stopHub: (h: Hub) => Promise<void>
let db: typeof import('../src/db.js')

async function call<T = any>(
  method: string,
  p: string,
  opts: { token?: string; body?: unknown; form?: FormData; basic?: string } = {},
): Promise<{ status: number; json: T }> {
  const headers: Record<string, string> = {}
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`
  if (opts.basic) headers.Authorization = 'Basic ' + Buffer.from(`user:${opts.basic}`).toString('base64')
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json'
  const res = await fetch(base + p, {
    method,
    headers,
    body: opts.form ?? (opts.body === undefined ? undefined : JSON.stringify(opts.body)),
  })
  const text = await res.text()
  let json: any = null
  try {
    json = JSON.parse(text)
  } catch {
    json = text
  }
  return { status: res.status, json }
}

async function waitFor<T>(fn: () => T | Promise<T>, ms = 5000, label = 'condition'): Promise<NonNullable<T>> {
  const end = Date.now() + ms
  for (;;) {
    const v = await fn()
    if (v) return v as NonNullable<T>
    if (Date.now() > end) throw new Error(`timed out waiting for ${label}`)
    await new Promise((r) => setTimeout(r, 50))
  }
}

async function login(email: string, name = email.split('@')[0]): Promise<string> {
  const r = await call('POST', '/api/auth/mock', { body: { name, email } })
  assert.equal(r.status, 200)
  return r.json.token
}

const deviceStatus = async (token: string, serial: string) =>
  (await call('GET', `/api/devices/${serial}`, { token })).json.status as string

let adminToken: string
let bobToken: string
let carolToken: string

before(async () => {
  const hubMod = await import('../src/hub.js')
  db = await import('../src/db.js')
  stopHub = hubMod.stopHub
  hub = await hubMod.startHub({ port: 0 })
  base = `http://127.0.0.1:${hub.port}`
  adminToken = await login('administrator@fakedomain.com', 'administrator')
  bobToken = await login('bob@example.com')
  carolToken = await login('carol@example.com')
})

after(async () => {
  await stopHub(hub)
  fs.rmSync(dataDir, { recursive: true, force: true })
})

test('simulated fleet is online and searchable', async () => {
  const { json } = await call('GET', '/api/devices', { token: bobToken })
  assert.equal(json.devices.length, 6)
  assert.ok(json.devices.every((d: any) => d.simulated && d.presence === 'present' && d.status === 'available'))

  const samsung = await call('GET', '/api/devices?q=manufacturer:samsung', { token: bobToken })
  assert.deepEqual(samsung.json.devices.map((d: any) => d.model).sort(), ['Galaxy A14', 'Galaxy S23'])
  assert.equal((await call('GET', '/api/devices')).status, 401)
})

test('assistant: plain-language query and coverage recommendation', async () => {
  const q = await call('POST', '/api/assist/query', {
    token: bobToken,
    body: { text: 'a free samsung phone with android 13 or newer' },
  })
  assert.equal(q.status, 200)
  assert.equal(q.json.source, 'heuristic')
  assert.deepEqual(q.json.devices.map((d: any) => d.model), ['Galaxy S23'])

  const rec = await call('POST', '/api/assist/recommend', { token: bobToken, body: { count: 4, platform: 'android' } })
  assert.equal(rec.json.picks.length, 4)
  assert.equal(new Set(rec.json.picks.map((p: any) => p.serial)).size, 4)
  assert.ok(rec.json.coverage.sdkLevels.picked >= 3)

  const matrix = await call('GET', '/api/assist/matrix', { token: bobToken })
  assert.equal(matrix.json.total, 6)
})

test('claiming, ownership and device operations', async () => {
  const serial = 'SIM0001'
  assert.equal((await call('POST', `/api/devices/${serial}/shell`, { token: bobToken, body: { command: 'echo hi' } })).status, 409)

  assert.equal((await call('POST', `/api/devices/${serial}/use`, { token: bobToken })).status, 200)
  assert.equal((await call('POST', `/api/devices/${serial}/use`, { token: carolToken })).status, 409)
  assert.equal((await call('POST', `/api/devices/${serial}/shell`, { token: carolToken, body: { command: 'echo hi' } })).status, 403)

  const sh = await call('POST', `/api/devices/${serial}/shell`, { token: bobToken, body: { command: 'getprop ro.product.model' } })
  assert.equal(sh.json.output.trim(), 'Pixel 8')

  const form = new FormData()
  form.append('apk', new Blob(['fake apk']), 'checkout-debug.apk')
  const inst = await call('POST', `/api/devices/${serial}/install`, { token: bobToken, form })
  assert.match(inst.json.output, /Success/)
  const pkgs = await call('POST', `/api/devices/${serial}/shell`, { token: bobToken, body: { command: 'pm list packages -3' } })
  assert.match(pkgs.json.output, /com\.sim\.checkoutdebugapk/)
})

test('release wipes user data before the device becomes available again (and fires webhooks)', async () => {
  const received: { event: string; signature: string; raw: string }[] = []
  const sink = http.createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', () => {
      received.push({ event: String(req.headers['x-devicefarmz-event']), signature: String(req.headers['x-devicefarmz-signature']), raw })
      res.end('ok')
    })
  })
  await new Promise<void>((r) => sink.listen(0, '127.0.0.1', r))
  const sinkUrl = `http://127.0.0.1:${(sink.address() as any).port}/hook`

  try {
    assert.equal((await call('POST', '/api/webhooks', { token: bobToken, body: { url: sinkUrl } })).status, 403)
    assert.equal((await call('POST', '/api/webhooks', { token: adminToken, body: { url: 'ftp://x' } })).status, 400)
    const created = await call('POST', '/api/webhooks', {
      token: adminToken,
      body: { url: sinkUrl, events: ['device.reset', 'device.released', 'webhook.test'] },
    })
    assert.equal(created.status, 201)
    const secret: string = created.json.secret

    const serial = 'SIM0001' // still held by bob from the previous test
    const rel = await call('DELETE', `/api/devices/${serial}/owner`, { token: bobToken })
    assert.equal(rel.status, 200)
    assert.equal(rel.json.status, 'cleaning')
    assert.equal((await call('POST', `/api/devices/${serial}/use`, { token: carolToken })).status, 409, 'cannot claim while cleaning')

    await waitFor(async () => (await deviceStatus(bobToken, serial)) === 'available', 4000, 'device to finish cleaning')

    const reset = await waitFor(() => received.find((r) => r.event === 'device.reset'), 3000, 'device.reset webhook')
    const payload = JSON.parse(reset.raw)
    assert.ok(payload.data.cleaned.includes('com.example.demo'))
    assert.ok(payload.data.cleaned.some((p: string) => p.startsWith('com.sim.checkout')))
    assert.equal(reset.signature, 'sha256=' + crypto.createHmac('sha256', secret).update(reset.raw).digest('hex'))
    assert.ok(received.some((r) => r.event === 'device.released'))

    const test = await call('POST', `/api/webhooks/${created.json.webhook.id}/test`, { token: adminToken })
    assert.equal(test.json.ok, true)
    const deliveries = await call('GET', '/api/webhooks/deliveries', { token: adminToken })
    assert.ok(deliveries.json.deliveries.length >= 3)
  } finally {
    sink.close()
  }
})

test('API tokens authenticate and can be revoked', async () => {
  const created = await call('POST', '/api/tokens', { token: bobToken, body: { title: 'ci' } })
  assert.equal(created.status, 201)
  const raw: string = created.json.token
  assert.match(raw, /^dfz_[0-9a-f]{48}$/)

  assert.equal((await call('GET', '/api/auth/me', { token: raw })).json.email, 'bob@example.com')
  const list = await call('GET', '/api/tokens', { token: bobToken })
  assert.equal(list.json.tokens.length, 1)
  assert.ok(list.json.tokens[0].lastUsedAt)
  assert.equal(JSON.stringify(list.json).includes(raw), false, 'raw token is never returned again')

  assert.equal((await call('DELETE', `/api/tokens/${created.json.info.id}`, { token: carolToken })).json.ok, false)
  assert.equal((await call('DELETE', `/api/tokens/${created.json.info.id}`, { token: bobToken })).json.ok, true)
  assert.equal((await call('GET', '/api/auth/me', { token: raw })).status, 401)
})

test('automation leases: acquire, heartbeat, shortage, expiry, release', async () => {
  const acquired = await call('POST', '/api/automation/sessions', {
    token: bobToken,
    body: { query: 'platform:android', count: 2, ttlSec: 60, label: 'unit-test' },
  })
  assert.equal(acquired.status, 201)
  const leases = acquired.json.leases
  assert.equal(leases.length, 2)
  assert.equal(leases[0].capabilities.platformName, 'Android')
  assert.equal(leases[0].capabilities['appium:automationName'], 'UiAutomator2')
  assert.equal(await deviceStatus(bobToken, leases[0].device.serial), 'automation')

  const tooMany = await call('POST', '/api/automation/sessions', { token: carolToken, body: { count: 10 } })
  assert.equal(tooMany.status, 409)
  assert.equal(tooMany.json.matching, 6)

  assert.equal((await call('GET', `/api/automation/sessions/${leases[0].session.id}`, { token: carolToken })).status, 403)
  assert.equal((await call('POST', `/api/automation/sessions/${leases[0].session.id}/heartbeat`, { token: bobToken })).status, 200)

  // force the second lease past its deadline and let the sweeper reclaim it
  const second = db.getAutomationSession(leases[1].session.id)!
  second.expiresAt = new Date(Date.now() - 1000).toISOString()
  db.saveAutomationSession(second)
  await waitFor(
    () => db.getAutomationSession(leases[1].session.id)!.releasedAt,
    9000,
    'expired lease to be reclaimed',
  )
  await waitFor(async () => (await deviceStatus(bobToken, leases[1].device.serial)) === 'available', 4000, 'expired device cleaned')

  const rel = await call('DELETE', `/api/automation/sessions/${leases[0].session.id}`, { token: bobToken })
  assert.ok(rel.json.releasedAt)
  await waitFor(async () => (await deviceStatus(bobToken, leases[0].device.serial)) === 'available', 4000, 'released device cleaned')
})

test('automation: waitSec picks up a device that frees up later', async () => {
  const all = await call('POST', '/api/automation/sessions', { token: bobToken, body: { count: 6 } })
  assert.equal(all.status, 201)
  const waiting = call('POST', '/api/automation/sessions', { token: carolToken, body: { count: 1, waitSec: 8 } })
  setTimeout(() => void call('DELETE', `/api/automation/sessions/${all.json.leases[0].session.id}`, { token: bobToken }), 1200)
  const got = await waiting
  assert.equal(got.status, 201)
  for (const l of [...all.json.leases.slice(1), ...got.json.leases]) {
    await call('DELETE', `/api/automation/sessions/${l.session.id}`, { token: l.session.ownerEmail.startsWith('bob') ? bobToken : carolToken })
  }
  await waitFor(async () => (await call('GET', '/api/devices', { token: adminToken })).json.devices.every((d: any) => d.status === 'available'), 6000, 'fleet to settle')
})

test('Appium gateway reserves a device, injects the UDID and releases on DELETE /session', async () => {
  const seen: { method: string; url: string; body: any }[] = []
  const fakeAppium = http.createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', () => {
      seen.push({ method: req.method!, url: req.url!, body: raw ? JSON.parse(raw) : null })
      res.setHeader('Content-Type', 'application/json')
      if (req.method === 'POST' && req.url === '/session') {
        return res.end(JSON.stringify({ value: { sessionId: 'appium-sid-1', capabilities: {} } }))
      }
      if (req.url === '/session/appium-sid-1/title') return res.end(JSON.stringify({ value: 'Example Domain' }))
      if (req.method === 'DELETE') return res.end(JSON.stringify({ value: null }))
      res.statusCode = 404
      res.end(JSON.stringify({ value: { error: 'unknown command' } }))
    })
  })
  await new Promise<void>((r) => fakeAppium.listen(0, '127.0.0.1', r))
  process.env.DEVICEFARMZ_APPIUM_URL = `http://127.0.0.1:${(fakeAppium.address() as any).port}`

  try {
    const bobApiToken = (await call('POST', '/api/tokens', { token: bobToken, body: { title: 'appium' } })).json.token
    const created = await call('POST', '/appium/session', {
      basic: bobApiToken,
      body: {
        capabilities: {
          alwaysMatch: {
            platformName: 'Android',
            'appium:platformVersion': '13',
            'devicefarmz:query': 'manufacturer:samsung',
            'devicefarmz:ttl': 60,
            'appium:app': '/tmp/app.apk',
          },
        },
      },
    })
    assert.equal(created.status, 200)
    assert.equal(created.json.value.sessionId, 'appium-sid-1')

    const forwarded = seen[0].body.capabilities.alwaysMatch
    assert.equal(forwarded['appium:udid'], 'SIM0002', 'Galaxy S23 is the only Samsung on Android 13')
    assert.equal(forwarded['appium:app'], '/tmp/app.apk')
    assert.ok(!Object.keys(forwarded).some((k) => k.startsWith('devicefarmz:')))
    assert.equal(await deviceStatus(bobToken, 'SIM0002'), 'automation')

    assert.equal((await call('GET', '/appium/session/appium-sid-1/title', { basic: bobApiToken })).json.value, 'Example Domain')
    assert.equal((await call('GET', '/appium/session/nope/title', { basic: bobApiToken })).status, 404)
    assert.equal((await call('POST', '/appium/session', { body: {} })).status, 401)

    assert.equal((await call('DELETE', '/appium/session/appium-sid-1', { basic: bobApiToken })).status, 200)
    await waitFor(async () => (await deviceStatus(bobToken, 'SIM0002')) === 'available', 4000, 'Appium device released')
    const sessions = await call('GET', '/api/automation/sessions', { token: bobToken })
    assert.ok(sessions.json.sessions.some((s: any) => s.appiumSessionId === 'appium-sid-1' && s.releasedAt))
  } finally {
    fakeAppium.close()
  }
})

test('recording captures device logs for the session', async () => {
  const serial = 'SIM0003'
  assert.equal((await call('POST', `/api/devices/${serial}/use`, { token: bobToken })).status, 200)
  assert.equal((await call('POST', '/api/recordings/start', { token: carolToken, body: { serial } })).status, 403)
  const started = await call('POST', '/api/recordings/start', { token: bobToken, body: { serial, note: 'checkout flow' } })
  assert.equal(started.status, 201)
  assert.equal(started.json.hasVideo, false, 'simulated devices have no H.264 stream')
  await new Promise((r) => setTimeout(r, 1300))

  const stopped = await call('POST', '/api/recordings/stop', { token: bobToken, body: { serial } })
  assert.equal(stopped.status, 200)
  assert.equal(stopped.json.status, 'ready')
  assert.ok(stopped.json.logBytes > 100)

  const log = await call('GET', `/api/recordings/${stopped.json.id}/log`, { token: bobToken })
  assert.match(log.json as string, /simulated event #0/)
  assert.equal((await call('GET', `/api/recordings/${stopped.json.id}/log`, { token: carolToken })).status, 403)
  assert.equal((await call('GET', '/api/recordings', { token: carolToken })).json.recordings.length, 0)
  assert.equal((await call('GET', '/api/recordings', { token: bobToken })).json.recordings.length, 1)

  assert.equal((await call('DELETE', `/api/devices/${serial}/owner`, { token: bobToken })).status, 200)
  assert.equal((await call('DELETE', `/api/recordings/${stopped.json.id}`, { token: bobToken })).json.ok, true)
})

test('websocket: stream frames, input, shell, auto-release after disconnect', async () => {
  const serial = 'SIM0004'
  const ws = new WebSocket(`ws://127.0.0.1:${hub.port}/ws`)
  const messages: any[] = []
  ws.on('message', (raw, isBinary) => {
    if (!isBinary) messages.push(JSON.parse(raw.toString()))
  })
  await new Promise((r) => ws.once('open', r))
  const sendMsg = (m: unknown) => ws.send(JSON.stringify(m))

  sendMsg({ type: 'auth', token: 'bogus' })
  await waitFor(() => messages.find((m) => m.type === 'auth.error'), 2000, 'auth.error')
  sendMsg({ type: 'auth', token: bobToken })
  await waitFor(() => messages.find((m) => m.type === 'auth.ok'), 2000, 'auth.ok')

  sendMsg({ type: 'screen.subscribe', serial, prefer: 'h264' })
  const mode = await waitFor(() => messages.find((m) => m.type === 'screen.mode'), 2000, 'screen.mode')
  assert.equal(mode.mode, 'frames', 'falls back to still frames when H.264 is unsupported')
  const frame = await waitFor(() => messages.find((m) => m.type === 'screen.frame'), 3000, 'screen.frame')
  assert.equal(frame.mime, 'image/svg+xml')
  assert.match(Buffer.from(frame.data, 'base64').toString(), /<svg/)

  sendMsg({ type: 'shell.exec', serial, id: 's1', command: 'echo from-ws' })
  await waitFor(() => messages.find((m) => m.type === 'shell.output' && m.chunk.includes('from-ws')), 2000, 'shell output')
  await waitFor(() => messages.find((m) => m.type === 'shell.done' && m.id === 's1'), 2000, 'shell done')

  const before = messages.length
  sendMsg({ type: 'input.touch', serial, contacts: [{ contact: 0, x: 200, y: 400, action: 'down' }] })
  sendMsg({ type: 'input.touch', serial, contacts: [{ contact: 0, x: 200, y: 400, action: 'up' }] })
  sendMsg({ type: 'input.type', serial, text: 'hello' })
  await new Promise((r) => setTimeout(r, 300))
  assert.equal(messages.slice(before).filter((m) => m.type === 'device.error').length, 0)

  const other = new WebSocket(`ws://127.0.0.1:${hub.port}/ws`)
  const otherMsgs: any[] = []
  other.on('message', (raw, isBinary) => !isBinary && otherMsgs.push(JSON.parse(raw.toString())))
  await new Promise((r) => other.once('open', r))
  other.send(JSON.stringify({ type: 'auth', token: carolToken }))
  await waitFor(() => otherMsgs.find((m) => m.type === 'auth.ok'), 2000, 'carol auth')
  other.send(JSON.stringify({ type: 'shell.exec', serial, id: 'x', command: 'echo no' }))
  const denied = await waitFor(() => otherMsgs.find((m) => m.type === 'device.error'), 2000, 'device.error for non-owner')
  assert.match(denied.message, /in use by someone else/)
  other.close()

  ws.close()
  await waitFor(async () => (await deviceStatus(bobToken, serial)) !== 'busy', 3000, 'auto-release after disconnect')
  await waitFor(async () => (await deviceStatus(bobToken, serial)) === 'available', 4000, 'cleaned after disconnect')
})

test('CLI `ci run` reserves a device, exposes DEVICE_UDID and always releases', async () => {
  const tokenValue = (await call('POST', '/api/tokens', { token: bobToken, body: { title: 'cli' } })).json.token
  const cli = path.resolve(here, '../src/cli.ts')
  const { stdout, stderr } = await execFileAsync(
    process.execPath,
    [
      '--import',
      'tsx',
      cli,
      'ci',
      'run',
      '--url',
      base,
      '--token',
      tokenValue,
      '--query',
      'manufacturer:google',
      '--label',
      'cli-test',
      'node',
      '-e',
      'console.log("UDID=" + process.env.DEVICE_UDID)',
    ],
    { timeout: 30_000, env: { ...process.env } },
  )
  assert.match(stdout, /UDID=SIM0001/)
  assert.match(stderr, /reserved SIM0001/)
  const sessions = await call('GET', '/api/automation/sessions', { token: bobToken })
  const mine = sessions.json.sessions.find((s: any) => s.label === 'cli-test')
  assert.ok(mine?.releasedAt, 'lease released after the command exited')
})

test('REST validation and permissions', async () => {
  assert.equal((await call('GET', '/api/users', { token: bobToken })).status, 403)
  assert.equal((await call('GET', '/api/users', { token: adminToken })).status, 200)
  assert.equal((await call('POST', '/api/assist/query', { token: bobToken, body: {} })).status, 400)
  assert.equal((await call('GET', '/api/config')).json.features.simulator, true)
  assert.equal((await call('GET', '/api/auth/providers')).json.mock, true)
  assert.equal((await call('GET', '/api/auth/oidc/login')).status, 404)
  assert.equal((await call('POST', '/api/auth/ldap', { body: { username: 'a', password: 'b' } })).status, 404)
  const metrics = await call('GET', '/api/metrics')
  assert.match(metrics.json as string, /devicefarmz_devices_total 6/)
})
