/** Wire protocol between the hub and browser clients */

export type ScreenPreference = 'h264' | 'frames'

export type ClientToServer =
  | { type: 'auth'; token: string }
  | { type: 'device.list' }
  | { type: 'device.use'; serial: string }
  | { type: 'device.release'; serial: string }
  | { type: 'device.note'; serial: string; notes: string }
  | { type: 'input.touch'; serial: string; contacts: TouchContact[] }
  | { type: 'input.key'; serial: string; keyCode: number; down: boolean }
  | { type: 'input.type'; serial: string; text: string }
  | { type: 'input.home' | 'input.back' | 'input.recent' | 'input.power'; serial: string }
  | { type: 'shell.exec'; serial: string; command: string; id: string }
  | { type: 'log.subscribe'; serial: string; filter?: string }
  | { type: 'log.unsubscribe'; serial: string }
  | { type: 'screen.subscribe'; serial: string; prefer?: ScreenPreference; fps?: number }
  | { type: 'screen.unsubscribe'; serial: string }
  | { type: 'record.start'; serial: string; note?: string }
  | { type: 'record.stop'; serial: string }
  | { type: 'browser.open'; serial: string; url: string; packageName?: string }
  | { type: 'apk.install'; serial: string; storageId: string }
  | { type: 'file.list'; serial: string; path: string }
  | { type: 'file.pull'; serial: string; path: string }
  | { type: 'identify.show'; serial: string }
  | { type: 'reboot'; serial: string }
  | { type: 'clipboard.set'; serial: string; text: string }
  | { type: 'clipboard.get'; serial: string }
  | { type: 'port.forward'; serial: string; devicePort: number; targetHost: string; targetPort: number }
  | { type: 'port.unforward'; serial: string; devicePort: number }
  | { type: 'account.list'; serial: string }

export type ServerToClient =
  | { type: 'auth.ok'; user: import('./types.js').User }
  | { type: 'auth.error'; message: string }
  | { type: 'device.list'; devices: import('./types.js').Device[] }
  | { type: 'device.change'; device: import('./types.js').Device }
  | { type: 'device.error'; serial: string; message: string }
  | { type: 'shell.output'; id: string; serial: string; chunk: string }
  | { type: 'shell.done'; id: string; serial: string; code: number }
  | { type: 'log.line'; serial: string; line: string }
  | { type: 'screen.mode'; serial: string; mode: ScreenPreference }
  | {
      type: 'screen.frame'
      serial: string
      data: string
      mime: string
      width: number
      height: number
      rotation: number
    }
  | { type: 'record.state'; serial: string; recording: boolean; id?: string }
  | { type: 'file.list'; serial: string; path: string; entries: FileEntry[] }
  | { type: 'clipboard.value'; serial: string; text: string }
  | { type: 'account.list'; serial: string; accounts: AccountEntry[] }
  | { type: 'notify'; level: 'info' | 'warn' | 'error'; message: string }
  | { type: 'pong' }

/**
 * Binary WebSocket frames carry H.264 NAL units.
 * Layout: [kind:1][serialLength:1][serial:utf8][payload]
 * kind 1 = H.264 NAL unit (Annex-B, 4-byte start code)
 */
export const BINARY_KIND_H264 = 1

export interface TouchContact {
  contact: number
  x: number
  y: number
  pressure?: number
  action: 'down' | 'move' | 'up'
}

export interface FileEntry {
  name: string
  path: string
  mode: string
  size: number
  mtime: string
  isDir: boolean
}

export interface AccountEntry {
  name: string
  type: string
}
