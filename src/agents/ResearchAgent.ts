/**
 * ResearchAgent — answers research queries using RAG + episodic recall.
 *
 * Integrates: rag.ts (KB + web search + history) · epsodic.ts (semantic recall)
 *
 * Synthesizes all sources into a coherent answer via LLM.
 */

import { Agent, AgentResult, Input } from './types.js'
import { ragQuery } from '../pipeline/rag.js'
import { recallEpisodes, EpisodicEvent } from '../pipeline/epsodic.js'
import { CONFIG } from '../config.js'

export class ResearchAgent implements Agent {
  readonly id = 'research'

  canHandle(input: Input): boolean {
    return input.type === 'research_query'
  }

  async execute(input: Input): Promise<AgentResult> {
    const t0 = Date.now()
    try {
      const [ragResult, episodes] = await Promise.all([
        ragQuery(input.raw, { useWeb: true, useHistory: true, useKB: true }),
        recallEpisodes(input.raw, 3, { minImportance: 0.3 }).catch(() => [] as EpisodicEvent[]),
      ])

      const episodicContext = episodes.length > 0
        ? `\nFrom memory:\n${episodes.map(e => `[${e.type}] ${e.object}`).join('\n')}`
        : ''

      const rawContext = (ragResult + episodicContext).trim()

      if (!rawContext) {
        return {
          agentId: this.id,
          success: true,
          output: 'No relevant information found.',
          data: { ragResult: '', episodes: [] },
          durationMs: Date.now() - t0,
        }
      }

      const synthesis = await this.synthesize(input.raw, rawContext)

      return {
        agentId: this.id,
        success: true,
        output: synthesis,
        data: { ragResult, episodes },
        durationMs: Date.now() - t0,
      }
    } catch (err) {
      return {
        agentId: this.id,
        success: false,
        output: null,
        error: String(err),
        durationMs: Date.now() - t0,
      }
    }
  }

  private async synthesize(query: string, context: string): Promise<string> {
    try {
      const res = await fetch(CONFIG.OLLAMA_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: CONFIG.OLLAMA_MODEL,
          messages: [
            {
              role: 'system',
              content:
                'You are a research assistant. Synthesize the provided context into a concise, ' +
                'factual answer of 2-4 sentences. Answer the query directly. ' +
                'If context is insufficient, say what was found and what is missing.',
            },
            {
              role: 'user',
              content: `Query: ${query}\n\nContext:\n${context.slice(0, 3000)}`,
            },
          ],
          stream: false,
        }),
        signal: AbortSignal.timeout(CONFIG.OLLAMA_RECALL_TIMEOUT_MS),
      })
      const data = await res.json() as { message?: { content?: string } }
      return data.message?.content?.trim() || context.slice(0, 500)
    } catch {
      // LLM unavailable: return raw context truncated
      return context.slice(0, 500)
    }
  }
}
