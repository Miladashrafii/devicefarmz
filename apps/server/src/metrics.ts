import client from 'prom-client'
import { registry } from './registry.js'
import * as db from './db.js'

const register = new client.Registry()
client.collectDefaultMetrics({ register })

const devicesTotal = new client.Gauge({
  name: 'devicefarmz_devices_total',
  help: 'Total known devices',
  registers: [register],
})
const devicesOnline = new client.Gauge({
  name: 'devicefarmz_devices_online',
  help: 'Online ready devices',
  registers: [register],
})
const devicesBusy = new client.Gauge({
  name: 'devicefarmz_devices_busy',
  help: 'Devices currently in use',
  registers: [register],
})
const usersTotal = new client.Gauge({
  name: 'devicefarmz_users_total',
  help: 'Registered users',
  registers: [register],
})
const groupsActive = new client.Gauge({
  name: 'devicefarmz_groups_active',
  help: 'Active groups',
  registers: [register],
})

export function refreshMetrics(): void {
  const devices = registry.list()
  devicesTotal.set(devices.length)
  devicesOnline.set(devices.filter((d) => d.presence === 'present' && d.ready).length)
  devicesBusy.set(devices.filter((d) => d.using).length)
  usersTotal.set(db.listUsers().length)
  groupsActive.set(db.listGroups().filter((g) => g.state === 'active').length)
}

export async function metricsText(): Promise<string> {
  refreshMetrics()
  return register.metrics()
}

export function snapshot() {
  refreshMetrics()
  const devices = registry.list()
  return {
    devicesTotal: devices.length,
    devicesOnline: devices.filter((d) => d.presence === 'present' && d.ready).length,
    devicesBusy: devices.filter((d) => d.using).length,
    usersOnline: 0,
    groupsActive: db.listGroups().filter((g) => g.state === 'active').length,
    uptimeSeconds: Math.floor(process.uptime()),
  }
}
