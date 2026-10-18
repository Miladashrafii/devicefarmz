import { useCallback, useEffect, useState } from 'react'
import type { AutomationSession, Recording } from '@devicefarmz/core'
import { api } from '../lib/api'

function fmtBytes(n: number): string {
  if (n > 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB`
  if (n > 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${n} B`
}

export function SessionsPage() {
  const [sessions, setSessions] = useState<AutomationSession[]>([])
  const [recordings, setRecordings] = useState<Recording[]>([])
  const [playing, setPlaying] = useState<Recording | null>(null)
  const [logText, setLogText] = useState('')
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    try {
      const [s, r] = await Promise.all([api.sessions(), api.recordings()])
      setSessions(s.sessions)
      setRecordings(r.recordings)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [])

  useEffect(() => {
    void load()
    const t = window.setInterval(() => void load(), 5000)
    return () => window.clearInterval(t)
  }, [load])

  async function open(rec: Recording) {
    setPlaying(rec)
    setLogText('')
    const res = await fetch(api.recordingUrl(rec.id, 'log'))
    setLogText(res.ok ? (await res.text()).slice(-20000) : '(no log captured)')
  }

  const now = Date.now()

  return (
    <div>
      <h2>Automation sessions</h2>
      <p className="meta">
        Devices reserved through the REST API, the CI helper or the Appium gateway. Leases expire on their own if the runner stops
        sending heartbeats.
      </p>
      {error && <p style={{ color: 'var(--danger)' }}>{error}</p>}
      {!sessions.length ? (
        <div className="empty">No automation sessions yet.</div>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>Device</th>
              <th>Owner</th>
              <th>Label</th>
              <th>Started</th>
              <th>State</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {sessions.map((s) => {
              const active = !s.releasedAt && new Date(s.expiresAt).getTime() > now
              return (
                <tr key={s.id}>
                  <td>
                    {s.serial} <span className={`badge ${s.platform}`}>{s.platform}</span>
                  </td>
                  <td>{s.ownerEmail}</td>
                  <td>{s.label || '—'}</td>
                  <td>{new Date(s.createdAt).toLocaleString()}</td>
                  <td>{active ? `active · expires ${new Date(s.expiresAt).toLocaleTimeString()}` : s.releasedAt ? 'released' : 'expired'}</td>
                  <td>
                    {active && (
                      <button className="btn ghost small" onClick={() => void api.releaseSession(s.id).then(load)}>
                        Release
                      </button>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}

      <h2 style={{ marginTop: '2rem' }}>Recordings</h2>
      {!recordings.length ? (
        <div className="empty">Nothing recorded yet. Press “Record” on a device screen.</div>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>Device</th>
              <th>Owner</th>
              <th>Started</th>
              <th>Status</th>
              <th>Size</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {recordings.map((r) => (
              <tr key={r.id}>
                <td>{r.serial}</td>
                <td>{r.ownerEmail}</td>
                <td>{new Date(r.startedAt).toLocaleString()}</td>
                <td>
                  {r.status}
                  {r.videoFormat ? ` · ${r.videoFormat}` : ''}
                </td>
                <td>
                  {fmtBytes(r.videoBytes)} video · {fmtBytes(r.logBytes)} log
                </td>
                <td style={{ whiteSpace: 'nowrap' }}>
                  <button className="btn ghost small" onClick={() => void open(r)}>
                    Open
                  </button>{' '}
                  <button
                    className="btn ghost small"
                    onClick={() => {
                      if (playing?.id === r.id) setPlaying(null)
                      void api.deleteRecording(r.id).then(load)
                    }}
                  >
                    Delete
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {playing && (
        <div className="viewer">
          <div className="toolbar">
            <strong>
              {playing.serial} · {new Date(playing.startedAt).toLocaleString()}
            </strong>
            <span style={{ flex: 1 }} />
            <button className="btn ghost small" onClick={() => setPlaying(null)}>
              Close
            </button>
          </div>
          <div className="viewer-grid">
            {playing.hasVideo && playing.videoFormat === 'mp4' ? (
              <video src={api.recordingUrl(playing.id, 'video')} controls style={{ maxHeight: '60vh', maxWidth: '100%' }} />
            ) : playing.hasVideo ? (
              <div className="meta">
                Stored as raw H.264 (ffmpeg was not available to make an mp4).{' '}
                <a href={api.recordingUrl(playing.id, 'video')} download>
                  Download .h264
                </a>
              </div>
            ) : (
              <div className="meta">No video was captured (this device only offers log capture).</div>
            )}
            <div className="log-view">{logText || 'Loading log…'}</div>
          </div>
        </div>
      )}
    </div>
  )
}
