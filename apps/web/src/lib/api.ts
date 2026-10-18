import type {
  ApiTokenInfo,
  AuthProviders,
  AutomationSession,
  CoverageReport,
  Device,
  Group,
  Recording,
  SessionInfo,
  User,
  WebhookConfig,
} from '@devicefarmz/core'

export const TOKEN_KEY = 'devicefarmz_token'

export function currentToken(): string | null {
  return localStorage.getItem(TOKEN_KEY)
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers)
  const t = currentToken()
  if (t) headers.set('Authorization', `Bearer ${t}`)
  if (init.body && !(init.body instanceof FormData)) headers.set('Content-Type', 'application/json')
  const res = await fetch(`/api${path}`, { ...init, headers })
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }))
    throw new Error(err.error || res.statusText)
  }
  return res.json() as Promise<T>
}

const json = (body: unknown) => JSON.stringify(body)

export interface Interpretation {
  query: string
  explanation: string[]
  source: 'heuristic' | 'llm'
}

export interface FarmConfig {
  name: string
  version: string
  auth: AuthProviders
  features: { h264: boolean; resetMode: string; autoRecord: boolean; ios: boolean; simulator: boolean; llm: boolean }
}

export interface Delivery {
  webhookId: string
  type: string
  url: string
  ok: boolean
  status: number | null
  attempts: number
  at: string
  error?: string
}

export const api = {
  config() {
    return request<FarmConfig>('/config')
  },
  providers() {
    return request<AuthProviders>('/auth/providers')
  },
  me() {
    return request<User>('/auth/me')
  },
  mockLogin(name: string, email: string) {
    return request<SessionInfo>('/auth/mock', { method: 'POST', body: json({ name, email }) })
  },
  ldapLogin(username: string, password: string) {
    return request<SessionInfo>('/auth/ldap', { method: 'POST', body: json({ username, password }) })
  },

  devices(q = '') {
    const qs = q ? `?q=${encodeURIComponent(q)}` : ''
    return request<{ devices: Device[] }>(`/devices${qs}`)
  },
  stats() {
    return request<{
      devicesTotal: number
      devicesOnline: number
      devicesBusy: number
      groupsActive: number
      uptimeSeconds: number
    }>('/stats')
  },
  releaseDevice(serial: string) {
    return request<Device>(`/devices/${encodeURIComponent(serial)}/owner`, { method: 'DELETE' })
  },
  installApk(serial: string, file: File) {
    const fd = new FormData()
    fd.append('apk', file)
    return request<{ ok: boolean; output?: string }>(`/devices/${encodeURIComponent(serial)}/install`, {
      method: 'POST',
      body: fd,
    })
  },
  identify(serial: string) {
    return request<{ ok: boolean }>(`/devices/${encodeURIComponent(serial)}/identify`, { method: 'POST' })
  },
  reboot(serial: string) {
    return request<{ ok: boolean }>(`/devices/${encodeURIComponent(serial)}/reboot`, { method: 'POST' })
  },

  users() {
    return request<{ users: User[] }>('/users')
  },
  createUser(body: { name: string; email: string; role?: string }) {
    return request<User>('/users', { method: 'POST', body: json(body) })
  },
  deleteUser(id: string) {
    return request<{ ok: boolean }>(`/users/${id}`, { method: 'DELETE' })
  },
  groups() {
    return request<{ groups: Group[] }>('/groups')
  },
  createGroup(body: Partial<Group> & { name: string }) {
    return request<Group>('/groups', { method: 'POST', body: json(body) })
  },
  deleteGroup(id: string) {
    return request<{ ok: boolean }>(`/groups/${id}`, { method: 'DELETE' })
  },

  // ---- assistant
  assistQuery(text: string) {
    return request<Interpretation & { devices: Device[] }>('/assist/query', { method: 'POST', body: json({ text }) })
  },
  assistRecommend(body: { count: number; text?: string; availableOnly?: boolean }) {
    return request<CoverageReport & { interpretation: Interpretation | null }>('/assist/recommend', {
      method: 'POST',
      body: json(body),
    })
  },

  // ---- automation + recordings
  sessions(activeOnly = false) {
    return request<{ sessions: AutomationSession[] }>(`/automation/sessions${activeOnly ? '?active=1' : ''}`)
  },
  releaseSession(id: string) {
    return request<unknown>(`/automation/sessions/${id}`, { method: 'DELETE' })
  },
  recordings() {
    return request<{ recordings: Recording[] }>('/recordings')
  },
  deleteRecording(id: string) {
    return request<{ ok: boolean }>(`/recordings/${id}`, { method: 'DELETE' })
  },
  recordingUrl(id: string, kind: 'video' | 'log') {
    return `/api/recordings/${id}/${kind}?token=${encodeURIComponent(currentToken() ?? '')}`
  },

  // ---- tokens + webhooks
  tokens() {
    return request<{ tokens: ApiTokenInfo[] }>('/tokens')
  },
  createToken(title: string) {
    return request<{ token: string; info: ApiTokenInfo }>('/tokens', { method: 'POST', body: json({ title }) })
  },
  revokeToken(id: string) {
    return request<{ ok: boolean }>(`/tokens/${id}`, { method: 'DELETE' })
  },
  webhooks() {
    return request<{ webhooks: WebhookConfig[]; events: string[] }>('/webhooks')
  },
  createWebhook(url: string, events: string[]) {
    return request<{ webhook: WebhookConfig; secret: string }>('/webhooks', {
      method: 'POST',
      body: json({ url, events }),
    })
  },
  deleteWebhook(id: string) {
    return request<{ ok: boolean }>(`/webhooks/${id}`, { method: 'DELETE' })
  },
  testWebhook(id: string) {
    return request<Delivery>(`/webhooks/${id}/test`, { method: 'POST' })
  },
  deliveries() {
    return request<{ deliveries: Delivery[] }>('/webhooks/deliveries')
  },
}
