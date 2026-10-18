import { BINARY_KIND_H264, type ClientToServer, type ServerToClient } from '@devicefarmz/core'

type Handler = (msg: ServerToClient) => void
type BinaryHandler = (serial: string, nal: Uint8Array) => void

export class FarmSocket {
  private ws: WebSocket | null = null
  private handlers = new Set<Handler>()
  private binary = new Set<BinaryHandler>()
  private token: string
  private reconnectTimer: number | null = null
  private closed = false
  /** Messages queued while the socket is (re)connecting; flushed after auth succeeds */
  private pending: ClientToServer[] = []
  private authed = false
  private onReady = new Set<() => void>()

  constructor(token: string) {
    this.token = token
  }

  connect(): void {
    this.closed = false
    const proto = location.protocol === 'https:' ? 'wss' : 'ws'
    const ws = new WebSocket(`${proto}://${location.host}/ws`)
    ws.binaryType = 'arraybuffer'
    this.ws = ws
    this.authed = false
    ws.onopen = () => ws.send(JSON.stringify({ type: 'auth', token: this.token }))
    ws.onmessage = (ev) => {
      if (typeof ev.data !== 'string') {
        const bytes = new Uint8Array(ev.data as ArrayBuffer)
        if (bytes[0] !== BINARY_KIND_H264) return
        const serialLen = bytes[1]
        const serial = new TextDecoder().decode(bytes.subarray(2, 2 + serialLen))
        const nal = bytes.subarray(2 + serialLen)
        for (const h of this.binary) h(serial, nal)
        return
      }
      try {
        const msg = JSON.parse(ev.data) as ServerToClient
        if (msg.type === 'auth.ok') {
          this.authed = true
          const queued = this.pending.splice(0)
          for (const m of queued) ws.send(JSON.stringify(m))
          for (const r of this.onReady) r()
        }
        for (const h of this.handlers) h(msg)
      } catch {
        /* ignore malformed frames */
      }
    }
    ws.onclose = () => {
      this.authed = false
      if (!this.closed) this.reconnectTimer = window.setTimeout(() => this.connect(), 1500)
    }
  }

  close(): void {
    this.closed = true
    if (this.reconnectTimer) window.clearTimeout(this.reconnectTimer)
    this.ws?.close()
    this.ws = null
  }

  on(handler: Handler): () => void {
    this.handlers.add(handler)
    return () => this.handlers.delete(handler)
  }

  onBinary(handler: BinaryHandler): () => void {
    this.binary.add(handler)
    return () => this.binary.delete(handler)
  }

  /** Runs every time the socket (re)authenticates, e.g. to resubscribe after a reconnect */
  ready(cb: () => void): () => void {
    this.onReady.add(cb)
    return () => this.onReady.delete(cb)
  }

  send(msg: ClientToServer): void {
    if (this.authed && this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg))
    else if (!msg.type.startsWith('input.')) this.pending.push(msg) // never replay stale touches
  }
}
