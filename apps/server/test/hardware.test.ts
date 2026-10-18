/**
 * Device-level behaviour against protocol mocks, with no hardware:
 *  - Android: an in-process `adb` (properties, packages, input shell, logcat, screenshots and a
 *    scrcpy-style raw H.264 video server)
 *  - iOS: a WebDriverAgent HTTP server plus fake libimobiledevice tools
 * These tests prove our code speaks the protocols correctly; they cannot prove that a given phone
 * or WebDriverAgent build behaves the same way.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test, { after, before } from 'node:test'
import WebSocket from 'ws'
import { FakeAdb, type FakeAndroid } from './support/fake-adb.js'
import { FakeIosTools, FakeWda } from './support/fake-ios.js'

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dfz-hw-'))
const videoJar = path.join(dataDir, 'scrcpy-server.jar')
fs.writeFileSync(videoJar, 'not a real jar')

process.env.DEVICEFARMZ_DATA = dataDir
process.env.DEVICEFARMZ_ANDROID = 'true'
process.env.DEVICEFARMZ_IOS = 'true'
process.env.DEVICEFARMZ_FAKE_DEVICES = '0'
process.env.DEVICEFARMZ_RESET_MODE = 'clean'
process.env.DEVICEFARMZ_RELEASE_GRACE_MS = '300'
process.env.DEVICEFARMZ_MOCK_AUTH = 'true'
process.env.SCRCPY_SERVER_JAR = videoJar
process.env.FFMPEG_PATH = 'ffmpeg-is-not-installed-for-this-test'

const adbFake = new FakeAdb()
const pixel: FakeAndroid = adbFake.add({
  serial: 'FAKE0001',
  model: 'Pixel 7',
  manufacturer: 'Google',
  release: '14',
  sdk: 34,
  battery: 87,
  width: 1080,
  height: 2400,
  packages: ['com.acme.shop', 'com.acme.mail'],
})
adbFake.add({ serial: 'UNAUTH01', model: 'x', manufacturer: 'x', release: '1', sdk: 1, battery: 1, width: 1, height: 1, state: 'unauthorized' })
const wda = new FakeWda()
const iosTools = new FakeIosTools()

type Hub = { server: http.Server; port: number }
let hub: Hub
let base: string
let stopHub: (h: Hub) => Promise<void>

async function call<T = any>(
  method: string,
  p: string,
  opts: { token?: string; body?: unknown; form?: FormData } = {},
): Promise<{ status: number; json: T; raw: Response }> {
  const headers: Record<string, string> = {}
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json'
  const raw = await fetch(base + p, {
    method,
    headers,
    body: opts.form ?? (opts.body === undefined ? undefined : JSON.stringify(opts.body)),
  })
  const text = await raw.clone().text()
  let json: any
  try {
    json = JSON.parse(text)
  } catch {
    json = text
  }
  return { status: raw.status, json, raw }
}

async function waitFor<T>(fn: () => T | Promise<T>, ms = 5000, label = 'condition'): Promise<NonNullable<T>> {
  const end = Date.now() + ms
  for (;;) {
    const v = await fn()
    if (v) return v as NonNullable<T>
    if (Date.now() > end) throw new Error(`timed out waiting for ${label}`)
    await new Promise((r) => setTimeout(r, 40))
  }
}

class Client {
  json: any[] = []
  bins: { serial: string; kind: number; nal: Buffer }[] = []
  private constructor(readonly ws: WebSocket) {
    ws.on('message', (raw: Buffer, isBinary: boolean) => {
      if (!isBinary) return void this.json.push(JSON.parse(raw.toString()))
      const serialLen = raw[1]
      this.bins.push({ kind: raw[0], serial: raw.subarray(2, 2 + serialLen).toString(), nal: raw.subarray(2 + serialLen) })
    })
  }
  static async open(token: string): Promise<Client> {
    const ws = new WebSocket(`ws://127.0.0.1:${hub.port}/ws`)
    const c = new Client(ws)
    await new Promise((r) => ws.once('open', r))
    c.send({ type: 'auth', token })
    await c.wait((m) => m.type === 'auth.ok', 'auth.ok')
    return c
  }
  send(m: unknown) {
    this.ws.send(JSON.stringify(m))
  }
  wait(pred: (m: any) => boolean, label: string, ms = 4000) {
    return waitFor(() => this.json.find(pred), ms, label)
  }
  close() {
    this.ws.close()
  }
}

const nalType = (n: Buffer) => n[4] & 0x1f
const status = async (token: string, serial: string) => (await call('GET', `/api/devices/${serial}`, { token })).json

let bob: string
let carol: string

before(async () => {
  await wda.start()
  process.env.DEVICEFARMZ_WDA_URLS = `IOS000000001=${wda.url}`
  const adbMod = await import('../src/adb.js')
  adbMod.setAdbBackend(adbFake)
  const iosMod = await import('../src/ios.js')
  iosMod.setIosToolRunner(iosTools.run)
  const hubMod = await import('../src/hub.js')
  stopHub = hubMod.stopHub
  hub = await hubMod.startHub({ port: 0 })
  base = `http://127.0.0.1:${hub.port}`
  const login = async (email: string) =>
    (await call('POST', '/api/auth/mock', { body: { name: email.split('@')[0], email } })).json.token as string
  bob = await login('bob@example.com')
  carol = await login('carol@example.com')
})

after(async () => {
  await stopHub(hub)
  await adbFake.close()
  await wda.stop()
  fs.rmSync(dataDir, { recursive: true, force: true })
})

// ------------------------------------------------------------------ discovery

test('devices from adb and libimobiledevice are discovered with their metadata', async () => {
  const { json } = await call('GET', '/api/devices', { token: bob })
  const byId = Object.fromEntries(json.devices.map((d: any) => [d.serial, d]))

  const px = byId.FAKE0001
  assert.equal(px.platform, 'android')
  assert.equal(px.model, 'Pixel 7')
  assert.equal(px.manufacturer, 'Google')
  assert.equal(px.version, '14')
  assert.equal(px.sdk, 34)
  assert.equal(px.battery.level, 87)
  assert.equal(px.battery.source, 'usb')
  assert.deepEqual([px.display.width, px.display.height], [1080, 2400])
  assert.equal(px.status, 'available')
  assert.equal(px.simulated, false)

  const ios = byId.IOS000000001
  assert.equal(ios.platform, 'ios')
  assert.equal(ios.manufacturer, 'Apple')
  assert.equal(ios.model, 'iPhone14,2')
  assert.equal(ios.version, '17.4')
  assert.equal(ios.marketName, 'Lab iPhone')
  assert.equal(ios.battery.level, 64)
  assert.equal(ios.status, 'available', 'WebDriverAgent answered, so the device is controllable')

  assert.equal(byId.UNAUTH01?.status, 'unauthorized', 'a phone that has not accepted the RSA prompt is shown as unauthorized')
  assert.deepEqual((await call('GET', '/api/devices?q=platform:ios', { token: bob })).json.devices.map((d: any) => d.serial), ['IOS000000001'])
})

// ------------------------------------------------------------------ Android: H.264

let bobWs: Client

test('H.264: the hub starts the video server, relays NAL units and frames them for the browser', async () => {
  bobWs = await Client.open(bob)
  bobWs.send({ type: 'screen.subscribe', serial: 'FAKE0001', prefer: 'h264', fps: 6 })
  const mode = await bobWs.wait((m) => m.type === 'screen.mode', 'screen.mode')
  assert.equal(mode.mode, 'h264')

  await waitFor(() => bobWs.bins.length >= 7, 4000, 'video NAL units')
  assert.ok(bobWs.bins.every((b) => b.kind === 1 && b.serial === 'FAKE0001'), 'binary frames carry kind 1 and the serial')
  assert.ok(bobWs.bins.every((b) => b.nal.subarray(0, 4).equals(Buffer.from([0, 0, 0, 1]))), 'every NAL has a 4-byte start code')
  assert.deepEqual(bobWs.bins.slice(0, 3).map((b) => nalType(b.nal)), [7, 8, 5], 'stream starts with SPS, PPS, then an IDR frame')
  assert.ok(bobWs.bins.slice(3).every((b) => nalType(b.nal) === 1), 'followed by P frames')
  assert.deepEqual(bobWs.bins[2].nal, Buffer.from([0, 0, 0, 1, 0x65, 0x88, 0x84, 0x21, 0xa0, 0xff, 0xee, 0xdd, 0xcc, 0xbb]), 'a NAL split across TCP chunks is reassembled intact')

  const seqs = bobWs.bins.slice(3).map((b) => b.nal[6])
  assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b), 'frames arrive in order')

  const push = adbFake.pushes.find((p) => p.serial === 'FAKE0001')
  assert.equal(push?.local, videoJar)
  assert.equal(push?.remote, '/data/local/tmp/devicefarmz-video.jar')
  const argv = adbFake.videoServers[0].join(' ')
  for (const arg of ['CLASSPATH=/data/local/tmp/devicefarmz-video.jar', 'app_process', 'com.genymobile.scrcpy.Server', '3.1', 'raw_stream=true', 'tunnel_forward=true', 'video=true', 'audio=false', 'control=false']) {
    assert.ok(argv.includes(arg), `video server was started with ${arg}`)
  }
})

test('H.264: a late joiner gets a fresh key frame first', async () => {
  const second = await Client.open(bob)
  second.send({ type: 'screen.subscribe', serial: 'FAKE0001', prefer: 'h264' })
  await second.wait((m) => m.type === 'screen.mode' && m.mode === 'h264', 'screen.mode')
  await waitFor(() => second.bins.length >= 3, 4000, 'late-joiner NAL units')
  assert.deepEqual(second.bins.slice(0, 3).map((b) => nalType(b.nal)), [7, 8, 5])
  assert.ok(adbFake.videoServers.length >= 2, 'the encoder was restarted to produce a key frame')
  second.send({ type: 'screen.unsubscribe', serial: 'FAKE0001' })
  second.close()
})

test('recording keeps the raw H.264 stream when ffmpeg is unavailable', async () => {
  bobWs.send({ type: 'record.start', serial: 'FAKE0001', note: 'hw' })
  await bobWs.wait((m) => m.type === 'record.state' && m.recording === true && m.id, 'record.state on')
  await new Promise((r) => setTimeout(r, 400))
  bobWs.send({ type: 'record.stop', serial: 'FAKE0001' })
  const rec = await waitFor(
    async () => (await call('GET', '/api/recordings', { token: bob })).json.recordings.find((r: any) => r.serial === 'FAKE0001' && r.status === 'ready'),
    5000,
    'finished recording',
  )
  assert.equal(rec.hasVideo, true)
  assert.equal(rec.videoFormat, 'h264')
  assert.ok(rec.videoBytes > 40)
  const video = await call('GET', `/api/recordings/${rec.id}/video`, { token: bob })
  const bytes = Buffer.from(await video.raw.arrayBuffer())
  assert.equal(video.status, 200)
  assert.ok(bytes.subarray(0, 4).equals(Buffer.from([0, 0, 0, 1])), 'the file is a playable Annex-B stream')
})

test('falls back to screenshot frames when the video server is switched off', async () => {
  bobWs.send({ type: 'screen.unsubscribe', serial: 'FAKE0001' })
  process.env.DEVICEFARMZ_SCRCPY = 'false'
  try {
    bobWs.json.length = 0
    bobWs.send({ type: 'screen.subscribe', serial: 'FAKE0001', prefer: 'h264', fps: 8 })
    const mode = await bobWs.wait((m) => m.type === 'screen.mode', 'screen.mode')
    assert.equal(mode.mode, 'frames')
    const frame = await bobWs.wait((m) => m.type === 'screen.frame', 'screen.frame')
    assert.equal(frame.mime, 'image/png')
    assert.equal(Buffer.from(frame.data, 'base64').subarray(1, 4).toString(), 'PNG')
    assert.equal(frame.width, 1080)
    assert.equal(frame.height, 2400)
  } finally {
    delete process.env.DEVICEFARMZ_SCRCPY
  }
  bobWs.send({ type: 'screen.unsubscribe', serial: 'FAKE0001' })
})

// ------------------------------------------------------------------ Android: input, logs, tools

test('touch, typing and navigation become `input` commands in the device shell', async () => {
  const touch = (x: number, y: number, action: string) =>
    bobWs.send({ type: 'input.touch', serial: 'FAKE0001', contacts: [{ contact: 0, x, y, action }] })
  touch(100.4, 200.6, 'down')
  touch(100.4, 200.6, 'up')
  touch(100, 200, 'down')
  touch(300, 800, 'move')
  touch(300, 800, 'up')
  bobWs.send({ type: 'input.type', serial: 'FAKE0001', text: 'hi there' })
  bobWs.send({ type: 'input.type', serial: 'FAKE0001', text: "a'b;c" })
  bobWs.send({ type: 'input.home', serial: 'FAKE0001' })
  bobWs.send({ type: 'input.back', serial: 'FAKE0001' })
  bobWs.send({ type: 'input.key', serial: 'FAKE0001', keyCode: 66, down: true })

  await waitFor(() => pixel.inputLog.length >= 7, 3000, 'input commands')
  assert.equal(pixel.inputLog[0], 'input tap 100 201', 'a short press is a tap with rounded coordinates')
  assert.match(pixel.inputLog[1], /^input swipe 100 200 300 800 \d+$/, 'a long drag is a swipe with a duration')
  assert.equal(pixel.inputLog[2], 'input text hi%sthere', 'spaces are encoded as %s')
  assert.equal(pixel.inputLog[3], "input text a\\'b\\;c", 'shell metacharacters are escaped, not executed')
  assert.deepEqual(pixel.inputLog.slice(4), ['input keyevent 3', 'input keyevent 4', 'input keyevent 66'])
})

test('logcat is streamed and filtered per client', async () => {
  bobWs.json.length = 0
  bobWs.send({ type: 'log.subscribe', serial: 'FAKE0001', filter: 'HELLO 3' })
  await bobWs.wait((m) => m.type === 'log.line' && m.line.includes('hello 3'), 'a matching log line')
  await new Promise((r) => setTimeout(r, 300))
  const lines = bobWs.json.filter((m) => m.type === 'log.line')
  assert.ok(lines.length >= 1)
  assert.ok(lines.every((m) => m.line.toLowerCase().includes('hello 3')), 'only lines matching the filter are delivered')
  bobWs.send({ type: 'log.unsubscribe', serial: 'FAKE0001' })
})

test('shell and APK install go through adb', async () => {
  const sh = await call('POST', '/api/devices/FAKE0001/shell', { token: bob, body: { command: 'getprop ro.product.model' } })
  assert.equal(sh.json.output.trim(), 'Pixel 7')

  const form = new FormData()
  form.append('apk', new Blob(['PK fake apk']), 'checkout-debug.apk')
  const inst = await call('POST', '/api/devices/FAKE0001/install', { token: bob, form })
  assert.match(inst.json.output, /Success/)
  assert.deepEqual(pixel.installs.length, 1)
  const pkgs = await call('POST', '/api/devices/FAKE0001/shell', { token: bob, body: { command: 'pm list packages -3' } })
  assert.ok(pkgs.json.output.includes(pixel.installs[0]), 'the installed package shows up in the package list')
})

// ------------------------------------------------------------------ Android: reset

test('releasing an Android phone force-stops and clears every user app and wipes media', async () => {
  adbFake.shellDelayMs = 60
  const rel = await call('DELETE', '/api/devices/FAKE0001/owner', { token: bob })
  assert.equal(rel.status, 200)
  assert.equal(rel.json.status, 'cleaning')
  assert.equal((await call('POST', '/api/devices/FAKE0001/use', { token: carol })).status, 409, 'cannot be claimed mid-clean')
  await waitFor(async () => (await status(bob, 'FAKE0001')).status === 'available', 8000, 'cleaning to finish')
  adbFake.shellDelayMs = 0

  for (const [pkg, state] of pixel.packages) assert.equal(state.dataCleared, true, `${pkg} data was cleared`)
  const log = pixel.commandLog
  assert.ok(log.includes('am force-stop com.acme.shop'))
  assert.ok(log.includes('pm clear com.acme.mail'))
  assert.ok(log.some((c) => c.startsWith('rm -rf /sdcard/DCIM/')), 'photos are wiped')
  assert.ok(log.some((c) => c.startsWith('rm -rf /sdcard/Download/')), 'downloads are wiped')
  assert.ok(log.includes('settings put global http_proxy :0'), 'leftover proxy settings are reset')
  assert.ok(pixel.reversesRemoved >= 1, 'reverse port forwards are removed')
})

test('uninstall mode removes the user apps instead', async () => {
  process.env.DEVICEFARMZ_RESET_MODE = 'uninstall'
  try {
    assert.equal((await call('POST', '/api/devices/FAKE0001/use', { token: carol })).status, 200)
    assert.equal((await call('DELETE', '/api/devices/FAKE0001/owner', { token: carol })).status, 200)
    await waitFor(async () => (await status(carol, 'FAKE0001')).status === 'available', 5000, 'cleaning to finish')
    assert.equal(pixel.packages.size, 0, 'all user-installed apps were uninstalled')
  } finally {
    process.env.DEVICEFARMZ_RESET_MODE = 'clean'
  }
})

// ------------------------------------------------------------------ iOS

test('iOS: screen, touch, typing and buttons are translated into WebDriverAgent calls', async () => {
  const ws = await Client.open(carol)
  ws.send({ type: 'screen.subscribe', serial: 'IOS000000001', prefer: 'h264', fps: 5 })
  const mode = await ws.wait((m) => m.type === 'screen.mode', 'screen.mode')
  assert.equal(mode.mode, 'frames', 'iOS has no H.264 path, so it streams screenshots')
  const frame = await ws.wait((m) => m.type === 'screen.frame', 'screen.frame')
  assert.equal(frame.mime, 'image/png')
  assert.equal(Buffer.from(frame.data, 'base64').subarray(1, 4).toString(), 'PNG')

  const touch = (x: number, y: number, action: string) =>
    ws.send({ type: 'input.touch', serial: 'IOS000000001', contacts: [{ contact: 0, x, y, action }] })
  touch(120, 300, 'down')
  touch(120, 300, 'up')
  touch(50, 400, 'down')
  touch(250, 400, 'up')
  ws.send({ type: 'input.type', serial: 'IOS000000001', text: 'abc' })
  ws.send({ type: 'input.home', serial: 'IOS000000001' })
  ws.send({ type: 'input.power', serial: 'IOS000000001' })
  ws.send({ type: 'browser.open', serial: 'IOS000000001', url: 'https://example.com/x' })
  await waitFor(() => wda.find('POST', '/session/S1/url').length === 1, 3000, 'URL request')

  const tap = wda.find('POST', '/session/S1/wda/tap/0')
  assert.deepEqual(tap.map((r) => r.body), [{ x: 120, y: 300 }])
  const drag = wda.find('POST', '/session/S1/wda/dragfromtoforduration')
  assert.equal(drag.length, 1)
  assert.deepEqual([drag[0].body.fromX, drag[0].body.fromY, drag[0].body.toX, drag[0].body.toY], [50, 400, 250, 400])
  assert.deepEqual(wda.find('POST', '/session/S1/wda/keys')[0].body, { value: ['a', 'b', 'c'] })
  assert.equal(wda.find('POST', '/wda/homescreen').length, 1)
  assert.equal(wda.find('POST', '/wda/lock').length, 1)
  assert.deepEqual(wda.find('POST', '/session/S1/url')[0].body, { url: 'https://example.com/x' })

  ws.send({ type: 'input.back', serial: 'IOS000000001' })
  const err = await ws.wait((m) => m.type === 'device.error', 'device.error')
  assert.match(err.message, /not available on ios/i, 'Android-only buttons report a clear error')

  ws.send({ type: 'screen.unsubscribe', serial: 'IOS000000001' })
  ws.close()
})

test('iOS: unsupported tools answer 501 and app install uses the installer', async () => {
  const sh = await call('POST', '/api/devices/IOS000000001/shell', { token: carol, body: { command: 'ls' } })
  assert.equal(sh.status, 501)
  assert.match(sh.json.error, /Shell is not available on ios/i)

  const form = new FormData()
  form.append('apk', new Blob(['ipa']), 'App.ipa')
  const inst = await call('POST', '/api/devices/IOS000000001/install', { token: carol, form })
  assert.match(inst.json.output, /Install: Complete/)
  const call0 = iosTools.calls.find((c) => c.args.includes('-i'))
  assert.deepEqual(call0?.args.slice(0, 3), ['-u', 'IOS000000001', '-i'])
})

test('iOS: release terminates the foreground app and, in uninstall mode, removes user apps', async () => {
  wda.requests.length = 0
  assert.equal((await call('DELETE', '/api/devices/IOS000000001/owner', { token: carol })).status, 200)
  await waitFor(async () => (await status(carol, 'IOS000000001')).status === 'available', 5000, 'cleaning to finish')
  assert.equal(wda.find('POST', '/session/S1/wda/apps/terminate')[0]?.body.bundleId, 'com.acme.ios')
  assert.ok(wda.find('POST', '/wda/homescreen').length >= 1)
  assert.deepEqual(iosTools.installed.sort(), ['com.acme.ios', 'com.acme.notes'], 'clean mode keeps installed apps')

  process.env.DEVICEFARMZ_RESET_MODE = 'uninstall'
  try {
    assert.equal((await call('POST', '/api/devices/IOS000000001/use', { token: carol })).status, 200)
    assert.equal((await call('DELETE', '/api/devices/IOS000000001/owner', { token: carol })).status, 200)
    await waitFor(async () => (await status(carol, 'IOS000000001')).status === 'available', 5000, 'cleaning to finish')
    assert.deepEqual(iosTools.installed, [], 'user apps were uninstalled through ideviceinstaller')
  } finally {
    process.env.DEVICEFARMZ_RESET_MODE = 'clean'
  }
})

// ------------------------------------------------------------------ unplugging

test('unplugging a phone marks it absent', async () => {
  bobWs.close()
  adbFake.unplug('FAKE0001')
  const gone = await waitFor(async () => {
    const d = await status(bob, 'FAKE0001')
    return d.presence !== 'present' ? d : null
  }, 8000, 'device to disappear')
  assert.ok(['absent', 'offline'].includes(gone.presence))
})
