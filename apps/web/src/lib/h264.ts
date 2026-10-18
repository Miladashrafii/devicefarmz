/**
 * Minimal low-latency H.264 (Annex-B) player built on WebCodecs.
 * Feed it individual NAL units (with start codes); it assembles decodable chunks
 * and paints frames onto a canvas.
 */

function nalType(nal: Uint8Array): number {
  // 3- or 4-byte start code, then the NAL header
  const off = nal[2] === 1 ? 3 : 4
  return nal[off] & 0x1f
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let o = 0
  for (const p of parts) {
    out.set(p, o)
    o += p.length
  }
  return out
}

function hex(n: number): string {
  return n.toString(16).padStart(2, '0')
}

export function h264Supported(): boolean {
  return typeof VideoDecoder !== 'undefined' && typeof EncodedVideoChunk !== 'undefined'
}

export class H264Player {
  private decoder: VideoDecoder | null = null
  private ctx: CanvasRenderingContext2D
  private sps: Uint8Array | null = null
  private pps: Uint8Array | null = null
  private gotKey = false
  private ts = 0
  private destroyed = false
  frames = 0
  onSize?: (w: number, h: number) => void
  onError?: (message: string) => void

  constructor(private canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('2D canvas unavailable')
    this.ctx = ctx
  }

  push(nal: Uint8Array): void {
    if (this.destroyed || nal.length < 5) return
    const type = nalType(nal)
    if (type === 7) {
      const changed = !this.sps || this.sps.length !== nal.length || this.sps.some((b, i) => b !== nal[i])
      this.sps = nal.slice()
      if (changed) this.configure()
      return
    }
    if (type === 8) {
      this.pps = nal.slice()
      return
    }
    if (!this.decoder || this.decoder.state !== 'configured') return
    if (type === 5) {
      if (!this.sps || !this.pps) return
      this.gotKey = true
      this.decode(concat(this.sps, this.pps, nal), 'key')
    } else if (type === 1 && this.gotKey) {
      // Drop frames instead of piling up latency when the decoder falls behind
      if (this.decoder.decodeQueueSize > 8) {
        this.gotKey = false
        return
      }
      this.decode(nal, 'delta')
    }
  }

  private configure(): void {
    if (!this.sps) return
    const off = this.sps[2] === 1 ? 3 : 4
    const codec = `avc1.${hex(this.sps[off + 1])}${hex(this.sps[off + 2])}${hex(this.sps[off + 3])}`
    this.decoder?.close()
    this.gotKey = false
    const decoder = new VideoDecoder({
      output: (frame) => {
        if (this.destroyed) {
          frame.close()
          return
        }
        const w = frame.displayWidth
        const h = frame.displayHeight
        if (this.canvas.width !== w || this.canvas.height !== h) {
          this.canvas.width = w
          this.canvas.height = h
          this.onSize?.(w, h)
        }
        this.ctx.drawImage(frame, 0, 0)
        frame.close()
        this.frames += 1
      },
      error: (e) => this.onError?.(e.message),
    })
    decoder.configure({ codec, optimizeForLatency: true, hardwareAcceleration: 'prefer-hardware' })
    this.decoder = decoder
  }

  private decode(data: Uint8Array, type: 'key' | 'delta'): void {
    try {
      this.decoder?.decode(new EncodedVideoChunk({ type, timestamp: (this.ts += 16_667), data }))
    } catch (err) {
      this.onError?.(err instanceof Error ? err.message : String(err))
    }
  }

  destroy(): void {
    this.destroyed = true
    try {
      this.decoder?.close()
    } catch {
      /* already closed */
    }
    this.decoder = null
  }
}
