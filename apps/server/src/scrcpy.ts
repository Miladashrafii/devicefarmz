import { EventEmitter } from 'node:events'
import net from 'node:net'
import type { ChildProcess } from 'node:child_process'
import { adbForward, adbPush, adbRemoveForward, adbSpawn } from './adb.js'
import { config } from './config.js'

const REMOTE_JAR = '/data/local/tmp/devicefarmz-video.jar'

/** Splits an Annex-B byte stream into NAL units, each normalised to a 4-byte start code. */
export class NalSplitter {
  private buf: Buffer = Buffer.alloc(0)

  push(chunk: Buffer): Buffer[] {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk
    const starts: number[] = []
    for (let i = 0; i + 2 < this.buf.length; i++) {
      if (this.buf[i] === 0 && this.buf[i + 1] === 0 && this.buf[i + 2] === 1) {
        starts.push(i)
        i += 2
      }
    }
    if (starts.length < 2) return []

    const out: Buffer[] = []
    for (let s = 0; s < starts.length - 1; s++) {
      const payloadStart = starts[s] + 3
      let end = starts[s + 1]
      while (end > payloadStart && this.buf[end - 1] === 0) end -= 1
      if (end > payloadStart) {
        out.push(Buffer.concat([Buffer.from([0, 0, 0, 1]), this.buf.subarray(payloadStart, end)]))
      }
    }
    this.buf = this.buf.subarray(starts[starts.length - 1])
    return out
  }
}

/**
 * Streams the device screen as raw H.264 using the scrcpy server jar.
 * Emits `nal` (Buffer) for each NAL unit and `close` when the stream ends.
 */
export class ScrcpyStream extends EventEmitter {
  private proc: ChildProcess | null = null
  private socket: net.Socket | null = null
  private forwardSpec: string | null = null
  private stopped = false
  private splitter = new NalSplitter()

  constructor(private readonly serial: string) {
    super()
  }

  async start(): Promise<void> {
    const scid = Math.floor(Math.random() * 0x7fffffff)
      .toString(16)
      .padStart(8, '0')
    const { jar, version, maxSize, bitRate, maxFps } = config.scrcpy

    await adbPush(this.serial, jar, REMOTE_JAR)

    const args = [
      '-s',
      this.serial,
      'shell',
      `CLASSPATH=${REMOTE_JAR}`,
      'app_process',
      '/',
      'com.genymobile.scrcpy.Server',
      version,
      `scid=${scid}`,
      'log_level=error',
      'tunnel_forward=true',
      'video=true',
      'audio=false',
      'control=false',
      'cleanup=false',
      'raw_stream=true',
      `max_size=${maxSize}`,
      `video_bit_rate=${bitRate}`,
      `max_fps=${maxFps}`,
    ]
    let stderr = ''
    this.proc = adbSpawn(args)
    this.proc.stdout?.on('data', (d: Buffer) => (stderr += d.toString()))
    this.proc.stderr?.on('data', (d: Buffer) => (stderr += d.toString()))
    const exited = new Promise<never>((_, reject) => {
      this.proc!.on('exit', (code) => {
        if (!this.stopped) reject(new Error(`video server exited (${code}): ${stderr.trim().slice(0, 300)}`))
      })
      this.proc!.on('error', reject)
    })
    exited.catch(() => undefined)

    await new Promise((r) => setTimeout(r, 400))
    const port = Number((await adbForward(this.serial, 'tcp:0', `localabstract:scrcpy_${scid}`)).trim())
    if (!port) throw new Error('adb forward did not return a port')
    this.forwardSpec = `tcp:${port}`

    const deadline = Date.now() + 10_000
    const connected = this.connectWithRetry(port, deadline)
    await Promise.race([connected, exited])
  }

  private connectWithRetry(port: number, deadline: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const attempt = () => {
        if (this.stopped) return reject(new Error('stopped'))
        if (Date.now() > deadline) return reject(new Error('timed out waiting for video stream'))
        const socket = net.connect(port, '127.0.0.1')
        let gotData = false
        socket.on('data', (chunk: Buffer) => {
          if (!gotData) {
            gotData = true
            this.socket = socket
            resolve()
          }
          for (const nal of this.splitter.push(chunk)) this.emit('nal', nal)
        })
        socket.on('error', () => undefined)
        socket.on('close', () => {
          if (gotData) {
            if (!this.stopped) this.emit('close')
          } else {
            setTimeout(attempt, 250)
          }
        })
      }
      attempt()
    })
  }

  stop(): void {
    if (this.stopped) return
    this.stopped = true
    this.socket?.destroy()
    this.proc?.kill()
    if (this.forwardSpec) void adbRemoveForward(this.serial, this.forwardSpec)
    this.removeAllListeners()
  }
}
