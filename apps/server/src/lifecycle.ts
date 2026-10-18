import type { Device, DeviceStatus, User } from '@devicefarmz/core'
import { config } from './config.js'
import { emitEvent } from './events.js'
import { userCanAccessDevice } from './groups.js'
import { isRecording, startRecording, stopRecording } from './recorder.js'
import { registry } from './registry.js'
import { getWorker } from './workers.js'

const pendingReleases = new Map<string, NodeJS.Timeout>()

function cancelPending(serial: string): void {
  const t = pendingReleases.get(serial)
  if (t) clearTimeout(t)
  pendingReleases.delete(serial)
}

export function claimDevice(serial: string, user: User, status: DeviceStatus = 'busy'): Device {
  if (!userCanAccessDevice(user.email, serial, user.role === 'admin')) {
    throw new Error('Access denied for this device group')
  }
  cancelPending(serial)
  const before = registry.get(serial)
  const device = registry.claim(serial, { email: user.email, name: user.name }, status)
  if (config.autoRecord && status === 'busy' && !before?.using && !isRecording(serial)) {
    void startRecording(serial, user.email, 'auto').catch((err) =>
      console.warn('[recorder] auto-record failed:', err.message),
    )
  }
  return device
}

/**
 * Frees a device and, depending on DEVICEFARMZ_RESET_MODE, wipes user data before it
 * becomes available again. The device stays in the `cleaning` state meanwhile.
 */
export async function releaseDevice(serial: string, user: User | null, opts: { force?: boolean } = {}): Promise<Device> {
  const prev = registry.get(serial)
  if (!prev) throw new Error('Device not found')
  cancelPending(serial)
  await stopRecording(serial)

  const worker = getWorker(serial)
  const shouldReset = config.resetMode !== 'none' && Boolean(worker) && prev.using
  const ownerCheck = opts.force || !user || user.role === 'admin' ? undefined : user.email
  const device = registry.release(serial, ownerCheck, shouldReset)

  if (shouldReset && worker) void runReset(serial)
  return device
}

async function runReset(serial: string): Promise<void> {
  const worker = getWorker(serial)
  try {
    if (worker && config.resetMode !== 'none') {
      const report = await worker.reset(config.resetMode)
      emitEvent('device.reset', { serial, mode: config.resetMode, ...report })
    }
  } catch (err) {
    emitEvent('device.reset', { serial, mode: config.resetMode, cleaned: [], notes: [], errors: [(err as Error).message] })
  } finally {
    registry.finishCleaning(serial)
  }
}

/** Releases after a grace period unless the same user comes back (page reload, flaky network) */
export function scheduleRelease(serial: string, email: string, delayMs = config.releaseGraceMs): void {
  cancelPending(serial)
  pendingReleases.set(
    serial,
    setTimeout(() => {
      pendingReleases.delete(serial)
      const d = registry.get(serial)
      if (d?.using && d.owner?.email === email && d.status === 'busy') {
        void releaseDevice(serial, null, { force: true }).catch(() => undefined)
      }
    }, delayMs),
  )
}

export function cancelAllPendingReleases(): void {
  for (const t of pendingReleases.values()) clearTimeout(t)
  pendingReleases.clear()
}
