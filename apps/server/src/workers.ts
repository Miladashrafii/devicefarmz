import { config } from './config.js'
import { AndroidProvider } from './android.js'
import { IosProvider } from './ios.js'
import { SimulatedProvider } from './simulator.js'
import type { BaseWorker, ProviderBase } from './worker-base.js'

export const providers: ProviderBase[] = []

export function buildProviders(): ProviderBase[] {
  providers.length = 0
  if (config.androidEnabled) providers.push(new AndroidProvider())
  if (config.ios.enabled) providers.push(new IosProvider())
  if (config.fakeDevices > 0) providers.push(new SimulatedProvider(config.fakeDevices))
  return providers
}

export function getWorker(serial: string): BaseWorker | undefined {
  for (const p of providers) {
    const w = p.getWorker(serial)
    if (w) return w
  }
  return undefined
}

export function requireWorker(serial: string): BaseWorker {
  const w = getWorker(serial)
  if (!w) throw new Error('Device is not connected')
  return w
}
