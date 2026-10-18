/**
 * Sign-in against protocol-level mocks:
 *  - a small OpenID Connect provider (discovery, JWKS, PKCE-checking token endpoint, signed ID tokens)
 *  - an LDAP directory (ldapjs server) with a service account and a few users
 * These exercise our integration code end to end; they do not replace a test against your real IdP.
 */
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import test, { after, before } from 'node:test'
import ldap from 'ldapjs'

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dfz-sso-'))
process.env.DEVICEFARMZ_DATA = dataDir
process.env.DEVICEFARMZ_ANDROID = 'false'
process.env.DEVICEFARMZ_JWT_SECRET = 'test-secret-' + 'x'.repeat(40)
process.env.DEVICEFARMZ_FAKE_DEVICES = '0'
process.env.DEVICEFARMZ_OIDC_CLIENT_ID = 'farm-client'
process.env.DEVICEFARMZ_OIDC_CLIENT_SECRET = 's3cret'
process.env.DEVICEFARMZ_OIDC_ADMIN_GROUP = 'farm-admins'
process.env.DEVICEFARMZ_LDAP_BIND_DN = 'cn=svc,dc=corp,dc=test'
process.env.DEVICEFARMZ_LDAP_BIND_PASSWORD = 'svcpw'
process.env.DEVICEFARMZ_LDAP_BASE_DN = 'ou=people,dc=corp,dc=test'
process.env.DEVICEFARMZ_LDAP_ADMIN_GROUP = 'farm-admins'

// ------------------------------------------------------------------ mock OpenID Connect provider

const b64url = (b: Buffer | string) => Buffer.from(b).toString('base64url')
const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256', use: 'sig' }

let idpIssuer = ''
let claimOverrides: Record<string, unknown> = {}
let forgeSignature = false
const forgedKey = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey
const issuedCodes = new Map<string, { challenge: string; nonce: string; redirectUri: string }>()
let idp: http.Server

function signIdToken(payload: Record<string, unknown>): string {
  const head = b64url(JSON.stringify({ alg: 'RS256', kid: 'k1', typ: 'JWT' }))
  const body = b64url(JSON.stringify(payload))
  const sig = crypto.sign('RSA-SHA256', Buffer.from(`${head}.${body}`), privateKey)
  return `${head}.${body}.${b64url(sig)}`
}

function baseClaims(nonce: string): Record<string, unknown> {
  const now = Math.floor(Date.now() / 1000)
  return {
    iss: idpIssuer,
    sub: 'user-123',
    aud: 'farm-client',
    iat: now,
    exp: now + 300,
    nonce,
    email: 'dana@corp.test',
    email_verified: true,
    name: 'Dana Dev',
    groups: ['staff'],
  }
}

function startIdp(): Promise<void> {
  idp = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', idpIssuer)
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(body))
    }
    if (url.pathname === '/.well-known/openid-configuration') {
      return json(200, {
        issuer: idpIssuer,
        authorization_endpoint: `${idpIssuer}/authorize`,
        token_endpoint: `${idpIssuer}/token`,
        jwks_uri: `${idpIssuer}/jwks`,
        userinfo_endpoint: `${idpIssuer}/userinfo`,
        response_types_supported: ['code'],
        subject_types_supported: ['public'],
        id_token_signing_alg_values_supported: ['RS256'],
        token_endpoint_auth_methods_supported: ['client_secret_post'],
        code_challenge_methods_supported: ['S256'],
      })
    }
    if (url.pathname === '/jwks') return json(200, { keys: [jwk] })
    if (url.pathname === '/userinfo') return json(401, { error: 'invalid_token' }) // the ID token alone must be enough
    if (url.pathname === '/token' && req.method === 'POST') {
      let raw = ''
      req.on('data', (c) => (raw += c))
      req.on('end', () => {
        const f = new URLSearchParams(raw)
        const issued = issuedCodes.get(f.get('code') ?? '')
        if (!issued || f.get('grant_type') !== 'authorization_code') return json(400, { error: 'invalid_grant' })
        if (f.get('client_id') !== 'farm-client' || f.get('client_secret') !== 's3cret') return json(401, { error: 'invalid_client' })
        if (f.get('redirect_uri') !== issued.redirectUri) return json(400, { error: 'invalid_grant', error_description: 'redirect_uri mismatch' })
        const verifier = f.get('code_verifier') ?? ''
        const challenge = crypto.createHash('sha256').update(verifier).digest('base64url')
        if (challenge !== issued.challenge) return json(400, { error: 'invalid_grant', error_description: 'PKCE verification failed' })
        issuedCodes.delete(f.get('code')!)
        const claims = { ...baseClaims(issued.nonce), ...claimOverrides }
        return json(200, { access_token: 'at-1', token_type: 'Bearer', expires_in: 300, id_token: signIdToken(claims) })
      })
      return
    }
    json(404, { error: 'not_found' })
  })
  return new Promise((resolve) =>
    idp.listen(0, '127.0.0.1', () => {
      idpIssuer = `http://127.0.0.1:${(idp.address() as AddressInfo).port}`
      process.env.DEVICEFARMZ_OIDC_ISSUER = idpIssuer
      resolve()
    }),
  )
}

