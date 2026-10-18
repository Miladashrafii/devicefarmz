import fs from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import express from 'express'
import { APP_NAME, APP_VERSION } from '@devicefarmz/core'
import { createApiRouter } from './api.js'
import { createAppiumRouter } from './appium-proxy.js'
import { recoverSessions, startAutomationSweeper, stopAutomationSweeper } from './automation.js'
import { config, scrcpyAvailable, uploadsDir } from './config.js'
import { closeDb, initDb } from './db.js'
import { startEventBridge } from './events.js'
import { startGroupsEngine, stopGroupsEngine } from './groups.js'
import { cancelAllPendingReleases } from './lifecycle.js'
import { stopAllRecordings } from './recorder.js'
import { registry } from './registry.js'
import { startWebhooks, stopWebhooks } from './webhooks.js'
import { buildProviders, providers } from './workers.js'
import { wsHub } from './ws-hub.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

export interface HubHandle {
  server: http.Server
  port: number
}

export async function startHub(opts?: { port?: number; publicIp?: string }): Promise<HubHandle> {
  if (opts?.publicIp) process.env.DEVICEFARMZ_PUBLIC_IP = opts.publicIp

  if (config.jwtSecret === 'devicefarmz-dev-secret-change-me' && !config.mockAuth) {
    throw new Error('Set DEVICEFARMZ_JWT_SECRET to a long random value before enabling real authentication.')
  }
  if (config.jwtSecret === 'devicefarmz-dev-secret-change-me') {
    console.warn('[hub] using the built-in development JWT secret; set DEVICEFARMZ_JWT_SECRET for anything shared')
  }

  initDb()
  registry.load()
  recoverSessions()
  fs.mkdirSync(uploadsDir(), { recursive: true })

  const app = express()
  app.disable('x-powered-by')
  app.use('/api', createApiRouter())
  const appium = createAppiumRouter()
  app.use('/appium', appium)
  app.use('/wd/hub', appium)

  const webDist = path.resolve(__dirname, '../../web/dist')
  if (fs.existsSync(webDist)) {
    app.use(express.static(webDist))
    app.get('*', (req, res, next) => {
      if (req.path.startsWith('/api') || req.path.startsWith('/ws')) return next()
      res.sendFile(path.join(webDist, 'index.html'))
    })
  } else {
    app.get('/', (_req, res) => {
      res.type('html').send(`<!doctype html>
<html><head><meta charset="utf-8"><title>${APP_NAME}</title></head>
<body style="font-family:system-ui;padding:2rem;background:#0b1220;color:#e8eefc">
<h1>${APP_NAME}</h1>
<p>API is up. Build the web UI with <code>npm run build</code> or run <code>npm run dev</code>.</p>
<p>Health: <a href="/api/health" style="color:#7dd3fc">/api/health</a></p>
</body></html>`)
    })
  }

  // Bind the port first so a conflict fails fast, before any device workers are started
  const server = http.createServer(app)
  const requested = opts?.port ?? config.hubPort
  await new Promise<void>((resolve, reject) => {
    server.once('error', (err: NodeJS.ErrnoException) => {
      const busy = err.code === 'EADDRINUSE'
      reject(busy ? new Error('Port ' + requested + ' is already in use (use --port or DEVICEFARMZ_PORT)') : err)
    })
    server.listen(requested, resolve)
  })
  buildProviders() // must precede attach(): the hub subscribes to provider events there
  wsHub.attach(server)

  startEventBridge()
  startWebhooks()
  startGroupsEngine()
  startAutomationSweeper()
  for (const p of providers) await p.start()

  const port = (server.address() as AddressInfo).port

  console.log(`[hub] ${APP_NAME} v${APP_VERSION} listening on http://${config.publicIp}:${port}`)
  console.log(
    `[hub] auth: ${[config.mockAuth && 'mock', config.oidc.issuer && 'oidc', config.ldap.url && 'ldap'].filter(Boolean).join(', ') || 'none'}`,
  )
  console.log(`[hub] H.264 streaming: ${scrcpyAvailable() ? 'available' : 'unavailable (run npm run setup:tools)'}`)
  console.log(`[hub] reset between sessions: ${config.resetMode}`)
  return { server, port }
}

export async function stopHub(handle: HubHandle): Promise<void> {
  cancelAllPendingReleases()
  stopAutomationSweeper()
  stopGroupsEngine()
  stopWebhooks()
  await stopAllRecordings()
  for (const p of providers) p.stop()
  wsHub.close()
  await new Promise<void>((resolve) => handle.server.close(() => resolve()))
  closeDb()
}
