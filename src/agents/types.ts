// ── Input types ───────────────────────────────────────────────────────────────

export type InputSource =
  | 'transcript'
  | 'command'
  | 'system_trigger'
  | 'agent_callback'

export type IntentClass =
  | 'conversation'
  | 'task'
  | 'execution'
  | 'research'
  | 'unknown'

export interface Input {
  id:       string
  source:   InputSource
  text:     string
  ts:       number
  speaker?: 'self' | 'other' | 'unknown'
  metadata?: Record<string, unknown>
}

// ── Agent result ──────────────────────────────────────────────────────────────

export interface AgentResult {
  agentId:        string
  inputId:        string
  success:        boolean
  output?:        string        // spoken/displayed output
  data?:          unknown       // structured result
  spawnedAgents?: string[]      // IDs of sub-agents spawned
  durationMs:     number
  error?:         string
}

// ── Agent interface ───────────────────────────────────────────────────────────

export interface Agent {
  id:          string
  canHandle(input: Input): boolean
  execute(input: Input): Promise<AgentResult>
}

// ── Sub-agent system ──────────────────────────────────────────────────────────

export type SubAgentState =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'

export interface SubAgent {
  id:          string
  goal:        string
  plan:        string[]
  state:       SubAgentState
  currentStep: number
  result?:     unknown
  logs:        string[]
  createdAt:   number
  updatedAt:   number
}

// ── Tool system ───────────────────────────────────────────────────────────────

export interface ToolResult {
  success: boolean
  data?:   unknown
  error?:  string
}

export interface Tool {
  name:        string
  description: string
  execute(input: Record<string, unknown>): Promise<ToolResult>
}

// ── Intent classification scoring ─────────────────────────────────────────────

export interface IntentScore {
  intent:  IntentClass
  score:   number
  matched: string[]
}
