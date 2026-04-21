import type { Tool, ToolResult } from '../types.js'
import { webSearch } from '../../pipeline/rag.js'

export const browserSearch: Tool = {
  name: 'browser.search',
  description: 'Search the web for information using DuckDuckGo',

  async execute(input: Record<string, unknown>): Promise<ToolResult> {
    const query = typeof input['query'] === 'string' ? input['query'] : ''
    if (!query) return { success: false, error: 'query is required' }

    try {
      const result = await webSearch(query)
      return { success: true, data: result ?? 'No results found' }
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) }
    }
  },
}

export const browserScrape: Tool = {
  name: 'browser.scrape',
  description: 'Fetch and extract text content from a URL',

  async execute(input: Record<string, unknown>): Promise<ToolResult> {
    const url = typeof input['url'] === 'string' ? input['url'] : ''
    if (!url) return { success: false, error: 'url is required' }

    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; AXON/1.0)' },
        signal: AbortSignal.timeout(8_000),
      })

      if (!res.ok) return { success: false, error: `HTTP ${res.status}` }

      const html = await res.text()
      const text = html
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 2000)

      return { success: true, data: text }
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) }
    }
  },
}
