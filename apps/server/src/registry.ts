import { EventEmitter } from 'node:events'
import type { Device, DeviceOwner, DevicePresence, DeviceStatus } from '@devicefarmz/core'
import * as db from './db.js'

export class DeviceRegistry extends EventEmitter {
  private devices = new Map<string, Device>()

  load(): void {
    this.devices.clear()
    for (const d of db.listDevices()) {
      // Nothing is attached right after a restart
      this.devices.set(d.serial, {
        ...d,
        presence: 'absent',
        ready: false,
        using: false,
        owner: null,
        status: 'offline',
      })
    }
  }

  list(): Device[] {
    return [...this.devices.values()].sort((a, b) => a.serial.localeCompare(b.serial))
  }

  get(serial: string): Device | undefined {
    return this.devices.get(serial)
  }

  upsert(partial: Partial<Device> & { serial: string }): Device {
    const now = new Date().toISOString()
    const prev = this.devices.get(partial.serial)
    const next: Device = {
      serial: partial.serial,
      platform: partial.platform ?? prev?.platform ?? 'android',
      simulated: partial.simulated ?? prev?.simulated ?? false,
      model: partial.model ?? prev?.model ?? 'Unknown',
      manufacturer: partial.manufacturer ?? prev?.manufacturer ?? 'Unknown',
      version: partial.version ?? prev?.version ?? '',
      sdk: partial.sdk ?? prev?.sdk ?? 0,
      marketName: partial.marketName ?? prev?.marketName ?? null,
      product: partial.product ?? prev?.product ?? null,
      abi: partial.abi ?? prev?.abi ?? null,
      cpuPlatform: partial.cpuPlatform ?? prev?.cpuPlatform ?? null,
      openGlVersion: partial.openGlVersion ?? prev?.openGlVersion ?? null,
      phone: partial.phone ??
        prev?.phone ?? {
          phoneNumber: null,
          imei: null,
          imsi: null,
          iccid: null,
          network: null,
        },
      battery: partial.battery ?? prev?.battery ?? null,
      network: partial.network ?? prev?.network ?? null,
      display: partial.display ?? prev?.display ?? null,
      presence: partial.presence ?? prev?.presence ?? 'absent',
      status: partial.status ?? prev?.status ?? 'offline',
      ready: partial.ready ?? prev?.ready ?? false,
      using: partial.using ?? prev?.using ?? false,
      owner: partial.owner !== undefined ? partial.owner : (prev?.owner ?? null),
      notes: partial.notes ?? prev?.notes ?? '',
      groupId: partial.groupId !== undefined ? partial.groupId : (prev?.groupId ?? null),
      provider: partial.provider ?? prev?.provider ?? null,
      channel: partial.channel ?? prev?.channel ?? null,
      createdAt: prev?.createdAt ?? now,
      updatedAt: now,
      lastSeenAt: partial.lastSeenAt ?? prev?.lastSeenAt ?? now,
      usages: partial.usages ?? prev?.usages ?? 0,
    }
    this.devices.set(next.serial, next)
    db.upsertDevice(next)
    this.emit('change', next)
    return next
  }

  setPresence(serial: string, presence: DevicePresence, ready = false): Device {
    const prev = this.get(serial)
    let status: DeviceStatus
    if (presence === 'present') {
      if (prev?.status === 'cleaning') status = 'cleaning'
      else if (!ready) status = 'preparing'
      else if (prev?.status === 'automation') status = 'automation'
      else status = prev?.using ? 'busy' : 'available'
    } else if (presence === 'unauthorized') {
      status = 'unauthorized'
    } else {
      status = 'offline'
    }
    return this.upsert({ serial, presence, ready, status, lastSeenAt: new Date().toISOString() })
  }

  claim(serial: string, owner: DeviceOwner, status: DeviceStatus = 'busy'): Device {
    const d = this.get(serial)
    if (!d) throw new Error('Device not found')
    if (d.presence !== 'present' || !d.ready) throw new Error('Device is not ready')
    if (d.status === 'cleaning') throw new Error('Device is being cleaned, try again in a moment')
    if (d.using && d.owner?.email !== owner.email) throw new Error('Device is in use')
    const alreadyMine = d.using && d.owner?.email === owner.email
    return this.upsert({
      serial,
      using: true,
      owner,
      status: alreadyMine ? d.status : status,
      usages: alreadyMine ? d.usages : (d.usages ?? 0) + 1,
    })
  }

  /** Marks the device free. `cleaning` keeps it unclaimable until finishCleaning(). */
  release(serial: string, email?: string, cleaning = false): Device {
    const d = this.get(serial)
    if (!d) throw new Error('Device not found')
    if (email && d.owner?.email && d.owner.email !== email) {
      throw new Error('Not the device owner')
    }
    const online = d.presence === 'present' && d.ready
    return this.upsert({
      serial,
      using: false,
      owner: null,
      status: cleaning && online ? 'cleaning' : online ? 'available' : d.status,
    })
  }

  finishCleaning(serial: string): Device | undefined {
    const d = this.get(serial)
    if (!d || d.status !== 'cleaning') return d
    const online = d.presence === 'present' && d.ready
    return this.upsert({ serial, status: online ? 'available' : 'offline' })
  }

  markAbsent(serial: string): Device {
    return this.upsert({
      serial,
      presence: 'absent',
      ready: false,
      status: 'offline',
      using: false,
      owner: null,
    })
  }
}

export const registry = new DeviceRegistry()
