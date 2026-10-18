import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEFAULT_PORTS } from '@devicefarmz/core'

const here = path.dirname(fileURLToPath(import.meta.url))
/** Repository root (apps/server/{src,dist} -> ../../..) regardless of the current working directory */
export const repoRoot = path.resolve(here, '../../..')

function env(name: string, fallback = ''): string {
  return process.env[name] ?? fallback
}

function bool(name: string, fallback: boolean): boolean {
  const v = process.env[name]
  if (v === undefined || v === '') return fallback
  return v === 'true' || v === '1'
}

function list(name: string): string[] {
  return env(name)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

function findTool(name: string, ...relative: string[]): string {
  const exe = process.platform === 'win32' ? `${name}.exe` : name
  const local = path.join(repoRoot, 'tools', ...relative, exe)
  return fs.existsSync(local) ? local : name
}

export type ResetMode = 'none' | 'clean' | 'uninstall'

export interface Config {
  [key: string]: unknown
}

/** Re-evaluated on every access so tests and CLI flags can set env vars before use */
function build() {
  const oidcIssuer = env('DEVICEFARMZ_OIDC_ISSUER')
  const ldapUrl = env('DEVICEFARMZ_LDAP_URL')
  const externalAuth = Boolean(oidcIssuer || ldapUrl)

  return {
    dataDir: path.resolve(env('DEVICEFARMZ_DATA', path.join(repoRoot, 'data'))),
    jwtSecret: env('DEVICEFARMZ_JWT_SECRET', 'devicefarmz-dev-secret-change-me'),
    publicIp: env('DEVICEFARMZ_PUBLIC_IP', 'localhost'),
    hubPort: Number(env('DEVICEFARMZ_PORT', String(DEFAULT_PORTS.hub))),
    publicUrl: env('DEVICEFARMZ_PUBLIC_URL', ''),
    adbPath: env('ADB_PATH') || findTool('adb', 'platform-tools'),
    ffmpegPath: env('FFMPEG_PATH', 'ffmpeg'),
    screencapFps: Number(env('DEVICEFARMZ_SCREEN_FPS', '4')),
    adminName: env('DEVICEFARMZ_ADMIN_NAME', 'administrator'),
    adminEmail: env('DEVICEFARMZ_ADMIN_EMAIL', 'administrator@fakedomain.com'),
    rootGroupName: env('DEVICEFARMZ_ROOT_GROUP_NAME', 'Common'),
    /** Mock login defaults to on only when no real identity provider is configured */
    mockAuth: bool('DEVICEFARMZ_MOCK_AUTH', !externalAuth),
    providerName: env('DEVICEFARMZ_PROVIDER_NAME', 'local'),
    serialFilter: list('DEVICEFARMZ_SERIALS'),
    fakeDevices: Number(env('DEVICEFARMZ_FAKE_DEVICES', '0')),
    androidEnabled: bool('DEVICEFARMZ_ANDROID', true),

    resetMode: env('DEVICEFARMZ_RESET_MODE', 'clean') as ResetMode,
    resetKeepPackages: list('DEVICEFARMZ_RESET_KEEP'),
    releaseGraceMs: Number(env('DEVICEFARMZ_RELEASE_GRACE_MS', '20000')),

    autoRecord: bool('DEVICEFARMZ_AUTO_RECORD', false),

    scrcpy: {
      enabled: bool('DEVICEFARMZ_SCRCPY', true),
      jar: env('SCRCPY_SERVER_JAR', path.join(repoRoot, 'tools', 'scrcpy-server.jar')),
      version: env('SCRCPY_SERVER_VERSION', '3.1'),
      maxSize: Number(env('DEVICEFARMZ_VIDEO_MAX_SIZE', '1024')),
      bitRate: Number(env('DEVICEFARMZ_VIDEO_BITRATE', '4000000')),
      maxFps: Number(env('DEVICEFARMZ_VIDEO_MAX_FPS', '30')),
    },

    ios: {
      enabled: bool('DEVICEFARMZ_IOS', false),
      ideviceId: env('IDEVICE_ID_PATH', 'idevice_id'),
      ideviceInfo: env('IDEVICEINFO_PATH', 'ideviceinfo'),
      ideviceInstaller: env('IDEVICEINSTALLER_PATH', 'ideviceinstaller'),
      iproxy: env('IPROXY_PATH', 'iproxy'),
      /** "UDID=http://host:8100,UDID2=http://host:8101"; otherwise iproxy is started on basePort+n */
      wdaUrls: Object.fromEntries(
        list('DEVICEFARMZ_WDA_URLS').map((p) => {
          const i = p.indexOf('=')
          return [p.slice(0, i), p.slice(i + 1)]
        }),
      ) as Record<string, string>,
      wdaBasePort: Number(env('DEVICEFARMZ_WDA_BASE_PORT', '8100')),
    },

    appiumUrl: env('DEVICEFARMZ_APPIUM_URL', 'http://127.0.0.1:4723'),

    oidc: {
      issuer: oidcIssuer,
      clientId: env('DEVICEFARMZ_OIDC_CLIENT_ID'),
      clientSecret: env('DEVICEFARMZ_OIDC_CLIENT_SECRET'),
      redirectUri: env('DEVICEFARMZ_OIDC_REDIRECT_URI'),
      scopes: env('DEVICEFARMZ_OIDC_SCOPES', 'openid email profile'),
      label: env('DEVICEFARMZ_OIDC_LABEL', 'Single sign-on'),
      groupClaim: env('DEVICEFARMZ_OIDC_GROUP_CLAIM', 'groups'),
      adminGroup: env('DEVICEFARMZ_OIDC_ADMIN_GROUP'),
    },

    ldap: {
      url: ldapUrl,
      bindDn: env('DEVICEFARMZ_LDAP_BIND_DN'),
      bindPassword: env('DEVICEFARMZ_LDAP_BIND_PASSWORD'),
      baseDn: env('DEVICEFARMZ_LDAP_BASE_DN'),
      userFilter: env('DEVICEFARMZ_LDAP_USER_FILTER', '(uid={{username}})'),
      adminGroup: env('DEVICEFARMZ_LDAP_ADMIN_GROUP'),
      mailAttr: env('DEVICEFARMZ_LDAP_MAIL_ATTR', 'mail'),
      nameAttr: env('DEVICEFARMZ_LDAP_NAME_ATTR', 'cn'),
    },

    adminEmails: list('DEVICEFARMZ_ADMIN_EMAILS'),

    llm: {
      url: env('DEVICEFARMZ_LLM_URL'),
      key: env('DEVICEFARMZ_LLM_KEY'),
      model: env('DEVICEFARMZ_LLM_MODEL', 'gpt-4o-mini'),
    },
  }
}

type BuiltConfig = ReturnType<typeof build>

/** Live view over environment variables */
export const config: BuiltConfig = new Proxy({} as BuiltConfig, {
  get(_t, prop: string) {
    return build()[prop as keyof BuiltConfig]
  },
})

export function dbPath(): string {
  return path.join(config.dataDir, 'devicefarmz.db')
}

export function uploadsDir(): string {
  return path.join(config.dataDir, 'uploads')
}

export function recordingsDir(): string {
  return path.join(config.dataDir, 'recordings')
}

export function scrcpyAvailable(): boolean {
  return config.scrcpy.enabled && fs.existsSync(config.scrcpy.jar)
}
