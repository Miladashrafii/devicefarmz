import fs from 'node:fs'
import Database from 'better-sqlite3'
import { nanoid } from 'nanoid'
import type {
  AutomationSession,
  Device,
  Group,
  Platform,
  Recording,
  User,
  UserRole,
} from '@devicefarmz/core'
import { config, dbPath, recordingsDir } from './config.js'

let db: Database.Database | null = null

export function getDb(): Database.Database {
  if (!db) throw new Error('Database not initialized')
  return db
}

export function closeDb(): void {
  db?.close()
  db = null
}

export function initDb(): void {
  fs.mkdirSync(config.dataDir, { recursive: true })
  fs.mkdirSync(recordingsDir(), { recursive: true })
  db = new Database(dbPath())
  db.pragma('journal_mode = WAL')
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'user',
      group_quota INTEGER NOT NULL DEFAULT 5,
      created_at TEXT NOT NULL,
      last_login_at TEXT
    );

    CREATE TABLE IF NOT EXISTS devices (
      serial TEXT PRIMARY KEY,
      json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS groups (
      id TEXT PRIMARY KEY,
      json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS access_tokens (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      title TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL,
      last_used_at TEXT
    );

    CREATE TABLE IF NOT EXISTS webhooks (
      id TEXT PRIMARY KEY,
      url TEXT NOT NULL,
      secret TEXT NOT NULL,
      events TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS recordings (
      id TEXT PRIMARY KEY,
      json TEXT NOT NULL,
      started_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS automation_sessions (
      id TEXT PRIMARY KEY,
      json TEXT NOT NULL,
      released INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );
  `)

  ensureBuiltinObjects()
}

function ensureBuiltinObjects(): void {
  const now = new Date().toISOString()
  const admin = getUserByEmail(config.adminEmail)
  if (!admin) {
    insertUser({
      id: nanoid(),
      email: config.adminEmail,
      name: config.adminName,
      role: 'admin',
      groupQuota: 100,
      createdAt: now,
      lastLoginAt: null,
    })
  }

  const groups = listGroups()
  if (!groups.find((g) => g.name === config.rootGroupName && g.class === 'standard')) {
    upsertGroup({
      id: nanoid(),
      name: config.rootGroupName,
      class: 'standard',
      state: 'active',
      ownerEmail: config.adminEmail,
      deviceSerials: [],
      userEmails: [],
      startTime: null,
      stopTime: null,
      repetitions: 0,
      durationMs: null,
      createdAt: now,
      updatedAt: now,
    })
  }
}

// ---------- users ----------

export function insertUser(user: User): void {
  getDb()
    .prepare(
      `INSERT INTO users (id, email, name, role, group_quota, created_at, last_login_at)
       VALUES (@id, @email, @name, @role, @groupQuota, @createdAt, @lastLoginAt)`,
    )
    .run({
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      groupQuota: user.groupQuota,
      createdAt: user.createdAt,
      lastLoginAt: user.lastLoginAt,
    })
}

export function updateUser(user: User): void {
  getDb()
    .prepare(
      `UPDATE users SET name=@name, role=@role, group_quota=@groupQuota, last_login_at=@lastLoginAt
       WHERE id=@id`,
    )
    .run({
      id: user.id,
      name: user.name,
      role: user.role,
      groupQuota: user.groupQuota,
      lastLoginAt: user.lastLoginAt,
    })
}

function rowToUser(row: Record<string, unknown>): User {
  return {
    id: String(row.id),
    email: String(row.email),
    name: String(row.name),
    role: row.role as UserRole,
    groupQuota: Number(row.group_quota),
    createdAt: String(row.created_at),
    lastLoginAt: row.last_login_at ? String(row.last_login_at) : null,
  }
}

export function getUserByEmail(email: string): User | null {
  const row = getDb().prepare('SELECT * FROM users WHERE email = ?').get(email) as
    | Record<string, unknown>
    | undefined
  return row ? rowToUser(row) : null
}

export function getUserById(id: string): User | null {
  const row = getDb().prepare('SELECT * FROM users WHERE id = ?').get(id) as
    | Record<string, unknown>
    | undefined
  return row ? rowToUser(row) : null
}

export function listUsers(): User[] {
  return (getDb().prepare('SELECT * FROM users ORDER BY email').all() as Record<string, unknown>[]).map(
    rowToUser,
  )
}

export function deleteUser(id: string): boolean {
  getDb().prepare('DELETE FROM access_tokens WHERE user_id = ?').run(id)
  const r = getDb().prepare('DELETE FROM users WHERE id = ?').run(id)
  return r.changes > 0
}

// ---------- devices ----------

export function upsertDevice(device: Device): void {
  getDb()
    .prepare(
      `INSERT INTO devices (serial, json, updated_at) VALUES (@serial, @json, @updatedAt)
       ON CONFLICT(serial) DO UPDATE SET json=@json, updated_at=@updatedAt`,
    )
    .run({
      serial: device.serial,
      json: JSON.stringify(device),
      updatedAt: device.updatedAt,
    })
}

export function getDevice(serial: string): Device | null {
  const row = getDb().prepare('SELECT json FROM devices WHERE serial = ?').get(serial) as
    | { json: string }
    | undefined
  return row ? normalizeDevice(JSON.parse(row.json)) : null
}

/** Fills fields added in later versions so old rows keep working */
function normalizeDevice(d: Partial<Device> & { serial: string }): Device {
  return {
    platform: 'android' as Platform,
    simulated: false,
    ...d,
  } as Device
}

export function listDevices(): Device[] {
  return (getDb().prepare('SELECT json FROM devices').all() as { json: string }[]).map((r) =>
    normalizeDevice(JSON.parse(r.json)),
  )
}

export function deleteDevice(serial: string): boolean {
  const r = getDb().prepare('DELETE FROM devices WHERE serial = ?').run(serial)
  return r.changes > 0
}

// ---------- groups ----------

export function upsertGroup(group: Group): void {
  getDb()
    .prepare(
      `INSERT INTO groups (id, json, updated_at) VALUES (@id, @json, @updatedAt)
       ON CONFLICT(id) DO UPDATE SET json=@json, updated_at=@updatedAt`,
    )
    .run({
      id: group.id,
      json: JSON.stringify(group),
      updatedAt: group.updatedAt,
    })
}

export function getGroup(id: string): Group | null {
  const row = getDb().prepare('SELECT json FROM groups WHERE id = ?').get(id) as
    | { json: string }
    | undefined
  return row ? (JSON.parse(row.json) as Group) : null
}

export function listGroups(): Group[] {
  return (getDb().prepare('SELECT json FROM groups').all() as { json: string }[]).map(
    (r) => JSON.parse(r.json) as Group,
  )
}

export function deleteGroup(id: string): boolean {
  const r = getDb().prepare('DELETE FROM groups WHERE id = ?').run(id)
  return r.changes > 0
}

export function getRootGroup(): Group {
  const g = listGroups().find((x) => x.name === config.rootGroupName && x.class === 'standard')
  if (!g) throw new Error('Root group missing')
  return g
}

// ---------- recordings ----------

export function saveRecording(rec: Recording): void {
  getDb()
    .prepare(
      `INSERT INTO recordings (id, json, started_at) VALUES (@id, @json, @startedAt)
       ON CONFLICT(id) DO UPDATE SET json=@json`,
    )
    .run({ id: rec.id, json: JSON.stringify(rec), startedAt: rec.startedAt })
}

export function getRecording(id: string): Recording | null {
  const row = getDb().prepare('SELECT json FROM recordings WHERE id = ?').get(id) as
    | { json: string }
    | undefined
  return row ? (JSON.parse(row.json) as Recording) : null
}

export function listRecordings(): Recording[] {
  return (
    getDb().prepare('SELECT json FROM recordings ORDER BY started_at DESC LIMIT 500').all() as {
      json: string
    }[]
  ).map((r) => JSON.parse(r.json) as Recording)
}

export function deleteRecording(id: string): boolean {
  return getDb().prepare('DELETE FROM recordings WHERE id = ?').run(id).changes > 0
}

// ---------- automation sessions ----------

export function saveAutomationSession(s: AutomationSession): void {
  getDb()
    .prepare(
      `INSERT INTO automation_sessions (id, json, released, created_at)
       VALUES (@id, @json, @released, @createdAt)
       ON CONFLICT(id) DO UPDATE SET json=@json, released=@released`,
    )
    .run({
      id: s.id,
      json: JSON.stringify(s),
      released: s.releasedAt ? 1 : 0,
      createdAt: s.createdAt,
    })
}

export function getAutomationSession(id: string): AutomationSession | null {
  const row = getDb().prepare('SELECT json FROM automation_sessions WHERE id = ?').get(id) as
    | { json: string }
    | undefined
  return row ? (JSON.parse(row.json) as AutomationSession) : null
}

export function listAutomationSessions(activeOnly = false): AutomationSession[] {
  const sql = activeOnly
    ? 'SELECT json FROM automation_sessions WHERE released = 0 ORDER BY created_at DESC'
    : 'SELECT json FROM automation_sessions ORDER BY created_at DESC LIMIT 200'
  return (getDb().prepare(sql).all() as { json: string }[]).map(
    (r) => JSON.parse(r.json) as AutomationSession,
  )
}
