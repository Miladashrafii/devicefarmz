/**
 * Device assistant: plain-language queries and test-coverage recommendations.
 * Pure functions, no network. The server can optionally layer an LLM on top.
 */

import type { Device } from './types.js'

export interface ParsedQuery {
  /** Query in the farm's search language, ready for filterDevices */
  query: string
  /** Human-readable explanation of how the text was interpreted */
  explanation: string[]
  /** Words that were not understood */
  ignored: string[]
}

const MANUFACTURERS: Record<string, string> = {
  samsung: 'manufacturer:samsung',
  galaxy: 'manufacturer:samsung',
  google: 'manufacturer:google',
  pixel: 'model:pixel',
  xiaomi: 'manufacturer:xiaomi',
  redmi: 'model:redmi',
  poco: 'model:poco',
  huawei: 'manufacturer:huawei',
  honor: 'manufacturer:honor',
  oneplus: 'manufacturer:oneplus',
  oppo: 'manufacturer:oppo',
  vivo: 'manufacturer:vivo',
  motorola: 'manufacturer:motorola',
  moto: 'manufacturer:motorola',
  sony: 'manufacturer:sony',
  nokia: 'manufacturer:nokia',
  realme: 'manufacturer:realme',
  asus: 'manufacturer:asus',
  lg: 'manufacturer:lg',
  iphone: 'platform:ios',
  ipad: 'platform:ios',
  ios: 'platform:ios',
  apple: 'platform:ios',
}

const STOP_WORDS = new Set([
  'a', 'an', 'the', 'with', 'and', 'or', 'that', 'has', 'have', 'is', 'are', 'me', 'give', 'show',
  'find', 'need', 'want', 'device', 'devices', 'phone', 'phones', 'please', 'for', 'to', 'of', 'any',
  'running', 'on', 'in', 'at', 'least', 'most', 'than', 'percent', 'version', 'newer', 'older', 'above',
  'below', 'over', 'under', 'more', 'less', 'higher', 'lower', 'charged', 'charge', 'level',
])

