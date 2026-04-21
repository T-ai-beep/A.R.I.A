import { Tool } from '../../agents/types.js'

interface ApiCallInput {
  url: string
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  headers?: Record<string, string>
  body?: unknown
  timeout?: number
}

export interface ApiCallResult {
  url: string
  status: number
  ok: boolean
  data: unknown
  durationMs: number
}

const BLOCKED_HOSTS = /^(localhost|127\.|10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|::1|0\.0\.0\.0)/

export class ApiCallTool implements Tool {
  readonly name = 'api.call'

  async execute(input: unknown): Promise<ApiCallResult> {
    const {
      url,
      method = 'GET',
      headers = {},
      body,
      timeout = 10_000,
    } = input as ApiCallInput

    if (!url?.trim()) throw new Error('api.call: "url" is required')

    let parsed: URL
    try { parsed = new URL(url) } catch { throw new Error(`api.call: invalid URL "${url}"`) }
    if (!/^https?:$/.test(parsed.protocol)) throw new Error('api.call: only http/https allowed')
    if (BLOCKED_HOSTS.test(parsed.hostname))  throw new Error('api.call: internal addresses not allowed')

    const t0 = Date.now()

    const res = await fetch(url, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'AXON-Agent/1.0',
        ...headers,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeout),
    })

    const contentType = res.headers.get('content-type') ?? ''
    let data: unknown
    if (contentType.includes('application/json')) {
      data = await res.json()
    } else {
      data = await res.text()
    }

    const durationMs = Date.now() - t0
    console.log(`[TOOL:api.call] ${method} ${url} → ${res.status} (${durationMs}ms)`)
    return { url, status: res.status, ok: res.ok, data, durationMs }
  }
}
