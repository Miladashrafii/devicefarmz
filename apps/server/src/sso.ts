import { Client } from 'ldapts'
import * as oidc from 'openid-client'
import type { AuthProviders, SessionInfo } from '@devicefarmz/core'
import { signSession, upsertExternalUser } from './auth.js'
import { config } from './config.js'
import { HttpError } from './middleware.js'

export function authProviders(): AuthProviders {
  return {
    mock: config.mockAuth,
    oidc: { enabled: Boolean(config.oidc.issuer && config.oidc.clientId), label: config.oidc.label },
    ldap: { enabled: Boolean(config.ldap.url && config.ldap.baseDn) },
  }
}

// ---------------------------------------------------------------- login throttling

const attempts = new Map<string, { count: number; resetAt: number }>()

export function throttle(key: string, limit = 10, windowMs = 60_000): void {
  const now = Date.now()
  const entry = attempts.get(key)
  if (!entry || entry.resetAt < now) {
    attempts.set(key, { count: 1, resetAt: now + windowMs })
    return
  }
  entry.count += 1
  if (entry.count > limit) throw new HttpError(429, 'Too many login attempts, try again later')
}

// ---------------------------------------------------------------- OIDC

interface PendingLogin {
  verifier: string
  nonce: string
  expiresAt: number
}

const pending = new Map<string, PendingLogin>()
let discovered: { key: string; cfg: oidc.Configuration } | null = null

/** Plain http is only reasonable for local development; the ID token is trusted because of the TLS connection to the provider */
function allowPlainHttp(issuer: string): boolean {
  if (process.env.DEVICEFARMZ_OIDC_ALLOW_INSECURE === 'true') return true
  const host = new URL(issuer).hostname
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]'
}

async function oidcConfig(): Promise<oidc.Configuration> {
  const { issuer, clientId, clientSecret } = config.oidc
  const key = `${issuer}|${clientId}`
  if (discovered?.key === key) return discovered.cfg
  const insecure = issuer.startsWith('http://')
  if (insecure && !allowPlainHttp(issuer)) {
    throw new HttpError(400, 'The OIDC issuer must use https (set DEVICEFARMZ_OIDC_ALLOW_INSECURE=true for a trusted internal provider)')
  }
  const cfg = await oidc.discovery(
    new URL(issuer),
    clientId,
    clientSecret || undefined,
    undefined,
    insecure ? { execute: [oidc.allowInsecureRequests] } : undefined,
  )
  discovered = { key, cfg }
  return cfg
}

function redirectUri(): string {
  if (config.oidc.redirectUri) return config.oidc.redirectUri
  const base = config.publicUrl || `http://${config.publicIp}:${config.hubPort}`
  return `${base.replace(/\/$/, '')}/api/auth/oidc/callback`
}

export async function oidcLoginUrl(): Promise<string> {
  if (!authProviders().oidc.enabled) throw new HttpError(404, 'OIDC is not configured')
  const cfg = await oidcConfig()
  const verifier = oidc.randomPKCECodeVerifier()
  const challenge = await oidc.calculatePKCECodeChallenge(verifier)
  const state = oidc.randomState()
  const nonce = oidc.randomNonce()
  const now = Date.now()
  for (const [k, v] of pending) if (v.expiresAt < now) pending.delete(k)
  pending.set(state, { verifier, nonce, expiresAt: now + 10 * 60_000 })

  const url = oidc.buildAuthorizationUrl(cfg, {
    redirect_uri: redirectUri(),
    scope: config.oidc.scopes,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
    nonce,
  })
  return url.href
}

function claimList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String)
  if (typeof value === 'string') return value.split(/[,\s]+/).filter(Boolean)
  return []
}