// ------------------------------------------------------------------ mock LDAP directory

const people: Record<string, { dn: string; password: string; attrs: Record<string, string | string[]> }> = {
  alice: {
    dn: 'uid=alice,ou=people,dc=corp,dc=test',
    password: 'alicepw',
    attrs: { uid: 'alice', mail: 'alice@corp.test', cn: 'Alice Admin', memberOf: ['cn=farm-admins,ou=groups,dc=corp,dc=test'] },
  },
  bob: {
    dn: 'uid=bob,ou=people,dc=corp,dc=test',
    password: 'bobpw',
    attrs: { uid: 'bob', mail: 'bob@corp.test', cn: 'Bob Builder', memberOf: ['cn=staff,ou=groups,dc=corp,dc=test'] },
  },
}
let directory: ldap.Server
const anonymousBinds: string[] = []

function startLdap(): Promise<void> {
  directory = ldap.createServer()
  directory.bind('dc=corp,dc=test', (req: any, res: any, next: any) => {
    const dn = req.dn.toString()
    const pw = req.credentials
    if (dn === 'cn=svc,dc=corp,dc=test' && pw === 'svcpw') return res.end()
    const person = Object.values(people).find((p) => p.dn === dn)
    if (person && pw && pw === person.password) return res.end()
    if (!pw) anonymousBinds.push(dn)
    return next(new ldap.InvalidCredentialsError())
  })
  directory.search('ou=people,dc=corp,dc=test', (req: any, res: any) => {
    for (const p of Object.values(people)) {
      if (req.filter.matches(p.attrs)) res.send({ dn: p.dn, attributes: p.attrs }, true) // true: skip ldapjs' case-sensitive attribute filtering (real servers are case-insensitive)
    }
    res.end()
  })
  return new Promise((resolve) =>
    directory.listen(0, '127.0.0.1', () => {
      process.env.DEVICEFARMZ_LDAP_URL = `ldap://127.0.0.1:${(directory.address() as AddressInfo).port}`
      resolve()
    }),
  )
}

// ------------------------------------------------------------------ harness

type Hub = { server: http.Server; port: number }
let hub: Hub
let base: string
let stopHub: (h: Hub) => Promise<void>

before(async () => {
  await startIdp()
  await startLdap()
  const hubMod = await import('../src/hub.js')
  stopHub = hubMod.stopHub
  hub = await hubMod.startHub({ port: 0 })
  base = `http://127.0.0.1:${hub.port}`
  process.env.DEVICEFARMZ_OIDC_REDIRECT_URI = `${base}/api/auth/oidc/callback`
})

after(async () => {
  await stopHub(hub)
  await new Promise((r) => idp.close(r))
  await new Promise((r) => directory.close(r))
  fs.rmSync(dataDir, { recursive: true, force: true })
})

const get = (p: string, token?: string) =>
  fetch(base + p, { redirect: 'manual', headers: token ? { Authorization: `Bearer ${token}` } : {} })

/** Starts a login like the browser would and returns what the provider would have received */
async function beginOidc() {
  const res = await get('/api/auth/oidc/login')
  assert.equal(res.status, 302)
  const auth = new URL(res.headers.get('location')!)
  assert.equal(auth.origin, idpIssuer)
  assert.equal(auth.pathname, '/authorize')
  const q = auth.searchParams
  assert.equal(q.get('client_id'), 'farm-client')
  assert.equal(q.get('response_type'), 'code')
  assert.equal(q.get('code_challenge_method'), 'S256')
  assert.ok(q.get('state') && q.get('nonce') && q.get('code_challenge'))
  const code = 'code-' + crypto.randomUUID()
  issuedCodes.set(code, { challenge: q.get('code_challenge')!, nonce: q.get('nonce')!, redirectUri: q.get('redirect_uri')! })
  return { state: q.get('state')!, code, redirectUri: q.get('redirect_uri')! }
}

const fragment = (res: Response) => new URLSearchParams(new URL(res.headers.get('location')!, base).hash.slice(1))

// ------------------------------------------------------------------ tests

