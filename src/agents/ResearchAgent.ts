import type { Agent, AgentResult, Input } from './types.js'
import { getRecallContext }  from '../memory/recall.js'
import { ragQuery }          from '../pipeline/rag.js'

const RESEARCH_PATTERNS =
  /\b(who|what happened|recall|remember|history|find out|did (i|we)|told me|mentioned|what was|show me)\b/i

function truncateToWords(text: string, maxWords: number): string {
  const words = text.trim().split(/\s+/)
  if (words.length <= maxWords) return text.trim()
  return words.slice(0, maxWords).join(' ') + '...'
}

export class ResearchAgent implements Agent {
  readonly id = 'research'

  canHandle(input: Input): boolean {
    return RESEARCH_PATTERNS.test(input.text)
  }

  async execute(input: Input): Promise<AgentResult> {
    const t0 = Date.now()

    const [recallCtx, ragCtx] = await Promise.all([
      getRecallContext(input.text).catch(() => ''),
      ragQuery(input.text, { useWeb: true, useHistory: true, useKB: true }).catch(() => ''),
    ])

    const combined = [recallCtx, ragCtx].filter(Boolean).join('\n\n').trim()
    const output   = combined ? truncateToWords(combined, 50) : 'Nothing found in memory.'

    return {
      agentId:    this.id,
      inputId:    input.id,
      success:    true,
      output,
      data:       { recallCtx, ragCtx },
      durationMs: Date.now() - t0,
    }
  }
}
