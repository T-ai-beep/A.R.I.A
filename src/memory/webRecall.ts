/**
 * webRecall.ts — Combined episodic memory + live web search
 *
 * Answers questions like:
 *   "What did I say about ServiceTitan, and what's happening with them now?"
 *   "I talked about raising capital last week — what's the current market look like?"
 *   "Nathan mentioned the auth bug — what's the latest on that issue type?"
 *
 * Strategy:
 *   1. Run episodic recall for the personal memory half
 *   2. Extract the "searchable topic" from the query + memory context
 *   3. Run web search for the current state of that topic
 *   4. Synthesize both into a unified answer
 */

import { CONFIG }   from '../config.js'
import { recall }   from './recall.js'
import { webSearch } from '../pipeline/rag.js'

// ── Types ──────────────────────────────────────────────────────────────────

export interface WebRecallResult {
  query:        string
  personalMemory: {
    summary:  string
    snippets: string[]
    empty:    boolean
  }
  webContext: {
    summary:  string
    empty:    boolean
  }
  combined:   string    // synthesized answer
}

// ── Topic extraction from query + memories ─────────────────────────────────

function extractSearchTopic(query: string, memorySummary: string): string {
  // Strip personal memory framing, keep the topic
  const stripped = query
    .replace(/\b(i|we|my|me|did|said|talked|mentioned|told|heard|think|know)\b/gi, '')
    .replace(/\b(last week|yesterday|today|last month|this week)\b/gi, '')
    .replace(/\b(about|with|from|the|a|an|and|or|but)\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim()

  // Pull key nouns from memory summary (things like company names, topics)
  const companyMatch = memorySummary.match(/\b(ServiceTitan|Jobber|Housecall|TTC|Boring Solutions|[A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\b/g)
  if (companyMatch?.length) {
    return `${companyMatch[0]} ${stripped}`.slice(0, 80)
  }

  return stripped.slice(0, 80)
}

// ── LLM synthesis ──────────────────────────────────────────────────────────

async function synthesize(
  query:    string,
  personal: string,
  web:      string | null
): Promise<string> {
  if (!personal && !web) {
    return "I don't have relevant memories or current information on that topic."
  }

  if (!web) {
    return `From your memory: ${personal}`
  }

  if (!personal) {
    return `Current info: ${web}`
  }

  try {
    const res = await fetch(CONFIG.OLLAMA_URL, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model:  CONFIG.OLLAMA_MODEL,
        stream: false,
        messages: [
          {
            role:    'system',
            content: 'Combine personal memory and current web context into one concise answer. 3 sentences max. Be specific.',
          },
          {
            role:    'user',
            content: `Question: ${query}\n\nYour memory: ${personal}\n\nCurrent context: ${web}\n\nSynthesize a combined answer.`,
          },
        ],
      }),
      signal: AbortSignal.timeout(CONFIG.OLLAMA_RECALL_TIMEOUT_MS),
    })
    const data = await res.json() as { message: { content: string } }
    return data.message.content.trim()
  } catch {
    return `Memory: ${personal.slice(0, 150)}. Current: ${web.slice(0, 150)}.`
  }
}

// ── Main function ──────────────────────────────────────────────────────────

export async function webRecall(query: string): Promise<WebRecallResult> {
  console.log(`[WEB RECALL] "${query}"`)

  // Run both in parallel
  const [memoryResponse, _] = await Promise.all([
    recall(query, 5),
    Promise.resolve(null), // placeholder for parallel slot
  ])

  const memorySummary = memoryResponse.summary
  const memorySnippets = memoryResponse.results.slice(0, 3).map(r => r.snippet)

  // Build search topic from query + memory context
  const searchTopic = extractSearchTopic(query, memorySummary)
  console.log(`[WEB RECALL] searching web for: "${searchTopic}"`)

  const webResult = await webSearch(searchTopic)

  // Synthesize
  const combined = await synthesize(query, memorySummary, webResult)

  return {
    query,
    personalMemory: {
      summary:  memorySummary,
      snippets: memorySnippets,
      empty:    memoryResponse.empty,
    },
    webContext: {
      summary:  webResult ?? '',
      empty:    !webResult,
    },
    combined,
  }
}

// ── Integration with decision pipeline ────────────────────────────────────

export async function getWebRecallContext(transcript: string): Promise<string> {
  // Only trigger on explicit recall + web queries
  const isWebRecallQuery = /what('s| is) (happening|going on|the latest|new) (with|about|on)/i.test(transcript) ||
    (/\b(remember|recalled|mentioned|said)\b.*\b(and|but)\b.*\b(now|currently|today|latest)/i.test(transcript))

  if (!isWebRecallQuery) return ''

  try {
    const result = await webRecall(transcript)
    return result.combined
  } catch {
    return ''
  }
}