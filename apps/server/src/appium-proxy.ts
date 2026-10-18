/**
 * Appium gateway.
 *
 * Point any Appium/WebDriver client at `http://<hub>/appium` (token as basic-auth password or
 * Bearer). On `POST /session` the hub reserves a matching device, injects its UDID into the
 * capabilities and forwards the request to the Appium server configured with
 * DEVICEFARMZ_APPIUM_URL. The device is released when the session is deleted or the lease expires.
 *
 * Optional capabilities understood by the gateway (removed before forwarding):
 *   devicefarmz:query    farm search query, e.g. "samsung android>=12"
 *   devicefarmz:ttl      lease length in seconds (extended on every command)
 *   devicefarmz:waitSec  wait for a matching device instead of failing immediately
 *   devicefarmz:label    free-text label shown in the UI (e.g. CI job name)
 */
import express, { Router, type Request, type Response } from 'express'
import type { Platform } from '@devicefarmz/core'
import { acquire, attachAppiumSession, heartbeat, releaseSession } from './automation.js'
import { config } from './config.js'
import { HttpError, authMiddleware, wrap } from './middleware.js'

type Caps = Record<string, unknown>

/** appium session id -> farm lease id */
const leases = new Map<string, string>()

function w3cError(res: Response, status: number, error: string, message: string): void {
  res.status(status).json({ value: { error, message, stacktrace: '' } })
}

function extractCaps(body: Record<string, any>): { merged: Caps; always: Caps | null } {
  const always = (body?.capabilities?.alwaysMatch as Caps | undefined) ?? null
  const first = (body?.capabilities?.firstMatch?.[0] as Caps | undefined) ?? {}
  const legacy = (body?.desiredCapabilities as Caps | undefined) ?? {}
  return { merged: { ...legacy, ...first, ...(always ?? {}) }, always }
}

function stripCustom(caps: Caps): Caps {
  return Object.fromEntries(Object.entries(caps).filter(([k]) => !k.startsWith('devicefarmz:')))
}

async function forward(method: string, path: string, body?: unknown): Promise<{ status: number; text: string }> {
  const base = config.appiumUrl.replace(/\/$/, '')
  const res = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined || method === 'GET' || method === 'DELETE' ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(10 * 60_000),
  })
  return { status: res.status, text: await res.text() }
}

function sessionIdFrom(text: string): string | null {
  try {
    const json = JSON.parse(text)
    return json?.value?.sessionId ?? json?.sessionId ?? null
  } catch {
    return null
  }
}

export function createAppiumRouter(): Router {
  const router = Router()
  router.use(express.json({ limit: '50mb' }))
  router.use(authMiddleware)

  router.post(
    '/session',
    wrap(async (req: Request, res: Response) => {
      const body = (req.body ?? {}) as Record<string, any>
      const { merged, always } = extractCaps(body)

      const platformName = String(merged.platformName ?? merged['appium:platformName'] ?? '').toLowerCase()
      const platform: Platform | undefined = platformName.includes('ios')
        ? 'ios'
        : platformName.includes('android')
          ? 'android'
          : undefined
      const clauses: string[] = []
      if (typeof merged['devicefarmz:query'] === 'string') clauses.push(merged['devicefarmz:query'])
      const version = merged['appium:platformVersion'] ?? merged.platformVersion
      if (version && platform) clauses.push(`${platform}=${String(version)}`)
      const udid = merged['appium:udid'] ?? merged.udid

      let leaseResult
      try {
        leaseResult = (
          await acquire(req.user!, {
            platform,
            query: clauses.join(' '),
            serials: typeof udid === 'string' ? [udid] : undefined,
            ttlSec: Number(merged['devicefarmz:ttl'] ?? 1800),
            waitSec: Number(merged['devicefarmz:waitSec'] ?? 0),
            label: typeof merged['devicefarmz:label'] === 'string' ? merged['devicefarmz:label'] : 'appium',
          })
        )[0]
      } catch (err) {
        if (err instanceof HttpError) return w3cError(res, 500, 'session not created', err.message)
        throw err
      }

      const device = leaseResult.device
      const injected = {
        'appium:udid': device.serial,
        'appium:deviceName': device.marketName || device.model,
      }
      const forwardBody: Record<string, any> = { ...body }
      if (body.capabilities) {
        forwardBody.capabilities = {
          ...body.capabilities,
          alwaysMatch: { ...stripCustom(always ?? {}), ...injected },
        }
        if (Array.isArray(body.capabilities.firstMatch)) {
          forwardBody.capabilities.firstMatch = body.capabilities.firstMatch.map((c: Caps) => stripCustom(c))
        }
      }
      if (body.desiredCapabilities) {
        forwardBody.desiredCapabilities = { ...stripCustom(body.desiredCapabilities), udid: device.serial }
      }
      if (!body.capabilities && !body.desiredCapabilities) {
        forwardBody.capabilities = { alwaysMatch: injected }
      }

      let upstream
      try {
        upstream = await forward('POST', '/session', forwardBody)
      } catch (err) {
        await releaseSession(leaseResult.session.id, null).catch(() => undefined)
        return w3cError(res, 502, 'session not created', `Appium server unreachable: ${(err as Error).message}`)
      }

      const sid = upstream.status < 400 ? sessionIdFrom(upstream.text) : null
      if (!sid) {
        await releaseSession(leaseResult.session.id, null).catch(() => undefined)
        return void res.status(upstream.status).type('application/json').send(upstream.text)
      }
      leases.set(sid, leaseResult.session.id)
      attachAppiumSession(leaseResult.session.id, sid)
      res.status(upstream.status).type('application/json').send(upstream.text)
    }),
  )

  const proxy = wrap(async (req: Request, res: Response) => {
    const sid = String(req.params.sid)
    const farmId = leases.get(sid)
    if (!farmId) return w3cError(res, 404, 'invalid session id', `Unknown session ${sid}`)
    try {
      heartbeat(farmId, null)
    } catch {
      leases.delete(sid)
      return w3cError(res, 404, 'invalid session id', 'The device lease for this session has ended')
    }

    const suffix = req.originalUrl.slice(req.baseUrl.length).replace(/\?.*$/, '')
    let upstream
    try {
      upstream = await forward(req.method, suffix, req.body)
    } catch (err) {
      return w3cError(res, 502, 'unknown error', `Appium server unreachable: ${(err as Error).message}`)
    }

    const isDeleteSession = req.method === 'DELETE' && suffix === `/session/${sid}`
    if (isDeleteSession) {
      leases.delete(sid)
      await releaseSession(farmId, null, 'appium-closed').catch(() => undefined)
    }
    res.status(upstream.status).type('application/json').send(upstream.text)
  })

  router.all('/session/:sid', proxy)
  router.all('/session/:sid/*', proxy)

  router.get(
    '/status',
    wrap(async (_req, res) => {
      try {
        const upstream = await forward('GET', '/status')
        res.status(upstream.status).type('application/json').send(upstream.text)
      } catch (err) {
        w3cError(res, 502, 'unknown error', `Appium server unreachable: ${(err as Error).message}`)
      }
    }),
  )

  return router
}
