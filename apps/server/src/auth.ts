import jwt from 'jsonwebtoken'
import { nanoid } from 'nanoid'
import type { SessionInfo, User } from '@devicefarmz/core'
import { config } from './config.js'
import * as db from './db.js'
import { API_TOKEN_PREFIX, verifyApiToken } from './tokens.js'

interface TokenPayload {
  sub: string
  email: string
  role: string
}

export function signSession(user: User, ttlSeconds = 60 * 60 * 24 * 7): SessionInfo {
  const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString()
  const token = jwt.sign(
    { sub: user.id, email: user.email, role: user.role } satisfies TokenPayload,
    config.jwtSecret,
    { expiresIn: ttlSeconds },
  )
  return { token, user, expiresAt }
}

/** Accepts both browser session JWTs and long-lived API tokens (dfz_...) */
export function verifyToken(token: string): User | null {
  if (token.startsWith(API_TOKEN_PREFIX)) return verifyApiToken(token)
  try {
    const payload = jwt.verify(token, config.jwtSecret) as TokenPayload
    return db.getUserById(payload.sub)
  } catch {
    return null
  }
}

/** Creates or updates a user that was authenticated by an external system */
export function upsertExternalUser(email: string, name: string, admin: boolean): User {
  const normalized = email.trim().toLowerCase()
  const now = new Date().toISOString()
  const isAdmin = admin || normalized === config.adminEmail.toLowerCase() || config.adminEmails.includes(normalized)
  const existing = db.getUserByEmail(normalized)
  if (existing) {
    const next: User = {
      ...existing,
      name: name || existing.name,
      role: isAdmin ? 'admin' : existing.role,
      lastLoginAt: now,
    }
    db.updateUser(next)
    return next
  }
  const user: User = {
    id: nanoid(),
    email: normalized,
    name: name || normalized,
    role: isAdmin ? 'admin' : 'user',
    groupQuota: 5,
    createdAt: now,
    lastLoginAt: now,
  }
  db.insertUser(user)
  return user
}

export function mockLogin(name: string, email: string): SessionInfo {
  const normalized = email.trim().toLowerCase()
  return signSession(upsertExternalUser(normalized, name, normalized === config.adminEmail.toLowerCase()))
}

export function requireAdmin(user: User): void {
  if (user.role !== 'admin') throw Object.assign(new Error('Admin required'), { status: 403 })
}
