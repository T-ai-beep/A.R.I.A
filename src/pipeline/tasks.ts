import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { writeAtomic } from '../world/atomicWrite.js'

const ARIA_DIR = path.join(os.homedir(), '.aria')
const TASKS_FILE = path.join(ARIA_DIR, 'tasks.jsonl')

export type TaskStatus = 'open' | 'done' | 'dismissed'
export type TaskPriority = 'high' | 'medium' | 'low'

export interface Task {
  id: string
  created: number
  updated: number
  status: TaskStatus
  priority: TaskPriority
  description: string          // e.g. "email John about the deal"
  person: string | null        // extracted person name
  context: string | null       // raw transcript that created this task
  dueHint: string | null       // e.g. "tomorrow", "end of week"
  resurfaceAt: number | null   // epoch ms — when to remind
  resurfaced: number           // how many times already resurfaced
}

function ensureDir() {
  if (!fs.existsSync(ARIA_DIR)) fs.mkdirSync(ARIA_DIR, { recursive: true })
}

function loadAll(): Task[] {
  ensureDir()
  if (!fs.existsSync(TASKS_FILE)) return []
  try {
    return fs.readFileSync(TASKS_FILE, 'utf-8')
      .trim().split('\n').filter(Boolean)
      .map(l => JSON.parse(l) as Task)
  } catch { return [] }
}

function saveAll(tasks: Task[]) {
  ensureDir()
  writeAtomic(TASKS_FILE, tasks.map(t => JSON.stringify(t)).join('\n') + '\n')
}

function genId(): string {
  return `task_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`
}

// ── NLP helpers ────────────────────────────────────────────────────────────

const TASK_PATTERNS = [
  /(?:email|text|call|ping|message|reach out to|contact|follow up with|send .+ to)\s+([A-Z][a-z]+)/i,
  /(?:send|write|draft|prepare)\s+(?:an?\s+)?(?:email|message|proposal|contract|report)\s+(?:to|for)\s+([A-Z][a-z]+)/i,
  /(?:remind me to|i need to|i should|make sure to|don't forget to)\s+(.{5,60}?)(?:\.|$)/i,
  /(?:set up|schedule|book)\s+(?:a\s+)?(?:meeting|call|demo|lunch)\s+(?:with\s+)?([A-Z][a-z]+)?/i,
]

const DUE_PATTERNS: Array<[RegExp, number]> = [
  [/\btoday\b/i, 0],
  [/\btomorrow\b/i, 1],
  [/\bend of (?:the )?day\b/i, 0],
  [/\bthis week\b/i, 3],
  [/\bend of week\b/i, 4],
  [/\bnext week\b/i, 7],
  [/\bmonday\b/i, 1],
  [/\bfriday\b/i, 4],
]

const PRIORITY_SIGNALS: Record<TaskPriority, RegExp[]> = {
  high: [/urgent|asap|critical|important|today|right now|immediately/i],
  medium: [/soon|this week|follow up|check in/i],
  low: [/maybe|eventually|some?time|low priority|whenever/i],
}

export function extractTaskFromTranscript(transcript: string): Omit<Task, 'id' | 'created' | 'updated' | 'status' | 'resurfaced'> | null {
  const t = transcript.trim()

  let description: string | null = null
  let person: string | null = null

  for (const pat of TASK_PATTERNS) {
    const m = t.match(pat)
    if (m) {
      description = t.length < 80 ? t : m[0]
      person = m[1] ?? null
      break
    }
  }

  if (!description) return null

  // due hint
  let dueHint: string | null = null
  let resurfaceAt: number | null = null
  for (const [pat, days] of DUE_PATTERNS) {
    if (pat.test(t)) {
      dueHint = t.match(pat)![0].toLowerCase()
      const d = new Date()
      d.setDate(d.getDate() + days)
      d.setHours(9, 0, 0, 0)
      resurfaceAt = d.getTime()
      break
    }
  }
  if (!resurfaceAt) {
    // default: resurface in 24h
    resurfaceAt = Date.now() + 24 * 3600 * 1000
  }

  // priority
  let priority: TaskPriority = 'medium'
  for (const [p, patterns] of Object.entries(PRIORITY_SIGNALS) as [TaskPriority, RegExp[]][]) {
    if (patterns.some(pat => pat.test(t))) { priority = p; break }
  }

  return {
    description: description.replace(/^(remind me to|i need to|i should|make sure to|don't forget to)\s+/i, '').trim(),
    person: person ?? null,
    context: transcript,
    dueHint,
    resurfaceAt,
    priority,
  }
}

// ── CRUD ───────────────────────────────────────────────────────────────────

export function addTask(data: Omit<Task, 'id' | 'created' | 'updated' | 'status' | 'resurfaced'>): Task {
  const task: Task = {
    id: genId(),
    created: Date.now(),
    updated: Date.now(),
    status: 'open',
    resurfaced: 0,
    ...data,
  }
  const tasks = loadAll()
  tasks.push(task)
  saveAll(tasks)
  console.log(`[TASK] created — "${task.description}" priority=${task.priority} due=${task.dueHint ?? 'auto'}`)
  return task
}

export function getOpenTasks(): Task[] {
  return loadAll().filter(t => t.status === 'open')
}

export function markDone(id: string): void {
  const tasks = loadAll()
  const t = tasks.find(t => t.id === id)
  if (t) { t.status = 'done'; t.updated = Date.now() }
  saveAll(tasks)
}

export function dismissTask(id: string): void {
  const tasks = loadAll()
  const t = tasks.find(t => t.id === id)
  if (t) { t.status = 'dismissed'; t.updated = Date.now() }
  saveAll(tasks)
}

// ── Resurface logic ────────────────────────────────────────────────────────

const MAX_RESURFACES = 3
const RESURFACE_INTERVAL_MS = 6 * 3600 * 1000 // 6h between resurfaces

export function getDueResurfaces(): Task[] {
  const now = Date.now()
  return loadAll().filter(t =>
    t.status === 'open' &&
    t.resurfaceAt !== null &&
    t.resurfaceAt <= now &&
    t.resurfaced < MAX_RESURFACES
  )
}

export function markResurfaced(id: string): void {
  const tasks = loadAll()
  const t = tasks.find(t => t.id === id)
  if (t) {
    t.resurfaced += 1
    t.resurfaceAt = Date.now() + RESURFACE_INTERVAL_MS
    t.updated = Date.now()
  }
  saveAll(tasks)
}

// ── Summary for ARIA context ───────────────────────────────────────────────

export function getTaskContext(): string {
  const open = getOpenTasks().slice(-5) // last 5
  if (!open.length) return ''
  return `Open tasks:\n${open.map(t =>
    `- [${t.priority}] ${t.description}${t.person ? ` (re: ${t.person})` : ''}${t.dueHint ? ` — ${t.dueHint}` : ''}`
  ).join('\n')}`
}