import crypto from 'node:crypto'
import { nanoid } from 'nanoid'
import type { ApiTokenInfo, User } from '@devicefarmz/core'
import { getDb, getUserById } from './db.js'

export const API_TOKEN_PREFIX = 'dfz_'

function hash(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex')
}

export function createApiToken(user: User, title: string): { token: string; info: ApiTokenInfo } {
  const token = API_TOKEN_PREFIX + crypto.randomBytes(24).toString('hex')
  const info: ApiTokenInfo = {
    id: nanoid(10),
    title: title.trim().slice(0, 80) || 'API token',
    createdAt: new Date().toISOString(),
    lastUsedAt: null,
  }
  getDb()
    .prepare(
      `INSERT INTO access_tokens (id, user_id, title, token_hash, created_at) VALUES (?, ?, ?, ?, ?)`,
    )
    .run(info.id, user.id, info.title, hash(token), info.createdAt)
  return { token, info }
}

export function listApiTokens(userId: string): ApiTokenInfo[] {
  const rows = getDb()
    .prepare('SELECT id, title, created_at, last_used_at FROM access_tokens WHERE user_id = ? ORDER BY created_at DESC')
    .all(userId) as { id: string; title: string; created_at: string; last_used_at: string | null }[]
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    createdAt: r.created_at,
    lastUsedAt: r.last_used_at,
  }))
}

export function revokeApiToken(id: string, user: User): boolean {
  const sql =
    user.role === 'admin'
      ? 'DELETE FROM access_tokens WHERE id = ?'
      : 'DELETE FROM access_tokens WHERE id = ? AND user_id = ?'
  const r = getDb()
    .prepare(sql)
    .run(...(user.role === 'admin' ? [id] : [id, user.id]))
  return r.changes > 0
}

export function verifyApiToken(raw: string): User | null {
  if (!raw.startsWith(API_TOKEN_PREFIX)) return null
  const row = getDb().prepare('SELECT id, user_id FROM access_tokens WHERE token_hash = ?').get(hash(raw)) as
    | { id: string; user_id: string }
    | undefined
  if (!row) return null
  getDb().prepare('UPDATE access_tokens SET last_used_at = ? WHERE id = ?').run(new Date().toISOString(), row.id)
  return getUserById(row.user_id)
}