export function parseNaturalQuery(text: string): ParsedQuery {
  const original = text.toLowerCase().trim()
  let rest = ` ${original} `
  const clauses: string[] = []
  const explanation: string[] = []

  const take = (re: RegExp, fn: (m: RegExpMatchArray) => void) => {
    const m = rest.match(re)
    if (!m) return
    fn(m)
    rest = rest.replace(re, ' ')
  }

  // OS version ranges
  take(/\bandroid\s*(\d+(?:\.\d+)?)\s*(?:-|to|through|and)\s*(?:android\s*)?(\d+(?:\.\d+)?)\b/, (m) => {
    clauses.push(`android>=${m[1]}`, `android<=${m[2]}`)
    explanation.push(`Android ${m[1]} to ${m[2]}`)
  })
  take(/\bandroid\s*(\d+(?:\.\d+)?)\s*(?:\+|or\s+(?:newer|above|higher|later|more))/, (m) => {
    clauses.push(`android>=${m[1]}`)
    explanation.push(`Android ${m[1]} or newer`)
  })
  take(/\bandroid\s*(\d+(?:\.\d+)?)\s*(?:or\s+(?:older|below|lower|earlier|less))/, (m) => {
    clauses.push(`android<=${m[1]}`)
    explanation.push(`Android ${m[1]} or older`)
  })
  take(/\b(?:newer|above|over|higher)\s+than\s+android\s*(\d+(?:\.\d+)?)/, (m) => {
    clauses.push(`android>${m[1]}`)
    explanation.push(`newer than Android ${m[1]}`)
  })
  take(/\b(?:older|below|under|lower)\s+than\s+android\s*(\d+(?:\.\d+)?)/, (m) => {
    clauses.push(`android<${m[1]}`)
    explanation.push(`older than Android ${m[1]}`)
  })
  take(/\bandroid\s*(\d+(?:\.\d+)?)\b/, (m) => {
    clauses.push(`android=${m[1]}`)
    explanation.push(`Android ${m[1]}`)
  })
  take(/\bios\s*(\d+(?:\.\d+)?)\s*(?:\+|or\s+(?:newer|above|higher))/, (m) => {
    clauses.push(`ios>=${m[1]}`)
    explanation.push(`iOS ${m[1]} or newer`)
  })
  take(/\bios\s*(\d+(?:\.\d+)?)\b/, (m) => {
    clauses.push(`ios=${m[1]}`)
    explanation.push(`iOS ${m[1]}`)
  })
  take(/\bsdk\s*(>=|<=|>|<|=)?\s*(\d+)/, (m) => {
    clauses.push(`sdk${m[1] ?? '='}${m[2]}`)
    explanation.push(`SDK ${m[1] ?? '='} ${m[2]}`)
  })

  // Battery
  take(/\bbattery\s*(?:level\s*)?(?:is\s*)?(?:(?:above|over|more\s+than|greater\s+than|at\s+least)|>=?)\s*(\d+)/, (m) => {
    clauses.push(`battery>${m[1]}`)
    explanation.push(`battery above ${m[1]}%`)
  })
  take(/\bbattery\s*(?:level\s*)?(?:is\s*)?(?:(?:below|under|less\s+than|lower\s+than|at\s+most)|<=?)\s*(\d+)/, (m) => {
    clauses.push(`battery<${m[1]}`)
    explanation.push(`battery below ${m[1]}%`)
  })
  take(/\b(?:more|over|above)\s+than\s+(\d+)\s*%?\s*(?:battery|charge|charged)/, (m) => {
    clauses.push(`battery>${m[1]}`)
    explanation.push(`battery above ${m[1]}%`)
  })
  take(/\blow\s+battery\b/, () => {
    clauses.push('battery<20')
    explanation.push('low battery (<20%)')
  })
  take(/\b(?:fully\s+charged|full\s+battery)\b/, () => {
    clauses.push('battery>90')
    explanation.push('nearly full battery (>90%)')
  })

  // Availability
  take(/\b(?:available|free|idle|unused|not\s+in\s+use)\b/, () => {
    clauses.push('available')
    explanation.push('currently available')
  })
  take(/\b(?:busy|in\s+use|taken)\b/, () => {
    clauses.push('busy')
    explanation.push('currently in use')
  })
  take(/\boffline\b/, () => {
    clauses.push('offline')
    explanation.push('offline')
  })

  if (/\bandroid\b/.test(rest) && !clauses.some((c) => c.startsWith('android'))) {
    clauses.push('platform:android')
    explanation.push('Android devices')
    rest = rest.replace(/\bandroid\b/g, ' ')
  }

  const ignored: string[] = []
  for (const word of rest.split(/[^a-z0-9+]+/).filter(Boolean)) {
    if (STOP_WORDS.has(word)) continue
    if (/^\d+$/.test(word)) continue
    const mapped = MANUFACTURERS[word]
    if (mapped) {
      if (!clauses.includes(mapped)) {
        clauses.push(mapped)
        explanation.push(`matches "${word}"`)
      }
      continue
    }
    if (word.length >= 3) {
      clauses.push(word)
      explanation.push(`free text "${word}"`)
    } else {
      ignored.push(word)
    }
  }

  return { query: clauses.join(' '), explanation, ignored }
}

export interface CoverageOptions {
  minSdk?: number
  maxSdk?: number
  /** Only pick devices that can be claimed right now */
  availableOnly?: boolean
  platform?: 'android' | 'ios'
}

export interface CoveragePick {
  serial: string
  label: string
  reasons: string[]
  score: number
}

export interface CoverageReport {
  picks: CoveragePick[]
  coverage: {
    sdkLevels: { picked: number; total: number }
    manufacturers: { picked: number; total: number }
    screenSizes: { picked: number; total: number }
    abis: { picked: number; total: number }
  }
  notes: string[]
}

function screenBucket(d: Device): string {
  const w = Math.min(d.display?.width ?? 0, d.display?.height ?? 0)
  if (!w) return 'unknown'
  if (w < 720) return 'small'
  if (w < 1100) return 'medium'
  return 'large'
}

function features(d: Device): { key: string; label: string; weight: number }[] {
  return [
    { key: `sdk:${d.platform}:${d.sdk || d.version}`, label: `${d.platform === 'ios' ? 'iOS' : 'Android'} ${d.version}`, weight: 3 },
    { key: `mfr:${d.manufacturer.toLowerCase()}`, label: d.manufacturer, weight: 2 },
    { key: `screen:${screenBucket(d)}`, label: `${screenBucket(d)} screen`, weight: 1.5 },
    { key: `abi:${d.abi ?? 'n/a'}`, label: d.abi ?? 'unknown ABI', weight: 1 },
  ]
}

