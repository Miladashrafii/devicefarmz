import assert from 'node:assert/strict'
import test from 'node:test'
import { filterDevices, parseNaturalQuery, recommendCoverage, type Device } from '../src/index.js'

function device(over: Partial<Device> & { serial: string }): Device {
  return {
    platform: 'android',
    simulated: false,
    model: 'Model',
    manufacturer: 'Acme',
    version: '13',
    sdk: 33,
    marketName: null,
    product: null,
    abi: 'arm64-v8a',
    cpuPlatform: null,
    openGlVersion: null,
    phone: { phoneNumber: null, imei: null, imsi: null, iccid: null, network: null },
    battery: { level: 80, health: 'good', source: 'usb', status: 'charging', temp: 30, voltage: 4000 },
    network: null,
    display: { id: 0, width: 1080, height: 2400, xdpi: 0, ydpi: 0, fps: 60, density: 420, rotation: 0, secure: false },
    presence: 'present',
    status: 'available',
    ready: true,
    using: false,
    owner: null,
    notes: '',
    groupId: null,
    provider: null,
    channel: null,
    createdAt: '',
    updatedAt: '',
    lastSeenAt: null,
    usages: 0,
    ...over,
  }
}

const fleet = [
  device({ serial: 'A', manufacturer: 'Google', model: 'Pixel 8', version: '14', sdk: 34 }),
  device({ serial: 'B', manufacturer: 'Samsung', model: 'Galaxy S23', version: '13', sdk: 33 }),
  device({ serial: 'C', manufacturer: 'Samsung', model: 'Galaxy A14', version: '12', sdk: 31, battery: { level: 15, health: 'good', source: 'usb', status: 'charging', temp: 30, voltage: 4000 } }),
  device({ serial: 'D', manufacturer: 'Nokia', model: 'G20', version: '8.1.0', sdk: 27, abi: 'armeabi-v7a', display: { id: 0, width: 720, height: 1600, xdpi: 0, ydpi: 0, fps: 60, density: 320, rotation: 0, secure: false } }),
  device({ serial: 'E', manufacturer: 'Apple', model: 'iPhone 14', platform: 'ios', version: '17.0', sdk: 0, abi: 'arm64' }),
]

test('query language compares versions numerically, including 8.1.0', () => {
  assert.deepEqual(filterDevices(fleet, 'android>=12').map((d) => d.serial), ['A', 'B', 'C'])
  assert.deepEqual(filterDevices(fleet, 'android<10').map((d) => d.serial), ['D'])
  assert.deepEqual(filterDevices(fleet, 'ios>=16').map((d) => d.serial), ['E'])
})

test('natural language: samsung with android 12+ and healthy battery', () => {
  const parsed = parseNaturalQuery('I need a Samsung phone with Android 12 or newer and battery above 50')
  assert.match(parsed.query, /manufacturer:samsung/)
  assert.match(parsed.query, /android>=12/)
  assert.match(parsed.query, /battery>50/)
  assert.deepEqual(filterDevices(fleet, parsed.query).map((d) => d.serial), ['B'])
})

test('natural language: ranges, iPhone and availability', () => {
  assert.match(parseNaturalQuery('android 9 to 13').query, /android>=9 android<=13/)
  assert.match(parseNaturalQuery('any iphone').query, /platform:ios/)
  assert.match(parseNaturalQuery('free pixel').query, /available.*model:pixel|model:pixel.*available/)
})

test('coverage recommender prefers diverse devices', () => {
  const report = recommendCoverage(fleet, 3)
  assert.equal(report.picks.length, 3)
  const serials = report.picks.map((p) => p.serial)
  assert.equal(new Set(serials).size, 3)
  // The two Samsungs must not both be chosen before the other vendors
  assert.ok(!(serials.includes('B') && serials.includes('C')))
  assert.ok(report.coverage.manufacturers.picked >= 3)
})

test('coverage recommender honours filters and reports shortage', () => {
  const report = recommendCoverage(fleet, 5, { platform: 'android', minSdk: 31 })
  assert.deepEqual(report.picks.map((p) => p.serial).sort(), ['A', 'B', 'C'])
  assert.ok(report.notes.some((n) => n.includes('Only 3')))
})
