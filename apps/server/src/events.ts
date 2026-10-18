import { EventEmitter } from 'node:events'
import type { Device, FarmEventType } from '@devicefarmz/core'
import { registry } from './registry.js'

export interface FarmEvent {
  id: string
  type: FarmEventType
  createdAt: string
  data: Record<string, unknown>
}

const bus = new EventEmitter()
let counter = 0

export function emitEvent(type: FarmEventType, data: Record<string, unknown>): void {
  const event: FarmEvent = {
    id: `evt_${Date.now().toString(36)}_${(counter++).toString(36)}`,
    type,
    createdAt: new Date().toISOString(),
    data,
  }
  bus.emit('event', event)
}

export function onEvent(fn: (e: FarmEvent) => void): () => void {
  bus.on('event', fn)
  return () => bus.off('event', fn)
}

function summary(d: Device) {
  return {
    serial: d.serial,
    platform: d.platform,
    model: d.marketName || d.model,
    version: d.version,
    owner: d.owner?.email ?? null,
  }
}

let bridged = false

/** Derives high-level events from registry state transitions */
export function startEventBridge(): void {
  if (bridged) return
  bridged = true
  const last = new Map<string, { online: boolean; using: boolean; owner: string | null }>()
  registry.on('change', (d: Device) => {
    const online = d.presence === 'present' && d.ready
    const prev = last.get(d.serial)
    last.set(d.serial, { online, using: d.using, owner: d.owner?.email ?? null })
    if (!prev) {
      if (online) emitEvent('device.online', summary(d))
      return
    }
    if (online && !prev.online) emitEvent('device.online', summary(d))
    if (!online && prev.online) emitEvent('device.offline', summary(d))
    if (d.using && !prev.using) emitEvent('device.claimed', summary(d))
    if (!d.using && prev.using) emitEvent('device.released', { ...summary(d), previousOwner: prev.owner })
  })
}
