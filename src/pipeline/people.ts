import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'

const ARIA_DIR = path.join(os.homedir(), '.aria')
const PEOPLE_FILE = path.join(ARIA_DIR, 'people.jsonl')

export interface PersonRecord {
  name: string                 // canonical name (lowercased for key)
  displayName: string          // original casing
  firstSeen: number
  lastSeen: number
  mentions: number
  notes: string[]              // context snippets associated with this person
  tags: string[]               // e.g. 'investor', 'client', 'competitor', 'lead'
  lastOffer: number | null
  lastIntent: string | null
}

function ensureDir() {
  const dir = path.dirname(PEOPLE_FILE)
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
}

function loadAll(): Map<string, PersonRecord> {
  ensureDir()
  const map = new Map<string, PersonRecord>()
  if (!fs.existsSync(PEOPLE_FILE)) return map
  try {
    fs.readFileSync(PEOPLE_FILE, 'utf-8')
      .trim().split('\n').filter(Boolean)
      .forEach(l => {
        const r = JSON.parse(l) as PersonRecord
        map.set(r.name, r)
      })
  } catch (e) { console.error('[PEOPLE] loadAll parse failed:', e) }
  return map
}

function saveAll(map: Map<string, PersonRecord>) {
  ensureDir()
  const lines = Array.from(map.values()).map(r => JSON.stringify(r))
  fs.writeFileSync(PEOPLE_FILE, lines.join('\n') + '\n')
}

// ── Name extraction ────────────────────────────────────────────────────────

// Common first names to help the extractor
const NAME_PATTERNS = [
  /(?:talk(?:ed|ing)? to|meet(?:ing)? with|email(?:ed|ing)?|call(?:ed|ing)?|from|with|re:|about)\s+([A-Z][a-z]{1,14}(?:\s+[A-Z][a-z]{1,14})?)/g,
  /([A-Z][a-z]{1,14})\s+(?:said|asked|wants|needs|told|mentioned|replied|agreed|rejected|offered)/g,
  /(?:mr\.|ms\.|dr\.)\s+([A-Z][a-z]{1,14})/gi,
]

// Words that look like names but aren't
const NAME_BLACKLIST = new Set([
  'I', 'The', 'This', 'That', 'They', 'We', 'He', 'She', 'It', 'You',
  'Let', 'Get', 'Put', 'Set', 'Go', 'Do', 'Can', 'Will', 'Should',
  'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday',
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
  'ARIA', 'Ok', 'No', 'Yes', 'Hi', 'Hey', 'Ok', 'Right', 'Just', 'But',
  'And', 'Or', 'So', 'If', 'When', 'How', 'What', 'Why', 'Who', 'Where',
  'ServiceTitan', 'Jobber', 'Housecall',
])

export function extractNames(transcript: string): string[] {
  const found = new Set<string>()
  for (const pat of NAME_PATTERNS) {
    let m: RegExpExecArray | null
    const re = new RegExp(pat.source, pat.flags)
    while ((m = re.exec(transcript)) !== null) {
      const name = m[1].trim()
      if (!NAME_BLACKLIST.has(name) && name.length >= 2) {
        found.add(name)
      }
    }
  }
  return Array.from(found)
}

// ── Tag inference ──────────────────────────────────────────────────────────

function inferTags(transcript: string): string[] {
  const t = transcript.toLowerCase()
  const tags: string[] = []
  if (/invest(?:or|ing)|fund|capital|raise|pitch/.test(t)) tags.push('investor')
  if (/client|customer|account|contract|deal|close/.test(t)) tags.push('client')
  if (/competitor|servicetitan|jobber|housecall|rival/.test(t)) tags.push('competitor')
  if (/boss|manager|ceo|cfo|executive|team lead/.test(t)) tags.push('internal')
  if (/lead|prospect|demo|trial/.test(t)) tags.push('lead')
  if (/partner|vendor|supplier/.test(t)) tags.push('partner')
  return tags
}

// ── Update person record from transcript ──────────────────────────────────

export function updatePeopleFromTranscript(
  transcript: string,
  intent: string | null,
  offer: number | null
): PersonRecord[] {
  const names = extractNames(transcript)
  if (!names.length) return []

  const map = loadAll()
  const updated: PersonRecord[] = []

  for (const displayName of names) {
    const key = displayName.toLowerCase()
    const existing = map.get(key)
    const tags = inferTags(transcript)

    if (existing) {
      existing.lastSeen = Date.now()
      existing.mentions += 1
      if (intent) existing.lastIntent = intent
      if (offer !== null) existing.lastOffer = offer
      // add new context note (keep last 10)
      const snippet = transcript.slice(0, 120)
      if (!existing.notes.includes(snippet)) {
        existing.notes.push(snippet)
        if (existing.notes.length > 10) existing.notes.shift()
      }
      // merge tags
      for (const tag of tags) {
        if (!existing.tags.includes(tag)) existing.tags.push(tag)
      }
      map.set(key, existing)
      updated.push(existing)
      console.log(`[PEOPLE] updated ${displayName} — mentions=${existing.mentions} intent=${intent ?? 'none'}`)
    } else {
      const record: PersonRecord = {
        name: key,
        displayName,
        firstSeen: Date.now(),
        lastSeen: Date.now(),
        mentions: 1,
        notes: [transcript.slice(0, 120)],
        tags,
        lastOffer: offer,
        lastIntent: intent,
      }
      map.set(key, record)
      updated.push(record)
      console.log(`[PEOPLE] new person — ${displayName} tags=[${tags.join(',')}]`)
    }
  }

  saveAll(map)
  return updated
}

// ── Lookup ─────────────────────────────────────────────────────────────────

export function lookupPerson(name: string): PersonRecord | null {
  const map = loadAll()
  return map.get(name.toLowerCase()) ?? null
}

export function getAllPeople(): PersonRecord[] {
  return Array.from(loadAll().values()).sort((a, b) => b.lastSeen - a.lastSeen)
}

// ── Context string for ARIA prompt ────────────────────────────────────────

export function getPeopleContext(transcript: string): string {
  const names = extractNames(transcript)
  if (!names.length) return ''

  const parts: string[] = []
  for (const name of names) {
    const rec = lookupPerson(name)
    if (!rec) continue
    const line = `${rec.displayName}: ${rec.mentions} mention(s), tags=[${rec.tags.join(',')}]` +
      (rec.lastOffer ? `, last offer $${rec.lastOffer}` : '') +
      (rec.lastIntent ? `, last intent ${rec.lastIntent}` : '') +
      (rec.notes.length ? `. Last context: "${rec.notes[rec.notes.length - 1].slice(0, 80)}"` : '')
    parts.push(line)
  }

  return parts.length ? `Known people in conversation:\n${parts.join('\n')}` : ''
}