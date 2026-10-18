import path from 'node:path'
import type { Server } from 'node:http'
import { WebSocketServer, WebSocket } from 'ws'
import {
  BINARY_KIND_H264,
  type ClientToServer,
  type ScreenPreference,
  type ServerToClient,
  type User,
} from '@devicefarmz/core'
import { assertOperator } from './api.js'
import { verifyToken } from './auth.js'
import { uploadsDir } from './config.js'
import { claimDevice, releaseDevice, scheduleRelease } from './lifecycle.js'
import { isRecording, startRecording, stopRecording } from './recorder.js'
import { registry } from './registry.js'
import { providers, requireWorker } from './workers.js'

interface ClientState {
  ws: WebSocket
  user: User | null
  screens: Map<string, ScreenPreference>
  logs: Map<string, string>
  claimed: Set<string>
}

function send(ws: WebSocket, msg: ServerToClient): void {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg))
}

export class WsHub {
  private wss: WebSocketServer | null = null
  private clients = new Set<ClientState>()
  private offRegistry: (() => void) | null = null

  attach(server: Server): void {
    this.wss = new WebSocketServer({ server, path: '/ws', maxPayload: 1024 * 1024 })
    this.wss.on('connection', (ws) => this.onConnection(ws))

    const onChange = (device: unknown) => this.broadcast({ type: 'device.change', device: device as never })
    registry.on('change', onChange)
    this.offRegistry = () => registry.off('change', onChange)

    for (const p of providers) {
      p.on('screen.frame', (frame) => {
        for (const c of this.clients) {
          if (c.screens.get(frame.serial) === 'frames') send(c.ws, { type: 'screen.frame', ...frame })
        }
      })
      p.on('video.nal', ({ serial, data }: { serial: string; data: Buffer }) => {
        const name = Buffer.from(serial, 'utf8')
        const header = Buffer.from([BINARY_KIND_H264, name.length])
        let packet: Buffer | null = null
        for (const c of this.clients) {
          if (c.screens.get(serial) !== 'h264' || c.ws.readyState !== WebSocket.OPEN) continue
          // Drop frames for slow clients instead of buffering unbounded memory
          if (c.ws.bufferedAmount > 4 * 1024 * 1024) continue
          packet ??= Buffer.concat([header, name, data])
          c.ws.send(packet, { binary: true })
        }
      })
      p.on('log.line', ({ serial, line }: { serial: string; line: string }) => {
        for (const c of this.clients) {
          const filter = c.logs.get(serial)
          if (filter === undefined) continue
          if (filter && !line.toLowerCase().includes(filter)) continue
          send(c.ws, { type: 'log.line', serial, line })
        }
      })
    }
  }

  close(): void {
    this.offRegistry?.()
    for (const c of this.clients) c.ws.terminate()
    this.clients.clear()
    this.wss?.close()
  }

  private onConnection(ws: WebSocket): void {
    const state: ClientState = { ws, user: null, screens: new Map(), logs: new Map(), claimed: new Set() }
    this.clients.add(state)

    ws.on('message', (raw, isBinary) => {
      if (isBinary) return
      void this.onMessage(state, raw.toString())
    })
    ws.on('close', () => this.cleanup(state))
    ws.on('error', () => undefined)
  }

  private cleanup(state: ClientState): void {
    this.clients.delete(state)
    for (const [serial, mode] of state.screens) {
      try {
        requireWorker(serial).unsubscribeScreen(mode)
      } catch {
        /* device gone */
      }
    }
    for (const serial of state.logs.keys()) {
      try {
        requireWorker(serial).unsubscribeLogs()
      } catch {
        /* device gone */
      }
    }
    // Give the user a moment to reconnect before freeing (and wiping) the device
    if (state.user) for (const serial of state.claimed) scheduleRelease(serial, state.user.email)
  }

  private broadcast(msg: ServerToClient): void {
    for (const c of this.clients) if (c.user) send(c.ws, msg)
  }

  private async onMessage(state: ClientState, raw: string): Promise<void> {
    let msg: ClientToServer
    try {
      msg = JSON.parse(raw) as ClientToServer
    } catch {
      return
    }

    if (msg.type === 'auth') {
      const user = verifyToken(msg.token)
      if (!user) {
        send(state.ws, { type: 'auth.error', message: 'Invalid token' })
        return
      }
      state.user = user
      send(state.ws, { type: 'auth.ok', user })
      send(state.ws, { type: 'device.list', devices: registry.list() })
      return
    }

    if (!state.user) {
      send(state.ws, { type: 'auth.error', message: 'Authenticate first' })
      return
    }

    try {
      await this.handle(state, state.user, msg)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      const serial = 'serial' in msg ? String((msg as { serial?: string }).serial ?? '') : ''
      if (serial) send(state.ws, { type: 'device.error', serial, message })
      else send(state.ws, { type: 'notify', level: 'error', message })
    }
  }

