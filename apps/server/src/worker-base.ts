import { EventEmitter } from 'node:events'
import type {
  AccountEntry,
  FileEntry,
  Platform,
  ScreenPreference,
  TouchContact,
} from '@devicefarmz/core'

export interface ResetReport {
  cleaned: string[]
  errors: string[]
  notes: string[]
}

export interface ScreenFrame {
  serial: string
  data: string
  mime: string
  width: number
  height: number
  rotation: number
}

export class UnsupportedError extends Error {
  /** Surfaced by the REST layer as 501 Not Implemented instead of a generic 500 */
  readonly status = 501

  constructor(feature: string, platform: string) {
    super(`${feature} is not available on ${platform} devices`)
  }
}

/**
 * Common surface of every device worker (Android, iOS, simulated).
 * Events: `screen.frame` (ScreenFrame), `video.nal` ({serial,data}), `log.line` ({serial,line}).
 */
export abstract class BaseWorker extends EventEmitter {
  abstract readonly platform: Platform
  private logSubs = 0
  private videoSubs = 0

  constructor(readonly serial: string) {
    super()
  }

  abstract prepare(): Promise<void>
  abstract destroy(): void

  async refreshTelemetry(): Promise<void> {}

  /** Returns the mode the client will actually receive */
  abstract subscribeScreen(prefer: ScreenPreference, fps?: number): Promise<ScreenPreference>
  abstract unsubscribeScreen(mode: ScreenPreference): void

  /** H.264 availability for recording; false when the worker can only produce still frames */
  supportsVideo(): boolean {
    return false
  }

  async acquireVideo(): Promise<boolean> {
    if (!this.supportsVideo()) return false
    this.videoSubs += 1
    if (this.videoSubs === 1) {
      try {
        await this.startVideo()
      } catch (err) {
        this.videoSubs -= 1
        throw err
      }
    }
    return true
  }

  releaseVideo(): void {
    if (this.videoSubs === 0) return
    this.videoSubs -= 1
    if (this.videoSubs === 0) this.stopVideo()
  }

  protected async startVideo(): Promise<void> {}
  protected stopVideo(): void {}

  subscribeLogs(): void {
    this.logSubs += 1
    if (this.logSubs === 1) this.startLogs()
  }

  unsubscribeLogs(): void {
    if (this.logSubs === 0) return
    this.logSubs -= 1
    if (this.logSubs === 0) this.stopLogs()
  }

  protected startLogs(): void {}
  protected stopLogs(): void {}

  protected get hasLogSubscribers(): boolean {
    return this.logSubs > 0
  }

  async handleTouches(_contacts: TouchContact[]): Promise<void> {
    throw new UnsupportedError('Touch input', this.platform)
  }
  async typeText(_text: string): Promise<void> {
    throw new UnsupportedError('Typing', this.platform)
  }
  async key(_code: number): Promise<void> {
    throw new UnsupportedError('Key events', this.platform)
  }
  async nav(_kind: 'home' | 'back' | 'recent' | 'power'): Promise<void> {
    throw new UnsupportedError('Navigation keys', this.platform)
  }
  async shell(_command: string, _onChunk: (chunk: string) => void): Promise<number> {
    throw new UnsupportedError('Shell', this.platform)
  }
  async installApp(_path: string, _originalName?: string): Promise<string> {
    throw new UnsupportedError('App install', this.platform)
  }
  async openBrowser(_url: string, _packageName?: string): Promise<void> {
    throw new UnsupportedError('Open URL', this.platform)
  }
  async listFiles(_path: string): Promise<FileEntry[]> {
    throw new UnsupportedError('File explorer', this.platform)
  }
  async identify(): Promise<void> {
    throw new UnsupportedError('Identify', this.platform)
  }
  async reboot(): Promise<void> {
    throw new UnsupportedError('Reboot', this.platform)
  }
  async accounts(): Promise<AccountEntry[]> {
    return []
  }
  async browsers(): Promise<{ packageName: string; label: string }[]> {
    return []
  }
  async reverse(_devicePort: number, _hostPort: number): Promise<void> {
    throw new UnsupportedError('Port forwarding', this.platform)
  }
  async unreverse(_devicePort: number): Promise<void> {
    throw new UnsupportedError('Port forwarding', this.platform)
  }
  async pullFile(_remote: string, _local: string): Promise<void> {
    throw new UnsupportedError('File pull', this.platform)
  }
  async getClipboard(): Promise<string> {
    throw new UnsupportedError('Clipboard', this.platform)
  }
  async setClipboard(_text: string): Promise<void> {
    throw new UnsupportedError('Clipboard', this.platform)
  }

  /** Remove user data left behind by the previous session */
  abstract reset(mode: 'clean' | 'uninstall'): Promise<ResetReport>
}

export abstract class ProviderBase extends EventEmitter {
  readonly workers = new Map<string, BaseWorker>()
  abstract readonly name: string
  abstract start(): Promise<void>
  abstract stop(): void

  getWorker(serial: string): BaseWorker | undefined {
    return this.workers.get(serial)
  }

  protected register(worker: BaseWorker): void {
    this.workers.set(worker.serial, worker)
    worker.on('screen.frame', (f: ScreenFrame) => this.emit('screen.frame', f))
    worker.on('video.nal', (v: { serial: string; data: Buffer }) => this.emit('video.nal', v))
    worker.on('log.line', (l: { serial: string; line: string }) => this.emit('log.line', l))
  }
}
