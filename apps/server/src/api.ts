import fs from 'node:fs'
import path from 'node:path'
import express, { Router, type NextFunction, type Request, type Response } from 'express'
import cors from 'cors'
import multer from 'multer'
import { nanoid } from 'nanoid'
import { APP_NAME, APP_VERSION, filterDevices, fleetMatrix, recommendCoverage, type User } from '@devicefarmz/core'
import { interpret } from './assist.js'
import { acquire, getSession, heartbeat, listSessions, releaseSession } from './automation.js'
import { mockLogin } from './auth.js'
import { config, scrcpyAvailable, uploadsDir } from './config.js'
import * as db from './db.js'
import { createGroup, removeGroup, updateGroup, userCanAccessDevice } from './groups.js'
import { claimDevice, releaseDevice } from './lifecycle.js'
import { metricsText, snapshot } from './metrics.js'
import { HttpError, adminMiddleware, authMiddleware, wrap } from './middleware.js'
import { isRecording, recordingFile, removeRecording, startRecording, stopRecording } from './recorder.js'
import { registry } from './registry.js'
import { authProviders, ldapLogin, oidcCallback, oidcLoginUrl, throttle } from './sso.js'
import { createApiToken, listApiTokens, revokeApiToken } from './tokens.js'
import { EVENT_TYPES, createWebhook, deleteWebhook, listWebhooks, recentDeliveries, sendTest } from './webhooks.js'
import { requireWorker } from './workers.js'

/** The caller must hold the device (or be an admin) before touching it */
export function assertOperator(user: User, serial: string): void {
  const d = registry.get(serial)
  if (!d) throw new HttpError(404, 'Device not found')
  if (!userCanAccessDevice(user.email, serial, user.role === 'admin')) {
    throw new HttpError(403, 'Access denied for this device group')
  }
  if (user.role === 'admin') return
  if (!d.using) throw new HttpError(409, 'Claim the device first (POST /api/devices/:serial/use)')
  if (d.owner?.email !== user.email) throw new HttpError(403, 'Device is in use by someone else')
}