export async function oidcCallback(search: string): Promise<SessionInfo> {
  const params = new URLSearchParams(search)
  const state = params.get('state')
  const entry = state ? pending.get(state) : undefined
  if (!state || !entry || entry.expiresAt < Date.now()) throw new HttpError(400, 'Login session expired, start again')
  pending.delete(state)

  const cfg = await oidcConfig()
  const current = new URL(redirectUri())
  current.search = search
  let tokens
  try {
    tokens = await oidc.authorizationCodeGrant(cfg, current, {
      pkceCodeVerifier: entry.verifier,
      expectedState: state,
      expectedNonce: entry.nonce,
    })
  } catch (err) {
    throw new HttpError(401, `OIDC login failed: ${(err as Error).message}`)
  }

  const claims = tokens.claims()
  if (!claims) throw new HttpError(401, 'Identity provider returned no ID token')
  let profile: Record<string, unknown> = { ...claims }
  try {
    profile = { ...(await oidc.fetchUserInfo(cfg, tokens.access_token, claims.sub)), ...claims }
  } catch {
    /* ID token claims are enough */
  }

  const email = String(profile.email ?? profile.preferred_username ?? '').toLowerCase()
  if (!email) throw new HttpError(403, 'Identity provider did not supply an email address')
  if (profile.email_verified === false) throw new HttpError(403, 'Email address is not verified')
  const name = String(profile.name ?? profile.preferred_username ?? email)
  const groups = claimList(profile[config.oidc.groupClaim])
  const admin = Boolean(config.oidc.adminGroup) && groups.includes(config.oidc.adminGroup)
  return signSession(upsertExternalUser(email, name, admin))
}

// ---------------------------------------------------------------- LDAP

function escapeFilter(value: string): string {
  return value.replace(/[\\*()\0]/g, (c) => '\\' + c.charCodeAt(0).toString(16).padStart(2, '0'))
}

function first(value: unknown): string {
  if (Array.isArray(value)) return first(value[0])
  if (Buffer.isBuffer(value)) return value.toString('utf8')
  return value === undefined || value === null ? '' : String(value)
}

/** Attribute lookup that ignores case, as LDAP attribute names do */
function attr(entry: Record<string, unknown>, name: string): unknown {
  const wanted = name.toLowerCase()
  const key = Object.keys(entry).find((k) => k.toLowerCase() === wanted)
  return key === undefined ? undefined : entry[key]
}

export async function ldapLogin(username: string, password: string): Promise<SessionInfo> {
  const { ldap } = config
  if (!authProviders().ldap.enabled) throw new HttpError(404, 'LDAP is not configured')
  // An empty password would turn the user bind into an anonymous (always successful) bind
  if (!username || !password) throw new HttpError(401, 'Invalid credentials')

  const filter = ldap.userFilter.replaceAll('{{username}}', escapeFilter(username))
  const svc = new Client({ url: ldap.url, timeout: 8000, connectTimeout: 8000 })
  let dn = ''
  let entry: Record<string, unknown>
  try {
    if (ldap.bindDn) await svc.bind(ldap.bindDn, ldap.bindPassword)
    const { searchEntries } = await svc.search(ldap.baseDn, {
      scope: 'sub',
      filter,
      // lower-case: the client library only fills in requested attributes whose case matches the server's, and LDAP names are case-insensitive
      attributes: [ldap.mailAttr, ldap.nameAttr, 'memberOf'].map((a) => a.toLowerCase()),
      sizeLimit: 2,
    })
    if (searchEntries.length !== 1) throw new HttpError(401, 'Invalid credentials')
    entry = searchEntries[0] as Record<string, unknown>
    dn = String(entry.dn)
  } catch (err) {
    if (err instanceof HttpError) throw err
    throw new HttpError(502, `LDAP directory error: ${(err as Error).message}`)
  } finally {
    await svc.unbind().catch(() => undefined)
  }

  const userClient = new Client({ url: ldap.url, timeout: 8000, connectTimeout: 8000 })
  try {
    await userClient.bind(dn, password)
  } catch {
    throw new HttpError(401, 'Invalid credentials')
  } finally {
    await userClient.unbind().catch(() => undefined)
  }

  const email = (first(attr(entry, ldap.mailAttr)) || `${username}@${new URL(ldap.url).hostname}`).toLowerCase()
  const name = first(attr(entry, ldap.nameAttr)) || username
  const memberOf = [attr(entry, 'memberOf')].flat().map(first).filter(Boolean)
  const wanted = ldap.adminGroup.toLowerCase()
  const admin = Boolean(wanted) && memberOf.some((g) => g.toLowerCase() === wanted || g.toLowerCase().startsWith(`cn=${wanted},`))
  return signSession(upsertExternalUser(email, name, admin))
}