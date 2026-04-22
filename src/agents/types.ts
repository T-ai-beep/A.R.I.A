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

// ── Plan / Coordinator system ─────────────────────────────────────────────────

export interface PlanNode {
  id:                  string
  goalId:              string
  step:                string
  toolName:            string
  toolInput:           Record<string, unknown>
  state:               'pending' | 'running' | 'completed' | 'failed'
  idempotencyKey:      string
  leaseOwner?:         string
  leaseExpiry?:        number
  completedAt?:        number
  result?:             unknown
  error?:              string
  executionId?:        string    // unique per attempt — changes on each retry
  executionStartedAt?: number
  timeoutMs?:          number    // per-node override; default 30_000
  expectedOutcome?:    'truthy' | 'has_data' | 'file_exists'
}

// ── Execution log ─────────────────────────────────────────────────────────────

export type ExecutionLogEvent =
  | 'node_started'
  | 'node_completed'
  | 'node_failed'
  | 'node_skipped'
  | 'node_recovered'
  | 'lease_acquired'
  | 'lease_released'
  | 'lease_reclaimed'

export interface ExecutionLogEntry {
  ts:          number
  planId:      string
  nodeId:      string
  executionId: string
  event:       ExecutionLogEvent
  toolName?:   string
  success?:    boolean
  error?:      string
  durationMs?: number
  pid:         number
}

export interface Plan {
  id:        string
  goal:      string
  createdAt: number
  state:     'active' | 'completed' | 'failed'
  nodes:     PlanNode[]
}

export interface ExecutionContext {
  lastResult?: string
  lastUrl?:    string
  draft?:      string
}

export interface NodeResult {
  nodeId:   string
  success:  boolean
  data?:    unknown
  error?:   string
}

export interface CoordinatorResult {
  planId:      string
  success:     boolean
  results:     NodeResult[]
  lastResult?: unknown
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