export function createApiRouter(): Router {
  fs.mkdirSync(uploadsDir(), { recursive: true })
  const upload = multer({ dest: uploadsDir(), limits: { fileSize: 2 * 1024 ** 3 } })
  const router = Router()
  const auth = authMiddleware
  const admin = [authMiddleware, adminMiddleware]

  router.use(cors({ origin: true, credentials: true }))
  router.use(express.json({ limit: '10mb' }))

  // ------------------------------------------------------------ public

  router.get('/health', (_req, res) => {
    res.json({ ok: true, name: 'devicefarmz', uptime: process.uptime() })
  })

  router.get(
    '/metrics',
    wrap(async (_req, res) => {
      res.set('Content-Type', 'text/plain')
      res.send(await metricsText())
    }),
  )

  router.get('/config', (_req, res) => {
    res.json({
      name: APP_NAME,
      version: APP_VERSION,
      auth: authProviders(),
      features: {
        h264: scrcpyAvailable(),
        resetMode: config.resetMode,
        autoRecord: config.autoRecord,
        ios: config.ios.enabled,
        simulator: config.fakeDevices > 0,
        llm: Boolean(config.llm.url),
      },
    })
  })

  // ------------------------------------------------------------ auth

  router.get('/auth/providers', (_req, res) => {
    res.json(authProviders())
  })

  router.post('/auth/mock', (req, res) => {
    if (!config.mockAuth) throw new HttpError(403, 'Mock auth is disabled')
    res.json(mockLogin(String(req.body.name || 'User'), String(req.body.email || 'user@local.dev')))
  })

  router.get(
    '/auth/oidc/login',
    wrap(async (_req, res) => {
      res.redirect(await oidcLoginUrl())
    }),
  )

  router.get(
    '/auth/oidc/callback',
    wrap(async (req, res) => {
      try {
        const session = await oidcCallback(req.originalUrl.split('?')[1] ?? '')
        // Fragment keeps the token out of server logs and Referer headers
        res.redirect(`/login#token=${encodeURIComponent(session.token)}`)
      } catch (err) {
        res.redirect(`/login#error=${encodeURIComponent((err as Error).message)}`)
      }
    }),
  )

  router.post(
    '/auth/ldap',
    wrap(async (req, res) => {
      const username = String(req.body.username ?? '')
      throttle(`ldap:${req.ip}:${username.toLowerCase()}`)
      res.json(await ldapLogin(username, String(req.body.password ?? '')))
    }),
  )

  router.get('/auth/me', auth, (req, res) => {
    res.json(req.user)
  })

  router.get('/stats', auth, (_req, res) => {
    res.json(snapshot())
  })

  // ------------------------------------------------------------ devices

  router.get('/devices', auth, (req, res) => {
    const q = String(req.query.q || '')
    let devices = registry.list()
    if (q) devices = filterDevices(devices, q)
    if (req.user!.role !== 'admin') {
      devices = devices.filter((d) => userCanAccessDevice(req.user!.email, d.serial, false))
    }
    res.json({ devices })
  })

  router.get('/devices/:serial', auth, (req, res) => {
    const device = registry.get(req.params.serial)
    if (!device) throw new HttpError(404, 'Not found')
    res.json(device)
  })

  router.post('/devices/:serial/use', auth, (req, res) => {
    try {
      res.json(claimDevice(req.params.serial, req.user!))
    } catch (err) {
      throw new HttpError(409, err instanceof Error ? err.message : String(err))
    }
  })

  router.delete(
    '/devices/:serial/owner',
    auth,
    wrap(async (req, res) => {
      try {
        res.json(await releaseDevice(req.params.serial, req.user!))
      } catch (err) {
        throw new HttpError(409, err instanceof Error ? err.message : String(err))
      }
    }),
  )

  router.post('/devices/:serial/note', auth, (req, res) => {
    assertOperator(req.user!, req.params.serial)
    res.json(registry.upsert({ serial: req.params.serial, notes: String(req.body.notes || '').slice(0, 500) }))
  })

  router.post(
    '/devices/:serial/reboot',
    auth,
    wrap(async (req, res) => {
      assertOperator(req.user!, req.params.serial)
      await requireWorker(req.params.serial).reboot()
      res.json({ ok: true })
    }),
  )

  router.post(
    '/devices/:serial/identify',
    auth,
    wrap(async (req, res) => {
      const d = registry.get(req.params.serial)
      if (!d) throw new HttpError(404, 'Not found')
      // Identifying a free device is allowed for any user; a busy one only for its holder
      if (d.using) assertOperator(req.user!, req.params.serial)
      await requireWorker(req.params.serial).identify()
      res.json({ ok: true })
    }),
  )

  router.get(
    '/devices/:serial/browsers',
    auth,
    wrap(async (req, res) => {
      assertOperator(req.user!, req.params.serial)
      res.json({ browsers: await requireWorker(req.params.serial).browsers() })
    }),
  )

  router.post(
    '/devices/:serial/browser',
    auth,
    wrap(async (req, res) => {
      assertOperator(req.user!, req.params.serial)
      await requireWorker(req.params.serial).openBrowser(String(req.body.url), req.body.packageName)
      res.json({ ok: true })
    }),
  )

  router.post(
    '/devices/:serial/install',
    auth,
    upload.single('apk'),
    wrap(async (req, res) => {
      assertOperator(req.user!, req.params.serial)
      if (!req.file) throw new HttpError(400, 'apk file required')
      try {
        res.json({ ok: true, output: await requireWorker(req.params.serial).installApp(req.file.path, req.file.originalname) })
      } finally {
        fs.rm(req.file.path, { force: true }, () => undefined)
      }
    }),
  )

  router.get(
    '/devices/:serial/files',
    auth,
    wrap(async (req, res) => {
      assertOperator(req.user!, req.params.serial)
      const remotePath = String(req.query.path || '/sdcard')
      res.json({ path: remotePath, entries: await requireWorker(req.params.serial).listFiles(remotePath) })
    }),
  )

  router.get(
    '/devices/:serial/accounts',
    auth,
    wrap(async (req, res) => {
      assertOperator(req.user!, req.params.serial)
      res.json({ accounts: await requireWorker(req.params.serial).accounts() })
    }),
  )

  router.post(
    '/devices/:serial/shell',
    auth,
    wrap(async (req, res) => {
      assertOperator(req.user!, req.params.serial)
      let output = ''
      const code = await requireWorker(req.params.serial).shell(String(req.body.command || ''), (c) => (output += c))
      res.status(code === 0 ? 200 : 500).json({ output, code })
    }),
  )

  router.delete('/devices/:serial', ...admin, (req, res) => {
    res.json({ ok: db.deleteDevice(req.params.serial) })
  })

  // ------------------------------------------------------------ users

  router.get('/users', ...admin, (_req, res) => {
    res.json({ users: db.listUsers() })
  })

  router.post('/users', ...admin, (req, res) => {
    const email = String(req.body.email || '').toLowerCase()
    const name = String(req.body.name || email)
    if (!email) throw new HttpError(400, 'email required')
    if (db.getUserByEmail(email)) throw new HttpError(409, 'User exists')
    const user: User = {
      id: nanoid(),
      email,
      name,
      role: req.body.role === 'admin' ? 'admin' : 'user',
      groupQuota: Number(req.body.groupQuota ?? 5),
      createdAt: new Date().toISOString(),
      lastLoginAt: null,
    }
    db.insertUser(user)
    res.status(201).json(user)
  })

  router.delete('/users/:id', ...admin, (req, res) => {
    if (req.params.id === req.user!.id) throw new HttpError(400, 'Cannot delete yourself')
    res.json({ ok: db.deleteUser(req.params.id) })
  })

  router.patch('/users/:id/quota', ...admin, (req, res) => {
    const user = db.getUserById(req.params.id)
    if (!user) throw new HttpError(404, 'Not found')
    const next = { ...user, groupQuota: Number(req.body.groupQuota ?? user.groupQuota) }
    db.updateUser(next)
    res.json(next)
  })

  // ------------------------------------------------------------ groups

  router.get('/groups', auth, (_req, res) => {
    res.json({ groups: db.listGroups() })
  })

  router.post('/groups', auth, (req, res) => {
    const user = req.user!
    const owned = db.listGroups().filter((g) => g.ownerEmail === user.email).length
    if (user.role !== 'admin' && owned >= user.groupQuota) throw new HttpError(403, 'Group quota exceeded')
    res.status(201).json(
      createGroup({
        name: String(req.body.name || 'Untitled'),
        class: req.body.class || 'bookable',
        ownerEmail: user.email,
        deviceSerials: req.body.deviceSerials || [],
        userEmails: req.body.userEmails || [],
        startTime: req.body.startTime || null,
        stopTime: req.body.stopTime || null,
        repetitions: req.body.repetitions || 0,
        durationMs: req.body.durationMs || null,
      }),
    )
  })

  router.patch('/groups/:id', auth, (req, res) => {
    const prev = db.getGroup(req.params.id)
    if (!prev) throw new HttpError(404, 'Not found')
    if (req.user!.role !== 'admin' && prev.ownerEmail !== req.user!.email) throw new HttpError(403, 'Not owner')
    res.json(updateGroup(req.params.id, req.body))
  })

  router.delete('/groups/:id', auth, (req, res) => {
    const prev = db.getGroup(req.params.id)
    if (!prev) throw new HttpError(404, 'Not found')
    if (prev.name === config.rootGroupName && prev.class === 'standard') {
      throw new HttpError(400, 'Cannot delete root group')
    }
    if (req.user!.role !== 'admin' && prev.ownerEmail !== req.user!.email) throw new HttpError(403, 'Not owner')
    res.json({ ok: removeGroup(req.params.id) })
  })

  // ------------------------------------------------------------ storage

  router.post('/storage', auth, upload.single('file'), (req, res) => {
    if (!req.file) throw new HttpError(400, 'file required')
    res.status(201).json({
      id: path.basename(req.file.path),
      originalName: req.file.originalname,
      size: req.file.size,
    })
  })

  // ------------------------------------------------------------ API tokens

  router.get('/tokens', auth, (req, res) => {
    res.json({ tokens: listApiTokens(req.user!.id) })
  })

  router.post('/tokens', auth, (req, res) => {
    const { token, info } = createApiToken(req.user!, String(req.body.title ?? ''))
    // The raw token is shown exactly once
    res.status(201).json({ token, info })
  })

  router.delete('/tokens/:id', auth, (req, res) => {
    res.json({ ok: revokeApiToken(req.params.id, req.user!) })
  })

  // ------------------------------------------------------------ webhooks (admin)

  router.get('/webhooks', ...admin, (_req, res) => {
    res.json({ webhooks: listWebhooks(), events: EVENT_TYPES })
  })

  router.get('/webhooks/deliveries', ...admin, (_req, res) => {
    res.json({ deliveries: recentDeliveries() })
  })

  router.post('/webhooks', ...admin, (req, res) => {
    try {
      const events = Array.isArray(req.body.events) ? req.body.events.map(String) : []
      const { hook, secret } = createWebhook(String(req.body.url ?? ''), events, req.user!.email)
      res.status(201).json({ webhook: hook, secret })
    } catch (err) {
      throw new HttpError(400, (err as Error).message)
    }
  })

  router.delete('/webhooks/:id', ...admin, (req, res) => {
    res.json({ ok: deleteWebhook(req.params.id) })
  })

  router.post(
    '/webhooks/:id/test',
    ...admin,
    wrap(async (req, res) => {
      try {
        res.json(await sendTest(req.params.id))
      } catch (err) {
        throw new HttpError(404, (err as Error).message)
      }
    }),
  )

  // ------------------------------------------------------------ automation / CI

  router.post(
    '/automation/sessions',
    auth,
    wrap(async (req, res) => {
      const b = req.body ?? {}
      const leases = await acquire(req.user!, {
        query: typeof b.query === 'string' ? b.query : undefined,
        platform: b.platform === 'ios' || b.platform === 'android' ? b.platform : undefined,
        serials: Array.isArray(b.serials) ? b.serials.map(String) : undefined,
        count: b.count,
        ttlSec: b.ttlSec,
        waitSec: b.waitSec,
        label: typeof b.label === 'string' ? b.label : undefined,
      })
      res.status(201).json({ leases, lease: leases[0] })
    }),
  )

  router.get('/automation/sessions', auth, (req, res) => {
    res.json({ sessions: listSessions(req.user!, req.query.active === '1') })
  })

  router.get('/automation/sessions/:id', auth, (req, res) => {
    res.json(getSession(req.params.id, req.user!))
  })

  router.post('/automation/sessions/:id/heartbeat', auth, (req, res) => {
    res.json(heartbeat(req.params.id, req.user!))
  })

  router.delete(
    '/automation/sessions/:id',
    auth,
    wrap(async (req, res) => {
      res.json(await releaseSession(req.params.id, req.user!))
    }),
  )

  // ------------------------------------------------------------ recordings

  router.get('/recordings', auth, (req, res) => {
    const all = db.listRecordings()
    res.json({ recordings: req.user!.role === 'admin' ? all : all.filter((r) => r.ownerEmail === req.user!.email) })
  })

  function ownedRecording(req: Request) {
    const rec = db.getRecording(String(req.params.id))
    if (!rec) throw new HttpError(404, 'Recording not found')
    if (req.user!.role !== 'admin' && rec.ownerEmail !== req.user!.email) throw new HttpError(403, 'Not your recording')
    return rec
  }

  router.post(
    '/recordings/start',
    auth,
    wrap(async (req, res) => {
      assertOperator(req.user!, String(req.body.serial))
      res.status(201).json(await startRecording(String(req.body.serial), req.user!.email, req.body.note))
    }),
  )

  router.post(
    '/recordings/stop',
    auth,
    wrap(async (req, res) => {
      assertOperator(req.user!, String(req.body.serial))
      const rec = await stopRecording(String(req.body.serial))
      if (!rec) throw new HttpError(404, 'No active recording for this device')
      res.json(rec)
    }),
  )

  router.get('/devices/:serial/recording', auth, (req, res) => {
    res.json({ recording: isRecording(req.params.serial) })
  })

  router.get('/recordings/:id/video', auth, (req, res) => {
    const rec = ownedRecording(req)
    const file = recordingFile(rec, 'video')
    if (!file) throw new HttpError(404, 'No video for this recording')
    res.type(rec.videoFormat === 'mp4' ? 'video/mp4' : 'video/h264').sendFile(file)
  })

  router.get('/recordings/:id/log', auth, (req, res) => {
    const file = recordingFile(ownedRecording(req), 'log')
    if (!file) throw new HttpError(404, 'No log for this recording')
    res.type('text/plain').sendFile(file)
  })

  router.delete('/recordings/:id', auth, (req, res) => {
    const rec = ownedRecording(req)
    res.json({ ok: removeRecording(rec.id) })
  })

  // ------------------------------------------------------------ assistant

  router.post(
    '/assist/query',
    auth,
    wrap(async (req, res) => {
      const text = String(req.body.text ?? '')
      if (!text.trim()) throw new HttpError(400, 'text required')
      const interpretation = await interpret(text)
      const visible = registry
        .list()
        .filter((d) => userCanAccessDevice(req.user!.email, d.serial, req.user!.role === 'admin'))
      res.json({ ...interpretation, devices: filterDevices(visible, interpretation.query) })
    }),
  )

  router.post(
    '/assist/recommend',
    auth,
    wrap(async (req, res) => {
      const b = req.body ?? {}
      let pool = registry
        .list()
        .filter((d) => userCanAccessDevice(req.user!.email, d.serial, req.user!.role === 'admin'))
      let interpretation = null
      if (typeof b.text === 'string' && b.text.trim()) {
        interpretation = await interpret(b.text)
        pool = filterDevices(pool, interpretation.query)
      }
      const report = recommendCoverage(pool, Math.min(Math.max(Number(b.count) || 3, 1), 20), {
        minSdk: b.minSdk !== undefined ? Number(b.minSdk) : undefined,
        maxSdk: b.maxSdk !== undefined ? Number(b.maxSdk) : undefined,
        availableOnly: Boolean(b.availableOnly),
        platform: b.platform === 'ios' || b.platform === 'android' ? b.platform : undefined,
      })
      res.json({ ...report, interpretation })
    }),
  )

  router.get('/assist/matrix', auth, (req, res) => {
    const visible = registry
      .list()
      .filter((d) => userCanAccessDevice(req.user!.email, d.serial, req.user!.role === 'admin'))
    res.json(fleetMatrix(visible))
  })

  // ------------------------------------------------------------ errors

  router.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof HttpError) {
      res.status(err.status).json({ error: err.message, ...(err.extra ?? {}) })
      return
    }
    const message = err instanceof Error ? err.message : String(err)
    const status = (err as { status?: number })?.status ?? 500
    if (status >= 500) console.error('[api]', err)
    res.status(status).json({ error: message })
  })

  return router
}
