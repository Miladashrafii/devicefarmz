export type UserRole = 'user' | 'admin'
export type Platform = 'android' | 'ios'

export type DevicePresence = 'present' | 'absent' | 'offline' | 'unauthorized' | 'offline_connecting' | 'status_preparing'

export type DeviceStatus =
  | 'available'
  | 'busy'
  | 'preparing'
  | 'cleaning'
  | 'unauthorized'
  | 'offline'
  | 'automation'
  | 'maintenance'

export type GroupClass = 'once' | 'bookable' | 'standard' | 'quota'
export type GroupState = 'pending' | 'ready' | 'active' | 'expired'

export interface User {
  id: string
  email: string
  name: string
  role: UserRole
  groupQuota: number
  createdAt: string
  lastLoginAt: string | null
}

export interface BatteryInfo {
  level: number
  health: string
  source: string
  status: string
  temp: number
  voltage: number
}

export interface NetworkInfo {
  connected: boolean
  type: string | null
  subtype: string | null
  failover: boolean
  roaming: boolean
}

export interface DisplayInfo {
  id: number
  width: number
  height: number
  xdpi: number
  ydpi: number
  fps: number
  density: number
  rotation: number
  secure: boolean
}

export interface DeviceOwner {
  email: string
  name: string
  group?: string
}

export interface Device {
  serial: string
  platform: Platform
  /** True for virtual devices created by the built-in simulator */
  simulated: boolean
  model: string
  manufacturer: string
  version: string
  sdk: number
  marketName: string | null
  product: string | null
  abi: string | null
  cpuPlatform: string | null
  openGlVersion: string | null
  phone: {
    phoneNumber: string | null
    imei: string | null
    imsi: string | null
    iccid: string | null
    network: string | null
  }
  battery: BatteryInfo | null
  network: NetworkInfo | null
  display: DisplayInfo | null
  presence: DevicePresence
  status: DeviceStatus
  ready: boolean
  using: boolean
  owner: DeviceOwner | null
  notes: string
  groupId: string | null
  provider: string | null
  channel: string | null
  createdAt: string
  updatedAt: string
  lastSeenAt: string | null
  usages: number
}

export interface Group {
  id: string
  name: string
  class: GroupClass
  state: GroupState
  ownerEmail: string
  deviceSerials: string[]
  userEmails: string[]
  startTime: string | null
  stopTime: string | null
  repetitions: number
  durationMs: number | null
  createdAt: string
  updatedAt: string
}

export interface SessionInfo {
  token: string
  user: User
  expiresAt: string
}

export interface ProviderInfo {
  id: string
  name: string
  host: string
  port: number
  deviceCount: number
  lastHeartbeatAt: string
}

export interface MetricsSnapshot {
  devicesTotal: number
  devicesOnline: number
  devicesBusy: number
  usersOnline: number
  groupsActive: number
  uptimeSeconds: number
}

export interface Recording {
  id: string
  serial: string
  ownerEmail: string
  startedAt: string
  stoppedAt: string | null
  status: 'recording' | 'processing' | 'ready' | 'failed'
  hasVideo: boolean
  videoFormat: 'mp4' | 'h264' | null
  videoBytes: number
  logBytes: number
  note: string | null
}

export interface AutomationSession {
  id: string
  serial: string
  platform: Platform
  ownerEmail: string
  label: string | null
  createdAt: string
  expiresAt: string
  releasedAt: string | null
  appiumSessionId: string | null
  ttlSec: number
}

export interface AutomationCapabilities {
  platformName: string
  'appium:automationName': string
  'appium:udid': string
  'appium:deviceName': string
  'appium:platformVersion': string
}

export interface AutomationLease {
  session: AutomationSession
  device: Device
  capabilities: AutomationCapabilities
  adb: { host: string; serial: string } | null
}

export interface WebhookConfig {
  id: string
  url: string
  events: string[]
  active: boolean
  createdBy: string
  createdAt: string
}

export interface ApiTokenInfo {
  id: string
  title: string
  createdAt: string
  lastUsedAt: string | null
}

export interface AuthProviders {
  mock: boolean
  oidc: { enabled: boolean; label: string }
  ldap: { enabled: boolean }
}

export type FarmEventType =
  | 'device.online'
  | 'device.offline'
  | 'device.claimed'
  | 'device.released'
  | 'device.reset'
  | 'automation.started'
  | 'automation.ended'
  | 'recording.started'
  | 'recording.ready'
  | 'webhook.test'
