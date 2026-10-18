import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { nanoid } from 'nanoid'
import type { Recording } from '@devicefarmz/core'
import { config, recordingsDir } from './config.js'
import * as db from './db.js'
import { emitEvent } from './events.js'
import { registry } from './registry.js'
import { requireWorker } from './workers.js'
import type { BaseWorker } from './worker-base.js'

interface Active {
  rec: Recording
  worker: BaseWorker
  video: fs.WriteStream | null
  log: fs.WriteStream
  onNal: (v: { data: Buffer }) => void
  onLog: (l: { line: string }) => void
  videoPath: string
  logPath: string
}

const active = new Map<string, Active>()
let watching = false

function paths(id: string) {
  const dir = recordingsDir()
  return {
    h264: path.join(dir, `${id}.h264`),
    mp4: path.join(dir, `${id}.mp4`),
    log: path.join(dir, `${id}.log`),
  }
}

export function isRecording(serial: string): Recording | null {
  return active.get(serial)?.rec ?? null
}

export async function startRecording(serial: string, ownerEmail: string, note?: string): Promise<Recording> {
  const existing = active.get(serial)
  if (existing) return existing.rec

  if (!watching) {
    watching = true
    registry.on('change', (d: { serial: string; presence: string }) => {
      if (d.presence !== 'present' && active.has(d.serial)) void stopRecording(d.serial)
    })
  }

  const worker = requireWorker(serial)
  fs.mkdirSync(recordingsDir(), { recursive: true })
  const id = nanoid(10)
  const p = paths(id)

  let hasVideo = false
  try {
    hasVideo = await worker.acquireVideo()
  } catch (err) {
    console.warn(`[recorder] video unavailable for ${serial}:`, (err as Error).message)
  }

  const rec: Recording = {
    id,
    serial,
    ownerEmail,
    startedAt: new Date().toISOString(),
    stoppedAt: null,
    status: 'recording',
    hasVideo,
    videoFormat: null,
    videoBytes: 0,
    logBytes: 0,
    note: note ?? null,
  }

  const video = hasVideo ? fs.createWriteStream(p.h264) : null
  const log = fs.createWriteStream(p.log)
  const onNal = (v: { data: Buffer }) => {
    video?.write(v.data)
    rec.videoBytes += v.data.length
  }
  const onLog = (l: { line: string }) => {
    log.write(l.line + '\n')
    rec.logBytes += l.line.length + 1
  }
  worker.on('video.nal', onNal)
  worker.on('log.line', onLog)
  worker.subscribeLogs()

  active.set(serial, { rec, worker, video, log, onNal, onLog, videoPath: p.h264, logPath: p.log })
  db.saveRecording(rec)
  emitEvent('recording.started', { id, serial, owner: ownerEmail, hasVideo })
  return rec
}

function closeStream(s: fs.WriteStream | null): Promise<void> {
  return new Promise((resolve) => {
    if (!s) return resolve()
    s.end(() => resolve())
  })
}

export async function stopRecording(serial: string): Promise<Recording | null> {
  const a = active.get(serial)
  if (!a) return null
  active.delete(serial)

  a.worker.off('video.nal', a.onNal)
  a.worker.off('log.line', a.onLog)
  a.worker.unsubscribeLogs()
  if (a.rec.hasVideo) a.worker.releaseVideo()
  await Promise.all([closeStream(a.video), closeStream(a.log)])

  const rec = a.rec
  rec.stoppedAt = new Date().toISOString()

  if (rec.hasVideo && rec.videoBytes > 0) {
    rec.status = 'processing'
    db.saveRecording(rec)
    void finalizeVideo(rec)
  } else {
    rec.hasVideo = false
    rec.status = 'ready'
    fs.rmSync(a.videoPath, { force: true })
    db.saveRecording(rec)
    emitEvent('recording.ready', { id: rec.id, serial: rec.serial, hasVideo: false })
  }
  return rec
}

/** Wraps the raw H.264 stream into an MP4 when ffmpeg is installed; otherwise keeps the raw stream */
async function finalizeVideo(rec: Recording): Promise<void> {
  const p = paths(rec.id)
  const converted = await new Promise<boolean>((resolve) => {
    const child = spawn(
      config.ffmpegPath,
      ['-y', '-loglevel', 'error', '-f', 'h264', '-framerate', '30', '-i', p.h264, '-c', 'copy', p.mp4],
      { windowsHide: true },
    )
    child.on('error', () => resolve(false))
    child.on('exit', (code) => resolve(code === 0))
  })
  if (converted) {
    fs.rmSync(p.h264, { force: true })
    rec.videoFormat = 'mp4'
    rec.videoBytes = fs.statSync(p.mp4).size
  } else {
    fs.rmSync(p.mp4, { force: true })
    rec.videoFormat = 'h264'
  }
  rec.status = 'ready'
  db.saveRecording(rec)
  emitEvent('recording.ready', { id: rec.id, serial: rec.serial, hasVideo: true, format: rec.videoFormat })
}

export function recordingFile(rec: Recording, kind: 'video' | 'log'): string | null {
  const p = paths(rec.id)
  const file = kind === 'log' ? p.log : rec.videoFormat === 'mp4' ? p.mp4 : p.h264
  return fs.existsSync(file) ? file : null
}

export function removeRecording(id: string): boolean {
  const rec = db.getRecording(id)
  if (!rec || [...active.values()].some((a) => a.rec.id === id)) return false
  const p = paths(id)
  for (const f of [p.h264, p.mp4, p.log]) fs.rmSync(f, { force: true })
  return db.deleteRecording(id)
}

export async function stopAllRecordings(): Promise<void> {
  await Promise.all([...active.keys()].map((s) => stopRecording(s)))
}