test('providers endpoint reflects the configured sign-in methods', async () => {
  const p = await (await get('/api/auth/providers')).json()
  assert.equal(p.oidc.enabled, true)
  assert.equal(p.ldap.enabled, true)
  assert.equal(p.mock, false, 'development login is off once a real provider is configured')
  const mock = await fetch(base + '/api/auth/mock', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
  assert.equal(mock.status, 403)
})

test('OIDC: authorization code + PKCE flow signs the user in', async () => {
  claimOverrides = {}
  const { state, code } = await beginOidc()
  const cb = await get(`/api/auth/oidc/callback?code=${code}&state=${state}`)
  assert.equal(cb.status, 302)
  const token = fragment(cb).get('token')
  assert.ok(token, 'token is handed back in the URL fragment')

  const me = await (await get('/api/auth/me', token!)).json()
  assert.equal(me.email, 'dana@corp.test')
  assert.equal(me.name, 'Dana Dev')
  assert.equal(me.role, 'user')
})

test('OIDC: members of the admin group become admins', async () => {
  claimOverrides = { groups: ['staff', 'farm-admins'], email: 'root@corp.test', name: 'Root' }
  const { state, code } = await beginOidc()
  const token = fragment(await get(`/api/auth/oidc/callback?code=${code}&state=${state}`)).get('token')!
  const me = await (await get('/api/auth/me', token)).json()
  assert.equal(me.role, 'admin')
  assert.equal((await get('/api/users', token)).status, 200)
})

test('OIDC: rejects unknown state, replayed state, wrong nonce and unverified email', async () => {
  claimOverrides = {}
  const unknown = await get('/api/auth/oidc/callback?code=x&state=nope')
  assert.match(fragment(unknown).get('error') ?? '', /expired|start again/i)

  const first = await beginOidc()
  assert.ok(fragment(await get(`/api/auth/oidc/callback?code=${first.code}&state=${first.state}`)).get('token'))
  const replay = await get(`/api/auth/oidc/callback?code=${first.code}&state=${first.state}`)
  assert.ok(fragment(replay).get('error'), 'a state value can only be used once')

  claimOverrides = { nonce: 'attacker-nonce' }
  const n = await beginOidc()
  const badNonce = fragment(await get(`/api/auth/oidc/callback?code=${n.code}&state=${n.state}`))
  assert.ok(badNonce.get('error') && !badNonce.get('token'), 'ID token with a different nonce is refused')

  claimOverrides = { email_verified: false }
  const v = await beginOidc()
  const unverified = fragment(await get(`/api/auth/oidc/callback?code=${v.code}&state=${v.state}`))
  assert.match(unverified.get('error') ?? '', /verified/i)
  claimOverrides = {}
})

test('OIDC: plain-http identity providers are only accepted on loopback unless explicitly allowed', async () => {
  const saved = process.env.DEVICEFARMZ_OIDC_ISSUER
  process.env.DEVICEFARMZ_OIDC_ISSUER = 'http://idp.example.test'
  try {
    const res = await get('/api/auth/oidc/login')
    assert.equal(res.status, 400)
    assert.match((await res.json()).error, /https/i)
  } finally {
    process.env.DEVICEFARMZ_OIDC_ISSUER = saved
  }
})

async function ldapLogin(username: string, password: string) {
  const res = await fetch(base + '/api/auth/ldap', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  })
  return { status: res.status, json: await res.json().catch(() => ({})) }
}

test('LDAP: valid credentials sign in; group membership grants admin', async () => {
  const bob = await ldapLogin('bob', 'bobpw')
  assert.equal(bob.status, 200)
  assert.equal(bob.json.user.email, 'bob@corp.test')
  assert.equal(bob.json.user.name, 'Bob Builder')
  assert.equal(bob.json.user.role, 'user')

  const alice = await ldapLogin('alice', 'alicepw')
  assert.equal(alice.status, 200)
  assert.equal(alice.json.user.role, 'admin')
  const me = await (await get('/api/auth/me', alice.json.token)).json()
  assert.equal(me.email, 'alice@corp.test')
})

test('LDAP: wrong password, unknown user, empty password and filter injection are all refused', async () => {
  assert.equal((await ldapLogin('bob', 'nope')).status, 401)
  assert.equal((await ldapLogin('nobody', 'x')).status, 401)
  assert.equal((await ldapLogin('bob', '')).status, 401)
  assert.equal((await ldapLogin('*', 'whatever')).status, 401, 'wildcards are escaped, not interpreted')
  assert.equal((await ldapLogin('*)(uid=*', 'whatever')).status, 401)
  assert.deepEqual(anonymousBinds, [], 'never performs an unauthenticated bind on behalf of a user')
})

test('LDAP: directory outage is reported as a gateway error, not a login', async () => {
  const saved = process.env.DEVICEFARMZ_LDAP_URL
  process.env.DEVICEFARMZ_LDAP_URL = 'ldap://127.0.0.1:1'
  try {
    const r = await ldapLogin('bob', 'bobpw')
    assert.equal(r.status, 502)
  } finally {
    process.env.DEVICEFARMZ_LDAP_URL = saved
  }
})