/**
 * Greedy selection of `count` devices that maximise OS / vendor / screen / ABI diversity.
 */
export function recommendCoverage(devices: Device[], count: number, opts: CoverageOptions = {}): CoverageReport {
  const notes: string[] = []
  const eligible = devices.filter((d) => {
    if (d.presence !== 'present' || !d.ready) return false
    if (opts.availableOnly && (d.using || d.status !== 'available')) return false
    if (opts.platform && d.platform !== opts.platform) return false
    if (opts.minSdk !== undefined && d.platform === 'android' && d.sdk < opts.minSdk) return false
    if (opts.maxSdk !== undefined && d.platform === 'android' && d.sdk > opts.maxSdk) return false
    return true
  })

  if (!eligible.length) notes.push('No eligible devices are online right now.')

  const seen = new Set<string>()
  const picks: CoveragePick[] = []
  const pool = [...eligible]

  while (picks.length < count && pool.length) {
    let bestIdx = 0
    let bestScore = -Infinity
    let bestNew: string[] = []
    pool.forEach((d, i) => {
      const fs = features(d)
      const fresh = fs.filter((f) => !seen.has(f.key))
      let score = fresh.reduce((s, f) => s + f.weight, 0)
      if (!d.using && d.status === 'available') score += 0.5
      score += (d.battery?.level ?? 0) / 200
      if (score > bestScore) {
        bestScore = score
        bestIdx = i
        bestNew = fresh.map((f) => f.label)
      }
    })
    const [chosen] = pool.splice(bestIdx, 1)
    for (const f of features(chosen)) seen.add(f.key)
    picks.push({
      serial: chosen.serial,
      label: `${chosen.marketName || chosen.model} (${chosen.platform === 'ios' ? 'iOS' : 'Android'} ${chosen.version})`,
      reasons: bestNew.length ? bestNew.map((l) => `adds ${l}`) : ['best remaining option'],
      score: Math.round(bestScore * 10) / 10,
    })
  }

  const distinct = (list: Device[], f: (d: Device) => string) => new Set(list.map(f)).size
  const chosenDevices = picks.map((p) => eligible.find((d) => d.serial === p.serial)!).filter(Boolean)
  if (count > eligible.length && eligible.length) {
    notes.push(`Only ${eligible.length} eligible device(s) available; requested ${count}.`)
  }

  return {
    picks,
    coverage: {
      sdkLevels: {
        picked: distinct(chosenDevices, (d) => `${d.platform}${d.sdk || d.version}`),
        total: distinct(eligible, (d) => `${d.platform}${d.sdk || d.version}`),
      },
      manufacturers: {
        picked: distinct(chosenDevices, (d) => d.manufacturer.toLowerCase()),
        total: distinct(eligible, (d) => d.manufacturer.toLowerCase()),
      },
      screenSizes: {
        picked: distinct(chosenDevices, screenBucket),
        total: distinct(eligible, screenBucket),
      },
      abis: {
        picked: distinct(chosenDevices, (d) => d.abi ?? 'n/a'),
        total: distinct(eligible, (d) => d.abi ?? 'n/a'),
      },
    },
    notes,
  }
}

export interface FleetMatrix {
  byAndroid: Record<string, number>
  byManufacturer: Record<string, number>
  byPlatform: Record<string, number>
  total: number
}

export function fleetMatrix(devices: Device[]): FleetMatrix {
  const byAndroid: Record<string, number> = {}
  const byManufacturer: Record<string, number> = {}
  const byPlatform: Record<string, number> = {}
  for (const d of devices) {
    const os = `${d.platform === 'ios' ? 'iOS' : 'Android'} ${d.version}`
    byAndroid[os] = (byAndroid[os] ?? 0) + 1
    byManufacturer[d.manufacturer] = (byManufacturer[d.manufacturer] ?? 0) + 1
    byPlatform[d.platform] = (byPlatform[d.platform] ?? 0) + 1
  }
  return { byAndroid, byManufacturer, byPlatform, total: devices.length }
}