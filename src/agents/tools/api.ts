import type { Tool, ToolResult } from '../types.js'

type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

const INTERNAL_IP =
  /localhost|127\.|0\.0\.0\.0|::1|10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\./i

export const apiCall: Tool = {
  name: 'api.call',
  description: 'Make a generic HTTP API call',

  async execute(input: Record<string, unknown>): Promise<ToolResult> {
    const url    = typeof input['url']    === 'string' ? input['url']    : ''
    const method = typeof input['method'] === 'string'
      ? (input['method'].toUpperCase() as HttpMethod)
      : 'GET'
    const headers = (typeof input['headers'] === 'object' && input['headers'] !== null)
      ? (input['headers'] as Record<string, string>)
      : {}
    const body = typeof input['body'] === 'string' ? input['body'] : undefined

    if (!url) return { success: false, error: 'url is required' }
    if (INTERNAL_IP.test(url)) return { success: false, error: 'Internal URLs are not permitted' }

    try {
      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json', ...headers },
        body:    method !== 'GET' ? body : undefined,
        signal:  AbortSignal.timeout(10_000),
      })

      const text = await res.text()
      let data: unknown = text
      try { data = JSON.parse(text) } catch { /* keep as text */ }

      return {
        success: res.ok,
        data,
        error: res.ok ? undefined : `HTTP ${res.status}: ${res.statusText}`,
      }
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) }
    }
  },
}
