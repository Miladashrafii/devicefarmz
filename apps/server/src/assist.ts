import { compileDeviceQuery, parseNaturalQuery } from '@devicefarmz/core'
import { config } from './config.js'

export interface Interpretation {
  query: string
  explanation: string[]
  source: 'heuristic' | 'llm'
}

const SYSTEM_PROMPT = `You translate a request about a lab of phones into a search query.
Query language: whitespace-separated clauses, all must match.
  android>=13  android<=11  android=12  ios>=16  sdk>=33
  manufacturer:samsung  model:pixel  platform:android|ios
  battery>50  battery<20  available  busy  offline
  plain words match serial, model, manufacturer, owner, notes.
Answer with JSON only: {"query": "...", "explanation": ["short reason", ...]}`

async function viaLlm(text: string): Promise<Interpretation | null> {
  const { url, key, model } = config.llm
  if (!url) return null
  try {
    const res = await fetch(url.replace(/\/$/, '') + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) },
      body: JSON.stringify({
        model,
        temperature: 0,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: text },
        ],
      }),
      signal: AbortSignal.timeout(8000),
    })
    if (!res.ok) return null
    const json = (await res.json()) as { choices?: { message?: { content?: string } }[] }
    const content = json.choices?.[0]?.message?.content ?? ''
    const parsed = JSON.parse(content.match(/\{[\s\S]*\}/)?.[0] ?? '') as { query?: unknown; explanation?: unknown }
    if (typeof parsed.query !== 'string' || parsed.query.length > 300) return null
    compileDeviceQuery(parsed.query) // throws on garbage
    return {
      query: parsed.query.trim(),
      explanation: Array.isArray(parsed.explanation) ? parsed.explanation.map(String).slice(0, 8) : [],
      source: 'llm',
    }
  } catch {
    return null
  }
}

/** Uses the configured LLM when available and falls back to the built-in parser */
export async function interpret(text: string): Promise<Interpretation> {
  const clean = text.trim().slice(0, 500)
  const llm = await viaLlm(clean)
  if (llm) return llm
  const h = parseNaturalQuery(clean)
  return { query: h.query, explanation: h.explanation, source: 'heuristic' }
}