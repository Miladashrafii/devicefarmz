import { nanoid } from 'nanoid'
import {
  filterDevices,
  type AutomationCapabilities,
  type AutomationLease,
  type AutomationSession,
  type Device,
  type Platform,
  type User,
} from '@devicefarmz/core'
import { config } from './config.js'
import * as db from './db.js'
import { emitEvent } from './events.js'
import { userCanAccessDevice } from './groups.js'
import { HttpError } from './middleware.js'
import { claimDevice, releaseDevice } from './lifecycle.js'
import { registry } from './registry.js'

export interface AcquireOptions {
  query?: string
  platform?: Platform
  serials?: string[]
  count?: number
  ttlSec?: number
  label?: string
  /** Long-poll: keep retrying for this many seconds before giving up */
  waitSec?: number
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n))

export function capabilitiesFor(d: Device): AutomationCapabilities {
  return {
    platformName: d.platform === 'ios' ? 'iOS' : 'Android',
    'appium:automationName': d.platform === 'ios' ? 'XCUITest' : 'UiAutomator2',
    'appium:udid': d.serial,
    'appium:deviceName': d.marketName || d.model,
    'appium:platformVersion': d.version,
  }
}

function candidates(user: User, opts: AcquireOptions): Device[] {
  let devices = registry
    .list()
    .filter((d) => d.presence === 'present' && d.ready && !d.using && d.status === 'available')
    .filter((d) => userCanAccessDevice(user.email, d.serial, user.role === 'admin'))
  if (opts.platform) devices = devices.filter((d) => d.platform === opts.platform)
  if (opts.serials?.length) devices = devices.filter((d) => opts.serials!.includes(d.serial))
  if (opts.query) devices = filterDevices(devices, opts.query)
  return devices.sort((a, b) => (b.battery?.level ?? 0) - (a.battery?.level ?? 0))
}

function matchingTotal(user: User, opts: AcquireOptions): number {
  let devices = registry.list().filter((d) => d.presence === 'present')
  if (opts.platform) devices = devices.filter((d) => d.platform === opts.platform)
  if (opts.serials?.length) devices = devices.filter((d) => opts.serials!.includes(d.serial))
  if (opts.query) devices = filterDevices(devices, opts.query)
  return devices.filter((d) => userCanAccessDevice(user.email, d.serial, user.role === 'admin')).length
}

function lease(session: AutomationSession): AutomationLease {
  const device = registry.get(session.serial)!
  return {
    session,
    device,
    capabilities: capabilitiesFor(device),
    adb: device.platform === 'android' ? { host: config.publicIp, serial: device.serial } : null,
  }
}

export async function acquire(user: User, opts: AcquireOptions): Promise<AutomationLease[]> {
  const count = clamp(Math.trunc(opts.count ?? 1), 1, 50)
  const ttlSec = clamp(Math.trunc(opts.ttlSec ?? 1800), 30, 86_400)
  const deadline = Date.now() + clamp(opts.waitSec ?? 0, 0, 600) * 1000

  for (;;) {
    const pool = candidates(user, opts)
    if (pool.length >= count) {
      const claimed: Device[] = []
      try {
        for (const d of pool) {
          if (claimed.length === count) break
          try {
            claimed.push(claimDevice(d.serial, user, 'automation'))
          } catch {
            /* lost a race for this device, try the next one */
          }
        }
      } catch (err) {
        for (const d of claimed) await releaseDevice(d.serial, null, { force: true }).catch(() => undefined)
        throw err
      }
      if (claimed.length === count) {
        const now = Date.now()
        return claimed.map((d) => {
          const session: AutomationSession = {
            id: `auto_${nanoid(10)}`,
            serial: d.serial,
            platform: d.platform,
            ownerEmail: user.email,
            label: opts.label?.slice(0, 120) ?? null,
            createdAt: new Date(now).toISOString(),
            expiresAt: new Date(now + ttlSec * 1000).toISOString(),
            releasedAt: null,
            appiumSessionId: null,
            ttlSec,
          }
          db.saveAutomationSession(session)
          emitEvent('automation.started', {
            sessionId: session.id,
            serial: d.serial,
            owner: user.email,
            label: session.label,
          })
          return lease(session)
        })
      }
      for (const d of claimed) await releaseDevice(d.serial, null, { force: true }).catch(() => undefined)
    }
    if (Date.now() >= deadline) {
      throw new HttpError(409, `Only ${pool.length} of ${count} requested device(s) are available`, {
        available: pool.length,
        matching: matchingTotal(user, opts),
      })
    }
    await sleep(1000)
  }
}

function assertOwner(session: AutomationSession, user: User | null): void {
  if (user && user.role !== 'admin' && user.email !== session.ownerEmail) {
    throw new HttpError(403, 'Not your session')
  }
}

export function getSession(id: string, user: User | null): AutomationSession {
  const session = db.getAutomationSession(id)
  if (!session) throw new HttpError(404, 'Session not found')
  assertOwner(session, user)
  return session
}

export function listSessions(user: User, activeOnly = false): AutomationSession[] {
  const all = db.listAutomationSessions(activeOnly)
  return user.role === 'admin' ? all : all.filter((s) => s.ownerEmail === user.email)
}

export function heartbeat(id: string, user: User | null): AutomationSession {
  const session = getSession(id, user)
  if (session.releasedAt) throw new HttpError(410, 'Session already ended')
  session.expiresAt = new Date(Date.now() + session.ttlSec * 1000).toISOString()
  db.saveAutomationSession(session)
  return session
}

export function attachAppiumSession(id: string, appiumSessionId: string): void {
  const session = db.getAutomationSession(id)
  if (!session) return
  session.appiumSessionId = appiumSessionId
  db.saveAutomationSession(session)
}

export async function releaseSession(
  id: string,
  user: User | null,
  reason: 'released' | 'expired' | 'appium-closed' = 'released',
): Promise<AutomationSession> {
  const session = getSession(id, user)
  if (session.releasedAt) return session
  session.releasedAt = new Date().toISOString()
  db.saveAutomationSession(session)
  await releaseDevice(session.serial, null, { force: true }).catch(() => undefined)
  emitEvent('automation.ended', {
    sessionId: session.id,
    serial: session.serial,
    owner: session.ownerEmail,
    reason,
  })
  return session
}

let sweeper: NodeJS.Timeout | null = null

/** Sessions that were active during a restart no longer hold their devices */
export function recoverSessions(): void {
  for (const s of db.listAutomationSessions(true)) {
    s.releasedAt = new Date().toISOString()
    db.saveAutomationSession(s)
  }
}

export function startAutomationSweeper(): void {
  if (sweeper) return
  sweeper = setInterval(() => {
    const now = Date.now()
    for (const s of db.listAutomationSessions(true)) {
      if (Date.parse(s.expiresAt) <= now) void releaseSession(s.id, null, 'expired').catch(() => undefined)
    }
  }, 5000)
}

export function stopAutomationSweeper(): void {
  if (sweeper) clearInterval(sweeper)
  sweeper = null
}
