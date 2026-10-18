import { useCallback, useEffect, useState, type FormEvent } from 'react'
import type { ApiTokenInfo, WebhookConfig } from '@devicefarmz/core'
import { api, type Delivery, type FarmConfig } from '../lib/api'
import { useAuth } from '../state/auth'

export function SettingsPage() {
  const { user } = useAuth()
  const isAdmin = user?.role === 'admin'
  const [cfg, setCfg] = useState<FarmConfig | null>(null)
  const [tokens, setTokens] = useState<ApiTokenInfo[]>([])
  const [title, setTitle] = useState('')
  const [fresh, setFresh] = useState<string | null>(null)
  const [hooks, setHooks] = useState<WebhookConfig[]>([])
  const [eventNames, setEventNames] = useState<string[]>([])
  const [deliveries, setDeliveries] = useState<Delivery[]>([])
  const [hookUrl, setHookUrl] = useState('')
  const [hookEvents, setHookEvents] = useState<string[]>([])
  const [hookSecret, setHookSecret] = useState<string | null>(null)
  const [msg, setMsg] = useState('')

  const load = useCallback(async () => {
    try {
      setCfg(await api.config())
      setTokens((await api.tokens()).tokens)
      if (isAdmin) {
        const w = await api.webhooks()
        setHooks(w.webhooks)
        setEventNames(w.events)
        setDeliveries((await api.deliveries()).deliveries)
      }
    } catch (err) {
      setMsg(err instanceof Error ? err.message : String(err))
    }
  }, [isAdmin])

  useEffect(() => {
    void load()
  }, [load])

  async function createToken(e: FormEvent) {
    e.preventDefault()
    setMsg('')
    try {
      const r = await api.createToken(title || 'untitled')
      setFresh(r.token)
      setTitle('')
      await load()
    } catch (err) {
      setMsg(err instanceof Error ? err.message : String(err))
    }
  }

  async function createHook(e: FormEvent) {
    e.preventDefault()
    setMsg('')
    try {
      const r = await api.createWebhook(hookUrl, hookEvents)
      setHookSecret(r.secret)
      setHookUrl('')
      setHookEvents([])
      await load()
    } catch (err) {
      setMsg(err instanceof Error ? err.message : String(err))
    }
  }

  const origin = location.origin
  const ciSnippet = `# GitHub Actions
- name: Run UI tests on a real device
  env:
    DEVICEFARMZ_URL: ${origin}
    DEVICEFARMZ_TOKEN: \${{ secrets.DEVICEFARMZ_TOKEN }}
  run: devicefarmz ci run --query "android>=13" --label "$GITHUB_RUN_ID" -- ./gradlew connectedCheck
# the command gets DEVICE_UDID and always releases the device afterwards`

  const appiumSnippet = `// Appium client: point it at the farm instead of a local Appium server
const driver = await remote({
  hostname: '${location.hostname}', port: ${location.port || (location.protocol === 'https:' ? 443 : 80)}, path: '/appium',
  user: 'ci', key: process.env.DEVICEFARMZ_TOKEN,
  capabilities: { platformName: 'Android', 'devicefarmz:query': 'android>=13', 'appium:automationName': 'UiAutomator2' },
})`

  return (
    <div>
      <h2>Settings</h2>
      {msg && <p style={{ color: 'var(--danger)' }}>{msg}</p>}

      {cfg && (
        <p className="meta">
          {cfg.name} {cfg.version} · screen streaming: {cfg.features.h264 ? 'H.264 (scrcpy)' : 'screenshot frames'} · data reset on
          release: <code>{cfg.features.resetMode}</code> · auto-record: {cfg.features.autoRecord ? 'on' : 'off'} · iOS:{' '}
          {cfg.features.ios ? 'enabled' : 'off'} · simulator: {cfg.features.simulator ? 'on' : 'off'} · AI assist:{' '}
          {cfg.features.llm ? 'language model' : 'built-in parser'}
        </p>
      )}

      <section className="card">
        <h3>API access tokens</h3>
        <p className="meta">
          Use them as <code>Authorization: Bearer &lt;token&gt;</code> from CI jobs, scripts and the Appium gateway. A token acts as you.
        </p>
        <form onSubmit={createToken} style={{ display: 'flex', gap: '0.5rem', marginBottom: '0.75rem' }}>
          <input placeholder="Token name, e.g. github-actions" value={title} onChange={(e) => setTitle(e.target.value)} />
          <button className="btn small">Create token</button>
        </form>
        {fresh && (
          <div className="notice">
            Copy it now — it will not be shown again:
            <pre className="secret">{fresh}</pre>
            <button className="btn ghost small" onClick={() => setFresh(null)}>
              I saved it
            </button>
          </div>
        )}
        {tokens.length > 0 && (
          <table className="table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Created</th>
                <th>Last used</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {tokens.map((t) => (
                <tr key={t.id}>
                  <td>{t.title}</td>
                  <td>{new Date(t.createdAt).toLocaleString()}</td>
                  <td>{t.lastUsedAt ? new Date(t.lastUsedAt).toLocaleString() : 'never'}</td>
                  <td>
                    <button className="btn ghost small" onClick={() => void api.revokeToken(t.id).then(load)}>
                      Revoke
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="card">
        <h3>CI & Appium</h3>
        <pre className="snippet">{ciSnippet}</pre>
        <pre className="snippet">{appiumSnippet}</pre>
      </section>

      {isAdmin && (
        <section className="card">
          <h3>Webhooks</h3>
          <p className="meta">Signed with HMAC-SHA256 in the <code>X-DeviceFarmz-Signature</code> header. Failed deliveries are retried.</p>
          <form onSubmit={createHook}>
            <div className="field">
              <label>Endpoint URL</label>
              <input placeholder="https://ci.example.com/hooks/devicefarmz" value={hookUrl} onChange={(e) => setHookUrl(e.target.value)} required />
            </div>
            <div className="chips">
              {eventNames.map((n) => (
                <label key={n} className={`chip ${hookEvents.includes(n) ? 'on' : ''}`}>
                  <input
                    type="checkbox"
                    hidden
                    checked={hookEvents.includes(n)}
                    onChange={(e) => setHookEvents((cur) => (e.target.checked ? [...cur, n] : cur.filter((x) => x !== n)))}
                  />
                  {n}
                </label>
              ))}
            </div>
            <p className="meta">No event selected = all events.</p>
            <button className="btn small">Add webhook</button>
          </form>
          {hookSecret && (
            <div className="notice">
              Signing secret (shown once):
              <pre className="secret">{hookSecret}</pre>
              <button className="btn ghost small" onClick={() => setHookSecret(null)}>
                Done
              </button>
            </div>
          )}
          {hooks.length > 0 && (
            <table className="table">
              <thead>
                <tr>
                  <th>URL</th>
                  <th>Events</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {hooks.map((h) => (
                  <tr key={h.id}>
                    <td>{h.url}</td>
                    <td>{h.events.join(', ')}</td>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      <button
                        className="btn ghost small"
                        onClick={() =>
                          void api
                            .testWebhook(h.id)
                            .then((d) => setMsg(d.ok ? `Test delivered (HTTP ${d.status})` : `Test failed: ${d.error ?? d.status}`))
                            .then(load)
                        }
                      >
                        Send test
                      </button>{' '}
                      <button className="btn ghost small" onClick={() => void api.deleteWebhook(h.id).then(load)}>
                        Delete
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {deliveries.length > 0 && (
            <>
              <h4>Recent deliveries</h4>
              <table className="table">
                <tbody>
                  {deliveries.slice(0, 10).map((d, i) => (
                    <tr key={i}>
                      <td>{new Date(d.at).toLocaleTimeString()}</td>
                      <td>{d.type}</td>
                      <td>{d.ok ? `✓ ${d.status}` : `✗ ${d.error ?? d.status}`}</td>
                      <td>{d.attempts} attempt(s)</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </section>
      )}
    </div>
  )
}
