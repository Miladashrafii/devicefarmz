import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import type { CoverageReport, Device } from '@devicefarmz/core'
import { api, type Interpretation } from '../lib/api'
import { FarmSocket } from '../lib/ws'
import { useAuth } from '../state/auth'

export function DevicesPage() {
  const { token } = useAuth()
  const nav = useNavigate()
  const [devices, setDevices] = useState<Device[]>([])
  const [q, setQ] = useState('')
  const [stats, setStats] = useState({ devicesOnline: 0, devicesBusy: 0, devicesTotal: 0 })
  const [ask, setAsk] = useState('')
  const [asked, setAsked] = useState<Interpretation | null>(null)
  const [report, setReport] = useState<(CoverageReport & { interpretation: Interpretation | null }) | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!token) return
    let alive = true
    void api.devices().then((r) => alive && setDevices(r.devices))
    const refreshStats = () => void api.stats().then((s) => alive && setStats(s)).catch(() => undefined)
    refreshStats()
    const timer = window.setInterval(refreshStats, 5000)
    const sock = new FarmSocket(token)
    sock.connect()
    sock.send({ type: 'device.list' })
    const off = sock.on((msg) => {
      if (msg.type === 'device.list') setDevices(msg.devices)
      if (msg.type === 'device.change') {
        setDevices((prev) => {
          const i = prev.findIndex((d) => d.serial === msg.device.serial)
          if (i < 0) return [...prev, msg.device]
          const next = [...prev]
          next[i] = msg.device
          return next
        })
      }
    })
    return () => {
      alive = false
      window.clearInterval(timer)
      off()
      sock.close()
    }
  }, [token])

  const filtered = useMemo(() => {
    if (!q.trim()) return devices
    const needle = q.toLowerCase()
    return devices.filter((d) =>
      [d.serial, d.model, d.manufacturer, d.version, d.notes, d.owner?.email, d.platform]
        .filter(Boolean)
        .some((v) => String(v).toLowerCase().includes(needle)),
    )
  }, [devices, q])

  async function onAsk(e: FormEvent) {
    e.preventDefault()
    if (!ask.trim()) return
    setError('')
    setReport(null)
    try {
      const r = await api.assistQuery(ask)
      setAsked({ query: r.query, explanation: r.explanation, source: r.source })
      setDevices(r.devices)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  async function onRecommend() {
    setError('')
    try {
      setReport(await api.assistRecommend({ count: 4, text: ask.trim() || undefined, availableOnly: true }))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  async function reset() {
    setAsked(null)
    setReport(null)
    setAsk('')
    setDevices((await api.devices()).devices)
  }

  return (
    <div>
      <div className="toolbar">
        <div className="search">
          <input
            placeholder='Filter: model, serial, "android>=12", battery<20…'
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void api.devices(q).then((r) => setDevices(r.devices))
            }}
          />
        </div>
        <div className="stats">
          <span>{stats.devicesOnline} online</span>
          <span>{stats.devicesBusy} busy</span>
          <span>{stats.devicesTotal} total</span>
        </div>
        <button className="btn ghost small" onClick={() => void reset()}>
          Refresh
        </button>
      </div>

      <form className="assist" onSubmit={onAsk}>
        <span className="assist-label">✦ Assistant</span>
        <input
          placeholder='Ask in plain English — "free Samsung phones on android 13 or newer"'
          value={ask}
          onChange={(e) => setAsk(e.target.value)}
        />
        <button className="btn small">Find</button>
        <button className="btn ghost small" type="button" onClick={() => void onRecommend()} title="Pick a small set of devices that covers the most OS versions, brands and screens">
          Suggest coverage set
        </button>
      </form>
      {error && <p style={{ color: 'var(--danger)' }}>{error}</p>}
      {asked && (
        <div className="notice">
          Interpreted as <code>{asked.query || '(everything)'}</code>{' '}
          <span className="meta">
            · {asked.source === 'llm' ? 'language model' : 'built-in parser'}
            {asked.explanation.length ? ` · ${asked.explanation.join('; ')}` : ''}
          </span>
        </div>
      )}
      {report && (
        <div className="notice">
          <strong>Suggested set</strong>
          {report.picks.length === 0 && <span> — no matching devices.</span>}
          <ul className="picks">
            {report.picks.map((p) => (
              <li key={p.serial}>
                <button className="link" onClick={() => nav(`/device/${encodeURIComponent(p.serial)}`)}>
                  {p.label}
                </button>
                <span className="meta"> — {p.reasons.join(', ')}</span>
              </li>
            ))}
          </ul>
          <div className="meta">
            Covers {report.coverage.sdkLevels.picked}/{report.coverage.sdkLevels.total} OS levels ·{' '}
            {report.coverage.manufacturers.picked}/{report.coverage.manufacturers.total} brands ·{' '}
            {report.coverage.screenSizes.picked}/{report.coverage.screenSizes.total} screen sizes ·{' '}
            {report.coverage.abis.picked}/{report.coverage.abis.total} ABIs
          </div>
          {report.notes.map((n) => (
            <div key={n} className="meta">
              {n}
            </div>
          ))}
        </div>
      )}

      {!filtered.length ? (
        <div className="empty">
          No devices to show. Plug in an Android phone with USB debugging enabled, or start the hub with <code>--fake 8</code>{' '}
          to try the simulator.
        </div>
      ) : (
        <div className="device-grid">
          {filtered.map((d, i) => {
            const picked = report?.picks.some((p) => p.serial === d.serial)
            return (
              <article
                key={d.serial}
                className={`device-tile${picked ? ' picked' : ''}`}
                style={{ animationDelay: `${Math.min(i, 12) * 40}ms` }}
                onClick={() => nav(`/device/${encodeURIComponent(d.serial)}`)}
              >
                <div className="badges">
                  <span className={`badge ${d.status}`}>{d.status}</span>
                  <span className={`badge ${d.platform}`}>{d.platform}</span>
                  {d.simulated && <span className="badge sim">sim</span>}
                </div>
                <h3>{d.marketName || d.model}</h3>
                <div className="meta">
                  <div>
                    {d.manufacturer} · {d.platform === 'ios' ? 'iOS' : 'Android'} {d.version}
                    {d.platform === 'android' ? ` (SDK ${d.sdk})` : ''}
                  </div>
                  <div>{d.serial}</div>
                  <div>
                    Battery {d.battery?.level ?? '—'}%{d.using && d.owner ? ` · ${d.owner.name}` : ''}
                  </div>
                  {d.notes ? <div>{d.notes}</div> : null}
                </div>
              </article>
            )
          })}
        </div>
      )}
    </div>
  )
}
