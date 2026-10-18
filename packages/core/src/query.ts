/**
 * Lightweight device query language.
 * Examples: "android>=12", "manufacturer:samsung", "battery<20", "available", "owner:alice", "platform:ios"
 */

import type { Device } from './types.js'

type Predicate = (device: Device) => boolean

function parseClause(raw: string): Predicate {
  const clause = raw.trim()
  if (!clause) return () => true

  if (clause === 'available') return (d) => d.status === 'available' && d.ready && !d.using
  if (clause === 'busy' || clause === 'using') return (d) => d.using
  if (clause === 'offline') return (d) => d.presence === 'offline' || d.presence === 'absent'
  if (clause === 'present') return (d) => d.presence === 'present'
  if (clause === 'ready') return (d) => d.ready

  const cmp = clause.match(/^(\w+)\s*(>=|<=|>|<|=|:)\s*(.+)$/i)
  if (cmp) {
    const [, field, op, valueRaw] = cmp
    const value = valueRaw.trim().replace(/^["']|["']$/g, '')
    return (d) => compareField(d, field.toLowerCase(), op, value)
  }

  const needle = clause.toLowerCase()
  return (d) =>
    [
      d.serial,
      d.model,
      d.manufacturer,
      d.marketName,
      d.product,
      d.version,
      d.notes,
      d.platform,
      d.phone.phoneNumber,
      d.phone.imei,
      d.phone.iccid,
      d.owner?.email,
      d.owner?.name,
      d.groupId,
    ]
      .filter(Boolean)
      .some((v) => String(v).toLowerCase().includes(needle))
}

function majorVersion(version: string): number {
  const n = parseFloat(version)
  return Number.isNaN(n) ? -1 : n
}

function compareField(d: Device, field: string, op: string, value: string): boolean {
  const get = (): string | number | null => {
    switch (field) {
      case 'android':
      case 'ios':
      case 'version':
      case 'os':
        if ((field === 'android' && d.platform !== 'android') || (field === 'ios' && d.platform !== 'ios')) {
          return null
        }
        return majorVersion(d.version)
      case 'sdk':
        return d.sdk
      case 'battery':
        return d.battery?.level ?? -1
      case 'manufacturer':
      case 'maker':
        return d.manufacturer
      case 'model':
        return d.model + ' ' + (d.marketName ?? '')
      case 'product':
        return d.product
      case 'serial':
        return d.serial
      case 'platform':
        return d.platform
      case 'operator':
      case 'network':
        return d.phone.network
      case 'imei':
        return d.phone.imei
      case 'iccid':
        return d.phone.iccid
      case 'phone':
        return d.phone.phoneNumber
      case 'owner':
        return d.owner?.email ?? d.owner?.name ?? ''
      case 'group':
        return d.groupId
      case 'abi':
        return d.abi
      default:
        return null
    }
  }

  const left = get()
  if (left === null) return false

  if (op === ':' || op === '=') {
    if (typeof left === 'number') return left === Number(value)
    return String(left).toLowerCase().includes(value.toLowerCase())
  }

  const ln = typeof left === 'number' ? left : Number(String(left).replace(/[^\d.]/g, ''))
  const rn = Number(value.replace(/[^\d.]/g, ''))
  if (Number.isNaN(ln) || Number.isNaN(rn)) {
    return String(left).toLowerCase() === value.toLowerCase()
  }
  if (op === '>') return ln > rn
  if (op === '>=') return ln >= rn
  if (op === '<') return ln < rn
  if (op === '<=') return ln <= rn
  return false
}

export function compileDeviceQuery(query: string): Predicate {
  const parts = query
    .split(/\s+/)
    .map((p) => p.trim())
    .filter(Boolean)
  if (!parts.length) return () => true
  const predicates = parts.map(parseClause)
  return (device) => predicates.every((p) => p(device))
}

export function filterDevices(devices: Device[], query: string): Device[] {
  const pred = compileDeviceQuery(query)
  return devices.filter(pred)
}
