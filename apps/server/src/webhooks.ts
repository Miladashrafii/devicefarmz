import crypto from 'node:crypto'
import { nanoid } from 'nanoid'
import type { FarmEventType, WebhookConfig } from '@devicefarmz/core'
import { getDb } from './db.js'
import { onEvent, type FarmEvent } from './events.js'

export const EVENT_TYPES: FarmEventType[] = [
  'device.online',
  'device.offline',
  'device.claimed',
  'device.released',
  'device.reset',
  'automation.started',
  'automation.ended',
  'recording.started',
  'recording.ready',
  'webhook.test',
]

export interface Delivery {
  webhookId: string
  eventId: string
  type: string
  url: string
  ok: boolean
  status: number | null
  attempts: number
  at: string
  error?: string
}

const deliveries: Delivery[] = []
let unsubscribe: (() => void) | null = null

interface Row {
  id: string
  url: string
  secret: string
  events: string
  active: number
  created_by: string
  created_at: string
}

function toConfig(r: Row): WebhookConfig {
  return {
    id: r.id,
    url: r.url,
    events: JSON.parse(r.events) as string[],
    active: r.active === 1,
    createdBy: r.created_by,
    createdAt: r.created_at,
  }
}

export function validateWebhookUrl(raw: string): URL {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error('Invalid URL')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('Only http(s) URLs are allowed')
  return url
}

export function createWebhook(url: string, events: string[], createdBy: string): { hook: WebhookConfig; secret: string } {
  validateWebhookUrl(url)
  const wanted = events.length ? events : ['*']
  for (const e of wanted) {
    if (e !== '*' && !EVENT_TYPES.includes(e as FarmEventType)) throw new Error(`Unknown event "${e}"`)
  }
  const id = nanoid(10)
  const secret = `whsec_${crypto.randomBytes(24).toString('hex')}`
  const createdAt = new Date().toISOString()
  getDb()
    .prepare('INSERT INTO webhooks (id, url, secret, events, active, created_by, created_at) VALUES (?, ?, ?, ?, 1, ?, ?)')
    .run(id, url, secret, JSON.stringify(wanted), createdBy, createdAt)
  return { hook: { id, url, events: wanted, active: true, createdBy, createdAt }, secret }
}

export function listWebhooks(): WebhookConfig[] {
  return (getDb().prepare('SELECT * FROM webhooks ORDER BY created_at DESC').all() as Row[]).map(toConfig)
}

export function deleteWebhook(id: string): boolean {
  return getDb().prepare('DELETE FROM webhooks WHERE id = ?').run(id).changes > 0
}

export function recentDeliveries(): Delivery[] {
  return deliveries.slice(0, 50)
}

export function sign(secret: string, body: string): string {
  return 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex')
}

async function deliver(row: Row, event: FarmEvent): Promise<Delivery> {
  const body = JSON.stringify({ id: event.id, type: event.type, createdAt: event.createdAt, data: event.data })
  const delivery: Delivery = {
    webhookId: row.id,
    eventId: event.id,
    type: event.type,
    url: row.url,
    ok: false,
    status: null,
    attempts: 0,
    at: new Date().toISOString(),
  }
  const delays = [0, 1000, 3000]
  for (const delay of delays) {
    if (delay) await new Promise((r) => setTimeout(r, delay))
    delivery.attempts += 1
    try {
      const res = await fetch(row.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'DeviceFarmz-Webhook/1',
          'X-DeviceFarmz-Event': event.type,
          'X-DeviceFarmz-Delivery': event.id,
          'X-DeviceFarmz-Signature': sign(row.secret, body),
        },
        body,
        signal: AbortSignal.timeout(8000),
      })
      delivery.status = res.status
      if (res.ok) {
        delivery.ok = true
        delete delivery.error
        break
      }
      delivery.error = `HTTP ${res.status}`
      if (res.status < 500 && res.status !== 429) break
    } catch (err) {
      delivery.error = (err as Error).message
    }
  }
  deliveries.unshift(delivery)
  deliveries.length = Math.min(deliveries.length, 200)
  return delivery
}

export async function dispatch(event: FarmEvent): Promise<Delivery[]> {
  const rows = (getDb().prepare('SELECT * FROM webhooks WHERE active = 1').all() as Row[]).filter((r) => {
    const events = JSON.parse(r.events) as string[]
    return events.includes('*') || events.includes(event.type)
  })
  return Promise.all(rows.map((r) => deliver(r, event)))
}

export function sendTest(id: string): Promise<Delivery> {
  const row = getDb().prepare('SELECT * FROM webhooks WHERE id = ?').get(id) as Row | undefined
  if (!row) throw new Error('Webhook not found')
  return deliver(row, {
    id: `evt_test_${Date.now().toString(36)}`,
    type: 'webhook.test',
    createdAt: new Date().toISOString(),
    data: { message: 'Hello from DeviceFarmz' },
  })
}

export function startWebhooks(): void {
  if (unsubscribe) return
  unsubscribe = onEvent((event) => void dispatch(event).catch(() => undefined))
}

export function stopWebhooks(): void {
  unsubscribe?.()
  unsubscribe = null
}
