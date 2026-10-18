import { useEffect, useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import type { AuthProviders } from '@devicefarmz/core'
import { api } from '../lib/api'
import { useAuth } from '../state/auth'

export function LoginPage() {
  const { login, ldapLogin, loginWithToken } = useAuth()
  const nav = useNavigate()
  const [providers, setProviders] = useState<AuthProviders | null>(null)
  const [name, setName] = useState('administrator')
  const [email, setEmail] = useState('administrator@fakedomain.com')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void api
      .providers()
      .then(setProviders)
      .catch((e) => setError(String(e.message ?? e)))
  }, [])

  // SSO redirect lands here as /login#token=… or /login#error=…
  useEffect(() => {
    if (!location.hash) return
    const params = new URLSearchParams(location.hash.slice(1))
    const t = params.get('token')
    const err = params.get('error')
    history.replaceState(null, '', location.pathname)
    if (err) setError(err)
    if (t) {
      setBusy(true)
      loginWithToken(t)
        .then(() => nav('/'))
        .catch((e) => setError(e instanceof Error ? e.message : String(e)))
        .finally(() => setBusy(false))
    }
  }, [loginWithToken, nav])

  async function run(fn: () => Promise<void>) {
    setBusy(true)
    setError('')
    try {
      await fn()
      nav('/')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const onMock = (e: FormEvent) => {
    e.preventDefault()
    void run(() => login(name, email))
  }
  const onLdap = (e: FormEvent) => {
    e.preventDefault()
    void run(() => ldapLogin(username, password))
  }

  return (
    <div className="login-page">
      <div className="login-panel">
        <h1>
          Device<span>Farmz</span>
        </h1>
        <p>Remote control and inventory for your physical device lab — from the browser.</p>

        {providers?.oidc.enabled && (
          <a className="btn" style={{ display: 'block', textAlign: 'center', marginBottom: '1rem' }} href="/api/auth/oidc/login">
            {providers.oidc.label || 'Sign in with SSO'}
          </a>
        )}

        {providers?.ldap.enabled && (
          <form onSubmit={onLdap} style={{ marginBottom: '1rem' }}>
            <div className="field">
              <label htmlFor="username">Directory username</label>
              <input id="username" autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} required />
            </div>
            <div className="field">
              <label htmlFor="password">Password</label>
              <input
                id="password"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
            </div>
            <button className="btn" disabled={busy} style={{ width: '100%' }}>
              {busy ? 'Signing in…' : 'Sign in with LDAP'}
            </button>
          </form>
        )}

        {providers?.mock && (
          <form onSubmit={onMock}>
            {(providers.oidc.enabled || providers.ldap.enabled) && <p className="meta">Development login</p>}
            <div className="field">
              <label htmlFor="name">Name</label>
              <input id="name" value={name} onChange={(e) => setName(e.target.value)} required />
            </div>
            <div className="field">
              <label htmlFor="email">Email</label>
              <input id="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
            </div>
            <button className="btn" disabled={busy} style={{ width: '100%' }}>
              {busy ? 'Signing in…' : 'Enter the farm'}
            </button>
          </form>
        )}

        {providers && !providers.mock && !providers.oidc.enabled && !providers.ldap.enabled && (
          <p style={{ color: 'var(--danger)' }}>No sign-in method is configured on this hub.</p>
        )}
        {error && <p style={{ color: 'var(--danger)' }}>{error}</p>}
      </div>
    </div>
  )
}
