import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { CONFIG } from '../config.js'

// ── Storage paths ──────────────────────────────────────────────────────────
const ARIA_DIR = path.join(os.homedir(), '.aria')
const HISTORY_FILE = path.join(ARIA_DIR, 'history.jsonl')
const KB_DIR = path.join(ARIA_DIR, 'knowledge')

// ── Types ──────────────────────────────────────────────────────────────────
interface KBChunk {
  id: string
  source: string
  text: string
  embedding?: number[]
}

interface HistoryEntry {
  ts: number
  transcript: string
  intent: string | null
  response: string | null
}

// ── Init dirs ──────────────────────────────────────────────────────────────
function ensureDirs() {
  if (!fs.existsSync(ARIA_DIR)) fs.mkdirSync(ARIA_DIR, { recursive: true })
  if (!fs.existsSync(KB_DIR)) fs.mkdirSync(KB_DIR, { recursive: true })
}

ensureDirs()

// ── Embedding helper ───────────────────────────────────────────────────────
async function embed(text: string): Promise<number[]> {
  try {
    const res = await fetch(`${CONFIG.OLLAMA_URL.replace('/api/chat', '/api/embed')}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'nomic-embed-text', input: text }),
      signal: AbortSignal.timeout(CONFIG.OLLAMA_EMBED_TIMEOUT_MS),
    })
    const data = await res.json() as { embeddings: number[][] }
    return data.embeddings[0] ?? []
  } catch (e) {
    console.error('[RAG] embed failed:', e)
    return []
  }
}

function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]
  }
  if (na === 0 || nb === 0) return 0
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

// ── Knowledge base ─────────────────────────────────────────────────────────
const chunks: KBChunk[] = []
let kbLoaded = false

function chunkText(text: string, source: string, chunkSize = 300): KBChunk[] {
  const sentences = text.split(/(?<=[.!?])\s+/)
  const result: KBChunk[] = []
  let current = ''
  let idx = 0

  for (const s of sentences) {
    if ((current + s).length > chunkSize && current) {
      result.push({ id: `${source}:${idx++}`, source, text: current.trim() })
      current = s + ' '
    } else {
      current += s + ' '
    }
  }
  if (current.trim()) result.push({ id: `${source}:${idx}`, source, text: current.trim() })
  return result
}

export async function loadKnowledgeBase(): Promise<void> {
  if (kbLoaded) return
  if (!fs.existsSync(KB_DIR)) return

  const files = fs.readdirSync(KB_DIR).filter(f => {
    // Reject any entry that contains a path separator — prevents traversal
    const base = path.basename(f)
    return base === f && (f.endsWith('.txt') || f.endsWith('.md'))
  })
  console.log(`[RAG] loading ${files.length} knowledge file(s)...`)

  for (const file of files) {
    const text = fs.readFileSync(path.join(KB_DIR, file), 'utf-8')
    const fileChunks = chunkText(text, file)
    for (const chunk of fileChunks) {
      chunk.embedding = await embed(chunk.text)
      chunks.push(chunk)
    }
    console.log(`[RAG] loaded ${file} → ${fileChunks.length} chunks`)
  }

  kbLoaded = true
  console.log(`[RAG] knowledge base ready — ${chunks.length} total chunks`)
}

export async function searchKB(query: string, topK = 3): Promise<KBChunk[]> {
  if (chunks.length === 0) return []
  const qEmbed = await embed(query)
  return chunks
    .map(c => ({ chunk: c, score: cosine(qEmbed, c.embedding!) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
    .filter(r => r.score > 0.65)
    .map(r => r.chunk)
}

// ── Persistent conversation history ───────────────────────────────────────
export function saveToHistory(entry: HistoryEntry): void {
  try {
    fs.appendFileSync(HISTORY_FILE, JSON.stringify(entry) + '\n')
  } catch (e) { console.error('[RAG] saveToHistory failed:', e) }
}

export function loadRecentHistory(hours = 24, max = 30): HistoryEntry[] {
  if (!fs.existsSync(HISTORY_FILE)) return []
  const cutoff = Date.now() - hours * 3600 * 1000
  try {
    const lines = fs.readFileSync(HISTORY_FILE, 'utf-8').trim().split('\n').filter(Boolean)
    return lines
      .map(l => JSON.parse(l) as HistoryEntry)
      .filter(e => e.ts > cutoff)
      .slice(-max)
  } catch (e) {
    console.error('[RAG] loadRecentHistory failed:', e)
    return []
  }
}

// ── Web search (via DuckDuckGo instant answer API — no key needed) ─────────
export async function webSearch(query: string): Promise<string | null> {
  try {
    const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`
    const res = await fetch(url, { signal: AbortSignal.timeout(CONFIG.WEB_SEARCH_TIMEOUT_MS) })
    const data = await res.json() as {
      AbstractText?: string
      Answer?: string
      RelatedTopics?: Array<{ Text?: string }>
    }

    if (data.Answer) return data.Answer
    if (data.AbstractText) return data.AbstractText.slice(0, 400)

    const topics = data.RelatedTopics?.slice(0, 2).map(t => t.Text).filter(Boolean)
    if (topics?.length) return topics.join(' | ').slice(0, 400)

    return null
  } catch (e) {
    console.error('[RAG] webSearch failed:', e)
    return null
  }
}

// ── Main RAG query — combines all sources ─────────────────────────────────
export async function ragQuery(
  query: string,
  opts: { useWeb?: boolean; useHistory?: boolean; useKB?: boolean } = {}
): Promise<string> {
  const { useWeb = true, useHistory = true, useKB = true } = opts
  const parts: string[] = []

  // 1. Personal knowledge base
  if (useKB && chunks.length > 0) {
    const kbResults = await searchKB(query)
    if (kbResults.length > 0) {
      parts.push(`From your notes:\n${kbResults.map(c => `[${c.source}] ${c.text}`).join('\n')}`)
    }
  }

  // 2. Conversation history
  if (useHistory) {
    const history = loadRecentHistory(24, 10)
    if (history.length > 0) {
      const relevant = history
        .filter(e => e.transcript.toLowerCase().split(' ').some(w => query.toLowerCase().includes(w)))
        .slice(-5)
      if (relevant.length > 0) {
        parts.push(`From past conversations:\n${relevant.map(e =>
          `[${new Date(e.ts).toLocaleTimeString()}] "${e.transcript}"${e.response ? ` → ${e.response}` : ''}`
        ).join('\n')}`)
      }
    }
  }

  // 3. Web search
  if (useWeb) {
    const webResult = await webSearch(query)
    if (webResult) {
      parts.push(`From web: ${webResult}`)
    }
  }

  return parts.join('\n\n')
}

// ── Add a note to knowledge base ──────────────────────────────────────────
export async function addNote(text: string, filename?: string): Promise<void> {
  const rawName = filename ?? `note_${Date.now()}.txt`
  // Reject path traversal: Unix separators caught by basename comparison;
  // also reject backslashes (Windows traversal on Linux) and URL-encoded dots/slashes
  const name = path.basename(rawName)
  if (name !== rawName || /[\\%]/.test(name)) {
    throw new Error(`[RAG] addNote: invalid filename "${rawName}"`)
  }
  const filepath = path.join(KB_DIR, name)
  fs.writeFileSync(filepath, text)

  // embed and add to live chunks
  const newChunks = chunkText(text, name)
  for (const chunk of newChunks) {
    chunk.embedding = await embed(chunk.text)
    chunks.push(chunk)
  }
  console.log(`[RAG] note saved → ${name} (${newChunks.length} chunks)`)
}

export { ARIA_DIR, KB_DIR, HISTORY_FILE }