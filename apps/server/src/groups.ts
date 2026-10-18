import { nanoid } from 'nanoid'
import type { Group, GroupClass, GroupState } from '@devicefarmz/core'
import * as db from './db.js'
import { registry } from './registry.js'

export function evaluateGroupState(group: Group, now = Date.now()): GroupState {
  if (group.class === 'standard' || group.class === 'quota') return 'active'
  if (!group.startTime) return 'pending'
  const start = Date.parse(group.startTime)
  const stop = group.stopTime
    ? Date.parse(group.stopTime)
    : group.durationMs
      ? start + group.durationMs
      : null
  if (Number.isNaN(start)) return 'pending'
  if (now < start) return 'ready'
  if (stop && now > stop) return 'expired'
  return 'active'
}

export function syncGroupStates(): void {
  for (const g of db.listGroups()) {
    const state = evaluateGroupState(g)
    if (state !== g.state) {
      db.upsertGroup({ ...g, state, updatedAt: new Date().toISOString() })
    }
  }
}

export function createGroup(input: {
  name: string
  class: GroupClass
  ownerEmail: string
  deviceSerials?: string[]
  userEmails?: string[]
  startTime?: string | null
  stopTime?: string | null
  repetitions?: number
  durationMs?: number | null
}): Group {
  const now = new Date().toISOString()
  const group: Group = {
    id: nanoid(),
    name: input.name,
    class: input.class,
    state: 'pending',
    ownerEmail: input.ownerEmail,
    deviceSerials: input.deviceSerials ?? [],
    userEmails: input.userEmails ?? [],
    startTime: input.startTime ?? null,
    stopTime: input.stopTime ?? null,
    repetitions: input.repetitions ?? 0,
    durationMs: input.durationMs ?? null,
    createdAt: now,
    updatedAt: now,
  }
  group.state = evaluateGroupState(group)
  db.upsertGroup(group)
  for (const serial of group.deviceSerials) {
    registry.upsert({ serial, groupId: group.id })
  }
  return group
}

export function updateGroup(id: string, patch: Partial<Group>): Group {
  const prev = db.getGroup(id)
  if (!prev) throw Object.assign(new Error('Group not found'), { status: 404 })
  const next: Group = {
    ...prev,
    ...patch,
    id: prev.id,
    updatedAt: new Date().toISOString(),
  }
  next.state = evaluateGroupState(next)
  db.upsertGroup(next)
  return next
}

export function removeGroup(id: string): boolean {
  const g = db.getGroup(id)
  if (!g) return false
  if (g.class === 'standard' && g.name) {
    /* allow deleting non-root; root protected by caller */
  }
  for (const serial of g.deviceSerials) {
    const d = registry.get(serial)
    if (d?.groupId === id) registry.upsert({ serial, groupId: null })
  }
  return db.deleteGroup(id)
}

export function userCanAccessDevice(email: string, serial: string, isAdmin: boolean): boolean {
  if (isAdmin) return true
  const device = registry.get(serial)
  if (!device) return false
  if (!device.groupId) return true
  const group = db.getGroup(device.groupId)
  if (!group) return true
  const state = evaluateGroupState(group)
  if (state !== 'active') return group.class === 'standard'
  if (group.class === 'standard') return true
  if (group.ownerEmail === email) return true
  return group.userEmails.includes(email)
}

let groupsTimer: NodeJS.Timeout | null = null

export function startGroupsEngine(): void {
  syncGroupStates()
  groupsTimer = setInterval(syncGroupStates, 15_000)
}

export function stopGroupsEngine(): void {
  if (groupsTimer) clearInterval(groupsTimer)
}