  private async handle(state: ClientState, user: User, msg: ClientToServer): Promise<void> {
    if (msg.type === 'device.list') {
      send(state.ws, { type: 'device.list', devices: registry.list() })
      return
    }
    if (!('serial' in msg)) return
    const serial = msg.serial

    switch (msg.type) {
      case 'device.use': {
        send(state.ws, { type: 'device.change', device: claimDevice(serial, user) })
        state.claimed.add(serial)
        return
      }
      case 'device.release': {
        state.claimed.delete(serial)
        send(state.ws, { type: 'device.change', device: await releaseDevice(serial, user) })
        return
      }
      case 'device.note': {
        assertOperator(user, serial)
        registry.upsert({ serial, notes: msg.notes.slice(0, 500) })
        return
      }
      case 'screen.subscribe': {
        claimDevice(serial, user)
        state.claimed.add(serial)
        const previous = state.screens.get(serial)
        if (previous) requireWorker(serial).unsubscribeScreen(previous)
        // Register before awaiting: the encoder emits SPS/PPS and the first key frame as soon as it
        // starts, and a client that misses them cannot decode anything until the next key frame.
        const wanted = msg.prefer ?? 'frames'
        state.screens.set(serial, wanted)
        let mode: typeof wanted
        try {
          mode = await requireWorker(serial).subscribeScreen(wanted, msg.fps)
        } catch (err) {
          state.screens.delete(serial)
          throw err
        }
        state.screens.set(serial, mode)
        send(state.ws, { type: 'screen.mode', serial, mode })
        const rec = isRecording(serial)
        send(state.ws, { type: 'record.state', serial, recording: Boolean(rec), id: rec?.id })
        return
      }
      case 'screen.unsubscribe': {
        const mode = state.screens.get(serial)
        if (mode) requireWorker(serial).unsubscribeScreen(mode)
        state.screens.delete(serial)
        return
      }
      case 'record.start': {
        assertOperator(user, serial)
        const rec = await startRecording(serial, user.email, msg.note)
        this.broadcastRecordState(serial, true, rec.id)
        return
      }
      case 'record.stop': {
        assertOperator(user, serial)
        const rec = await stopRecording(serial)
        this.broadcastRecordState(serial, false, rec?.id)
        return
      }
      case 'log.subscribe': {
        assertOperator(user, serial)
        if (!state.logs.has(serial)) requireWorker(serial).subscribeLogs()
        state.logs.set(serial, (msg.filter ?? '').toLowerCase())
        return
      }
      case 'log.unsubscribe': {
        if (state.logs.delete(serial)) requireWorker(serial).unsubscribeLogs()
        return
      }
      default:
        break
    }

    // Everything below needs the caller to hold the device
    assertOperator(user, serial)
    const worker = requireWorker(serial)

    switch (msg.type) {
      case 'input.touch':
        await worker.handleTouches(msg.contacts)
        return
      case 'input.type':
        await worker.typeText(msg.text)
        return
      case 'input.key':
        if (msg.down) await worker.key(msg.keyCode)
        return
      case 'input.home':
      case 'input.back':
      case 'input.recent':
      case 'input.power':
        await worker.nav(msg.type.replace('input.', '') as 'home' | 'back' | 'recent' | 'power')
        return
      case 'shell.exec': {
        const code = await worker.shell(msg.command, (chunk) =>
          send(state.ws, { type: 'shell.output', id: msg.id, serial, chunk }),
        )
        send(state.ws, { type: 'shell.done', id: msg.id, serial, code })
        return
      }
      case 'browser.open':
        await worker.openBrowser(msg.url, msg.packageName)
        return
      case 'apk.install': {
        const out = await worker.installApp(path.join(uploadsDir(), path.basename(msg.storageId)))
        send(state.ws, { type: 'notify', level: 'info', message: out.trim() || 'Install finished' })
        return
      }
      case 'file.list':
        send(state.ws, { type: 'file.list', serial, path: msg.path, entries: await worker.listFiles(msg.path) })
        return
      case 'file.pull': {
        const local = path.join(uploadsDir(), `pull-${Date.now()}`)
        await worker.pullFile(msg.path, local)
        send(state.ws, { type: 'notify', level: 'info', message: `Pulled to storage: ${path.basename(local)}` })
        return
      }
      case 'identify.show':
        await worker.identify()
        return
      case 'reboot':
        await worker.reboot()
        return
      case 'account.list':
        send(state.ws, { type: 'account.list', serial, accounts: await worker.accounts() })
        return
      case 'clipboard.get':
        send(state.ws, { type: 'clipboard.value', serial, text: await worker.getClipboard() })
        return
      case 'clipboard.set':
        await worker.setClipboard(msg.text)
        return
      case 'port.forward':
        await worker.reverse(msg.devicePort, msg.targetPort)
        send(state.ws, {
          type: 'notify',
          level: 'info',
          message: `Reverse tcp:${msg.devicePort} -> ${msg.targetHost}:${msg.targetPort}`,
        })
        return
      case 'port.unforward':
        await worker.unreverse(msg.devicePort)
        return
      default:
        return
    }
  }

  private broadcastRecordState(serial: string, recording: boolean, id?: string): void {
    for (const c of this.clients) {
      if (c.user && (c.screens.has(serial) || c.claimed.has(serial))) {
        send(c.ws, { type: 'record.state', serial, recording, id })
      }
    }
  }
}

export const wsHub = new WsHub()
