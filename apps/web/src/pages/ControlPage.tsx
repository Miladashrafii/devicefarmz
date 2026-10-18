import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type PointerEvent } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import type { Device, FileEntry, ScreenPreference } from '@devicefarmz/core'
import { nanoid } from '../lib/nanoid'
import { api } from '../lib/api'
import { FarmSocket } from '../lib/ws'
import { H264Player, h264Supported } from '../lib/h264'
import { useAuth } from '../state/auth'

type Tab = 'shell' | 'logs' | 'files' | 'apps' | 'info'

export function ControlPage() {
  const { serial = '' } = useParams()
  const { token, user } = useAuth()
  const nav = useNavigate()
  const [device, setDevice] = useState<Device | null>(null)
  const [mode, setMode] = useState<ScreenPreference | null>(null)
  const [hasFrame, setHasFrame] = useState(false)
  const [recording, setRecording] = useState(false)
  const [tab, setTab] = useState<Tab>('shell')
  const [shellCmd, setShellCmd] = useState('getprop ro.product.model')
  const [shellOut, setShellOut] = useState('')
  const [logs, setLogs] = useState<string[]>([])
  const [logFilter, setLogFilter] = useState('')
  const [files, setFiles] = useState<FileEntry[]>([])
  const [filePath, setFilePath] = useState('/sdcard')
  const [url, setUrl] = useState('https://example.com')
  const [toast, setToast] = useState('')
  const [text, setText] = useState('')
  const sockRef = useRef<FarmSocket | null>(null)
  const imgRef = useRef<HTMLImageElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const playerRef = useRef<H264Player | null>(null)
  const pointerDown = useRef(false)
  const lastMove = useRef(0)
  const logsOpen = useRef(false)
  const logFilterRef = useRef('')
  const logBox = useRef<HTMLDivElement | null>(null)
  const shellBox = useRef<HTMLDivElement | null>(null)

  const say = useCallback((message: string) => {
    setToast(message)
    window.setTimeout(() => setToast((t) => (t === message ? '' : t)), 4000)
  }, [])

  const mine = Boolean(device?.using && device.owner?.email === user?.email)

  useEffect(() => {
    if (!token || !serial) return
    const sock = new FarmSocket(token)
    sockRef.current = sock
    const prefer: ScreenPreference = h264Supported() ? 'h264' : 'frames'

    const offMsg = sock.on((msg) => {
      switch (msg.type) {
        case 'device.list':
          setDevice(msg.devices.find((d) => d.serial === serial) ?? null)
          break
        case 'device.change':
          if (msg.device.serial === serial) setDevice(msg.device)
          break
        case 'screen.mode':
          if (msg.serial === serial) setMode(msg.mode)
          break
        case 'screen.frame':
          if (msg.serial === serial && imgRef.current) {
            imgRef.current.src = `data:${msg.mime || 'image/png'};base64,${msg.data}`
            setHasFrame(true)
          }
          break
        case 'record.state':
          if (msg.serial === serial) setRecording(msg.recording)
          break
        case 'shell.output':
          setShellOut((s) => s + msg.chunk)
          break
        case 'shell.done':
          setShellOut((s) => s + `\n[exit ${msg.code}]\n`)
          break
        case 'log.line':
          if (msg.serial === serial) setLogs((prev) => [...prev.slice(-600), msg.line])
          break
        case 'file.list':
          if (msg.serial === serial) {
            setFiles(msg.entries)
            setFilePath(msg.path)
          }
          break
        case 'notify':
          say(msg.message)
          break
        case 'device.error':
          if (msg.serial === serial) say(msg.message)
          break
      }
    })

    const offBin = sock.onBinary((s, nal) => {
      if (s !== serial) return
      const canvas = canvasRef.current
      if (!canvas) return
      if (!playerRef.current) {
        const p = new H264Player(canvas)
        p.onSize = () => setHasFrame(true)
        p.onError = (m) => say(`Decoder: ${m}`)
        playerRef.current = p
      }
      playerRef.current.push(nal)
    })

    // (Re)subscribe whenever the socket authenticates — also after a reconnect
    const offReady = sock.ready(() => {
      playerRef.current?.destroy()
      playerRef.current = null
      sock.send({ type: 'device.list' })
      sock.send({ type: 'device.use', serial })
      sock.send({ type: 'screen.subscribe', serial, prefer, fps: 6 })
      if (logsOpen.current) sock.send({ type: 'log.subscribe', serial, filter: logFilterRef.current })
    })

    sock.connect()
    return () => {
      // The hub releases the device on its own shortly after we disconnect (grace period),
      // so a quick reload or navigation does not wipe the session.
      offMsg()
      offBin()
      offReady()
      playerRef.current?.destroy()
      playerRef.current = null
      sock.close()
      sockRef.current = null
    }
  }, [token, serial, say])

  useEffect(() => {
    logBox.current?.scrollTo({ top: logBox.current.scrollHeight })
  }, [logs])
  useEffect(() => {
    shellBox.current?.scrollTo({ top: shellBox.current.scrollHeight })
  }, [shellOut])

  const visible = (): HTMLElement | null => (mode === 'h264' ? canvasRef.current : imgRef.current)

  const toDeviceCoords = useMemo(
    () => (e: PointerEvent<HTMLDivElement>) => {
      const el = visible()
      const d = device?.display
      if (!el || !d) return null
      const rect = el.getBoundingClientRect()
      if (!rect.width || !rect.height) return null
      // Frame orientation can differ from the display's reported one after rotation
      const frameLandscape = rect.width > rect.height
      const dispLandscape = d.width > d.height
      const w = frameLandscape === dispLandscape ? d.width : d.height
      const h = frameLandscape === dispLandscape ? d.height : d.width
      const fx = Math.min(Math.max((e.clientX - rect.left) / rect.width, 0), 1)
      const fy = Math.min(Math.max((e.clientY - rect.top) / rect.height, 0), 1)
      return { x: fx * w, y: fy * h }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [device?.display, mode],
  )

  function touch(action: 'down' | 'move' | 'up', e: PointerEvent<HTMLDivElement>) {
    const pt = toDeviceCoords(e)
    if (!pt) return
    sockRef.current?.send({ type: 'input.touch', serial, contacts: [{ contact: 0, x: pt.x, y: pt.y, action }] })
  }

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (!mine) return
    pointerDown.current = true
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    touch('down', e)
  }
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (!pointerDown.current) return
    const now = performance.now()
    if (now - lastMove.current < 16) return
    lastMove.current = now
    touch('move', e)
  }
  const onPointerUp = (e: PointerEvent<HTMLDivElement>) => {
    if (!pointerDown.current) return
    pointerDown.current = false
    touch('up', e)
  }

  const nav_ = (type: 'input.back' | 'input.home' | 'input.recent' | 'input.power') => sockRef.current?.send({ type, serial })

  function runShell(e: FormEvent) {
    e.preventDefault()
    setShellOut((s) => s + `\n$ ${shellCmd}\n`)
    sockRef.current?.send({ type: 'shell.exec', serial, command: shellCmd, id: nanoid() })
  }

  function typeText(e: FormEvent) {
    e.preventDefault()
    if (!text) return
    sockRef.current?.send({ type: 'input.type', serial, text })
    setText('')
  }

  function openLogs(filter: string) {
    logsOpen.current = true
    logFilterRef.current = filter
    setLogs([])
    sockRef.current?.send({ type: 'log.subscribe', serial, filter })
  }

  async function onApk(file: File | null) {
    if (!file) return
    say('Installing…')
    try {
      const r = await api.installApk(serial, file)
      say(r.output?.split('\n').pop() || 'Install complete')
    } catch (err) {
      say(err instanceof Error ? err.message : String(err))
    }
  }

  async function release() {
    try {
      await api.releaseDevice(serial)
      nav('/')
    } catch (err) {
      say(err instanceof Error ? err.message : String(err))
    }
  }

  const title = device?.marketName || device?.model || serial

  return (
    <div>
      <div className="toolbar">
        <Link to="/" className="btn ghost small">
          ← Devices
        </Link>
        <div style={{ flex: 1 }}>
          <strong>{title}</strong>{' '}
          {device && <span className={`badge ${device.platform}`}>{device.platform}</span>}{' '}
          {device?.simulated && <span className="badge sim">simulated</span>}
          <div className="meta">
            {serial} · {device?.status || '…'}
            {device?.battery ? ` · ${device.battery.level}%` : ''}
            {mode ? ` · stream: ${mode === 'h264' ? 'H.264' : 'frames'}` : ''}
          </div>
        </div>
        <button
          className={`btn small ${recording ? 'danger' : 'ghost'}`}
          disabled={!mine}
          onClick={() => sockRef.current?.send({ type: recording ? 'record.stop' : 'record.start', serial })}
        >
          {recording ? '■ Stop recording' : '● Record'}
        </button>
        <button className="btn ghost small" disabled={!mine} onClick={() => void api.identify(serial).catch((e) => say(e.message))}>
          Identify
        </button>
        <button className="btn ghost small" disabled={!mine} onClick={() => void api.reboot(serial).catch((e) => say(e.message))}>
          Reboot
        </button>
        <button className="btn small" disabled={!mine} onClick={() => void release()}>
          Release
        </button>
      </div>

      {device && !mine && (
        <div className="notice">
          {device.using
            ? `In use by ${device.owner?.name ?? 'someone else'} — you are viewing only.`
            : `This device is ${device.status}; it cannot be controlled right now.`}
        </div>
      )}

      <div className="control-layout">
        <section className="screen-panel">
          <div
            className="screen-wrap"
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
          >
            <canvas ref={canvasRef} className="screen-media" style={{ display: mode === 'h264' && hasFrame ? 'block' : 'none' }} />
            <img
              ref={imgRef}
              className="screen-media"
              alt="Device screen"
              draggable={false}
              style={{ display: mode !== 'h264' && hasFrame ? 'block' : 'none' }}
            />
            {!hasFrame && <div className="empty">Waiting for screen stream…</div>}
          </div>
          <div className="nav-keys">
            <button className="btn ghost small" disabled={!mine} onClick={() => nav_('input.back')}>
              Back
            </button>
            <button className="btn ghost small" disabled={!mine} onClick={() => nav_('input.home')}>
              Home
            </button>
            <button className="btn ghost small" disabled={!mine} onClick={() => nav_('input.recent')}>
              Recents
            </button>
            <button className="btn ghost small" disabled={!mine} onClick={() => nav_('input.power')}>
              Power
            </button>
          </div>
        </section>

        <aside className="side-panel">
          <h2>Controls</h2>
          <form onSubmit={typeText} style={{ display: 'flex', gap: '0.5rem' }}>
            <input style={{ flex: 1 }} placeholder="Type text to device…" value={text} onChange={(e) => setText(e.target.value)} />
            <button className="btn small" disabled={!mine}>
              Send
            </button>
          </form>

          <div className="tabs">
            {(['shell', 'logs', 'files', 'apps', 'info'] as Tab[]).map((t) => (
              <button
                key={t}
                className={tab === t ? 'active' : ''}
                onClick={() => {
                  setTab(t)
                  if (t === 'logs' && !logsOpen.current) openLogs(logFilter)
                  if (t === 'files') sockRef.current?.send({ type: 'file.list', serial, path: filePath })
                }}
              >
                {t}
              </button>
            ))}
          </div>

          {tab === 'shell' && (
            <>
              <form onSubmit={runShell} style={{ display: 'flex', gap: '0.5rem' }}>
                <input style={{ flex: 1 }} value={shellCmd} onChange={(e) => setShellCmd(e.target.value)} />
                <button className="btn small" disabled={!mine}>
                  Run
                </button>
              </form>
              <div className="shell-view" ref={shellBox}>
                {shellOut || 'Shell output will appear here.'}
              </div>
            </>
          )}

          {tab === 'logs' && (
            <>
              <form
                onSubmit={(e) => {
                  e.preventDefault()
                  openLogs(logFilter)
                }}
                style={{ display: 'flex', gap: '0.5rem' }}
              >
                <input style={{ flex: 1 }} placeholder="Filter lines (case-insensitive)" value={logFilter} onChange={(e) => setLogFilter(e.target.value)} />
                <button className="btn ghost small">Apply</button>
                <button className="btn ghost small" type="button" onClick={() => setLogs([])}>
                  Clear
                </button>
              </form>
              <div className="log-view" ref={logBox}>
                {logs.join('\n') || 'Waiting for log lines…'}
              </div>
            </>
          )}

          {tab === 'files' && (
            <>
              <form
                onSubmit={(e) => {
                  e.preventDefault()
                  sockRef.current?.send({ type: 'file.list', serial, path: filePath })
                }}
                style={{ display: 'flex', gap: '0.5rem' }}
              >
                <input style={{ flex: 1 }} value={filePath} onChange={(e) => setFilePath(e.target.value)} />
                <button className="btn small">List</button>
              </form>
              <div className="log-view">
                {files.map((f) => (
                  <div key={f.path}>
                    <button
                      className="btn ghost small"
                      style={{ marginRight: 6 }}
                      onClick={() => f.isDir && sockRef.current?.send({ type: 'file.list', serial, path: f.path })}
                    >
                      {f.isDir ? '📁' : '📄'} {f.name}
                    </button>
                    {!f.isDir && <span className="meta">{f.size} B</span>}
                  </div>
                ))}
                {!files.length && <span className="meta">No entries.</span>}
              </div>
            </>
          )}

          {tab === 'apps' && (
            <>
              <label className="btn ghost small" style={{ display: 'inline-block', cursor: 'pointer' }}>
                Install APK
                <input type="file" accept=".apk" hidden onChange={(e) => void onApk(e.target.files?.[0] ?? null)} />
              </label>
              <form
                onSubmit={(e) => {
                  e.preventDefault()
                  sockRef.current?.send({ type: 'browser.open', serial, url })
                }}
                style={{ display: 'flex', gap: '0.5rem' }}
              >
                <input style={{ flex: 1 }} value={url} onChange={(e) => setUrl(e.target.value)} />
                <button className="btn small" disabled={!mine}>
                  Open URL
                </button>
              </form>
              <div className="field">
                <label>Reverse port forward</label>
                <button
                  className="btn ghost small"
                  type="button"
                  disabled={!mine}
                  onClick={() =>
                    sockRef.current?.send({ type: 'port.forward', serial, devicePort: 8080, targetHost: 'localhost', targetPort: 8080 })
                  }
                >
                  Map device:8080 → host:8080
                </button>
              </div>
            </>
          )}

          {tab === 'info' && device && (
            <div className="meta">
              <div>Platform: {device.platform}</div>
              <div>Manufacturer: {device.manufacturer}</div>
              <div>Model: {device.model}</div>
              <div>OS: {device.version} (SDK {device.sdk})</div>
              <div>Product: {device.product}</div>
              <div>ABI: {device.abi}</div>
              <div>
                Display: {device.display?.width}×{device.display?.height} @{device.display?.density}dpi
              </div>
              <div>IMEI: {device.phone.imei || '—'}</div>
              <div>Operator: {device.phone.network || '—'}</div>
              <div className="field" style={{ marginTop: '0.75rem' }}>
                <label>Device notes</label>
                <textarea
                  rows={3}
                  defaultValue={device.notes}
                  onBlur={(e) => sockRef.current?.send({ type: 'device.note', serial, notes: e.target.value })}
                />
              </div>
            </div>
          )}
        </aside>
      </div>
      {toast && <div className="toast">{toast}</div>}
    </div>
  )
}
