#!/usr/bin/env node
/**
 * Downloads the two external tools the hub can use for real Android phones:
 *   - Android platform-tools (adb)           -> tools/platform-tools/
 *   - the scrcpy server jar (H.264 streaming) -> tools/scrcpy-server.jar
 * Both are optional: without them the hub still runs (simulator, or screenshot streaming).
 */
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const tools = path.join(root, 'tools')
const scrcpyVersion = process.env.SCRCPY_SERVER_VERSION || '3.1'
const only = process.argv[2] // "adb" | "scrcpy" | undefined

fs.mkdirSync(tools, { recursive: true })

async function download(url, dest) {
  process.stdout.write(`  downloading ${url}\n`)
  const res = await fetch(url, { redirect: 'follow' })
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`)
  const buf = Buffer.from(await res.arrayBuffer())
  fs.writeFileSync(dest, buf)
  return createHash('sha256').update(buf).digest('hex')
}

function unzip(zip, into) {
  const r =
    process.platform === 'win32'
      ? spawnSync('powershell', ['-NoProfile', '-Command', `Expand-Archive -Force -LiteralPath '${zip}' -DestinationPath '${into}'`], { stdio: 'inherit' })
      : spawnSync('unzip', ['-o', '-q', zip, '-d', into], { stdio: 'inherit' })
  if (r.status !== 0) throw new Error('Could not extract the archive (is `unzip` installed?)')
}

async function setupAdb() {
  const adbName = process.platform === 'win32' ? 'adb.exe' : 'adb'
  const target = path.join(tools, 'platform-tools', adbName)
  if (fs.existsSync(target)) return console.log(`adb already present: ${target}`)
  console.log('Installing Android platform-tools…')
  const os = { win32: 'windows', darwin: 'darwin', linux: 'linux' }[process.platform]
  if (!os) throw new Error(`Unsupported platform ${process.platform}`)
  const zip = path.join(tools, 'platform-tools.zip')
  await download(`https://dl.google.com/android/repository/platform-tools-latest-${os}.zip`, zip)
  unzip(zip, tools)
  fs.rmSync(zip, { force: true })
  if (process.platform !== 'win32') fs.chmodSync(target, 0o755)
  console.log(`  ok -> ${target}`)
}

async function setupScrcpy() {
  const jar = path.join(tools, 'scrcpy-server.jar')
  if (fs.existsSync(jar)) return console.log(`scrcpy server already present: ${jar}`)
  console.log(`Fetching scrcpy server v${scrcpyVersion} (Apache-2.0, used for H.264 screen streaming)…`)
  const sha = await download(
    `https://github.com/Genymobile/scrcpy/releases/download/v${scrcpyVersion}/scrcpy-server-v${scrcpyVersion}`,
    jar,
  )
  console.log(`  ok -> ${jar}\n  sha256 ${sha}`)
}

try {
  if (!only || only === 'adb') await setupAdb()
  if (!only || only === 'scrcpy') await setupScrcpy()
  console.log('\nDone. Run `npm run doctor` to check the setup.')
} catch (err) {
  console.error(`\nSetup failed: ${err.message}`)
  process.exit(1)
}
