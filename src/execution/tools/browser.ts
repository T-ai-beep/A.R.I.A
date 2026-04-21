import { Tool } from '../../agents/types.js'

// ── browser.search ──────────────────────────────────────────────────────────

interface SearchInput {
  query: string
}

export interface SearchResult {
  query: string
  results: Array<{ title: string; snippet: string; url?: string }>
  source: 'duckduckgo'
}

export class BrowserSearchTool implements Tool {
  readonly name = 'browser.search'

  async execute(input: unknown): Promise<SearchResult> {
    const { query } = input as SearchInput
    if (!query?.trim()) throw new Error('browser.search: query is required')

    const url =
      `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}` +
      `&format=json&no_html=1&skip_disambig=1`

    const res = await fetch(url, { signal: AbortSignal.timeout(6_000) })
    if (!res.ok) throw new Error(`browser.search: HTTP ${res.status}`)

    const data = await res.json() as {
      AbstractText?: string
      Answer?: string
      AbstractURL?: string
      RelatedTopics?: Array<{ Text?: string; FirstURL?: string; Name?: string }>
      Results?: Array<{ Text?: string; FirstURL?: string }>
    }

    const results: SearchResult['results'] = []

    if (data.Answer) {
      results.push({ title: 'Direct Answer', snippet: data.Answer })
    }
    if (data.AbstractText) {
      results.push({
        title: 'Summary',
        snippet: data.AbstractText.slice(0, 500),
        url: data.AbstractURL,
      })
    }
    for (const t of (data.RelatedTopics ?? []).slice(0, 5)) {
      if (t.Text) results.push({ title: t.Name ?? 'Related', snippet: t.Text, url: t.FirstURL })
    }
    for (const r of (data.Results ?? []).slice(0, 3)) {
      if (r.Text) results.push({ title: 'Result', snippet: r.Text, url: r.FirstURL })
    }

    console.log(`[TOOL:browser.search] "${query}" → ${results.length} results`)
    return { query, results, source: 'duckduckgo' }
  }
}

// ── browser.scrape ──────────────────────────────────────────────────────────

interface ScrapeInput {
  url?: string
  content?: string
}

export interface ScrapeResult {
  url?: string
  text: string
  wordCount: number
}

const BLOCKED_HOSTS = /^(localhost|127\.|10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|::1|0\.0\.0\.0)/

export class BrowserScrapeTool implements Tool {
  readonly name = 'browser.scrape'

  async execute(input: unknown): Promise<ScrapeResult> {
    const { url, content } = input as ScrapeInput

    if (!url) {
      const text = String(content ?? '').slice(0, 5000)
      return { text, wordCount: text.split(/\s+/).filter(Boolean).length }
    }

    let parsed: URL
    try { parsed = new URL(url) } catch { throw new Error(`browser.scrape: invalid URL`) }
    if (!/^https?:$/.test(parsed.protocol)) throw new Error('browser.scrape: only http/https')
    if (BLOCKED_HOSTS.test(parsed.hostname)) throw new Error('browser.scrape: internal addresses not allowed')

    const res = await fetch(url, {
      signal: AbortSignal.timeout(10_000),
      headers: { 'User-Agent': 'Mozilla/5.0 AXON-Agent/1.0 (research)' },
    })
    if (!res.ok) throw new Error(`browser.scrape: HTTP ${res.status}`)

    const html = await res.text()
    const text = stripHTML(html).slice(0, 5000)
    console.log(`[TOOL:browser.scrape] ${url} → ${text.length} chars`)
    return { url, text, wordCount: text.split(/\s+/).filter(Boolean).length }
  }
}

function stripHTML(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s{2,}/g, ' ')
    .trim()
}
