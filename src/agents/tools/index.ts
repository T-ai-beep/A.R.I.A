import type { Tool } from '../types.js'
import { browserSearch, browserScrape } from './browser.js'
import { emailSend }                     from './email.js'
import { calendarSchedule }              from './calendar.js'
import { fileWrite, fileRead }           from './file.js'
import { apiCall }                       from './api.js'

// ── Tool registry ─────────────────────────────────────────────────────────────

const registry = new Map<string, Tool>()

function register(tool: Tool): void {
  registry.set(tool.name, tool)
}

register(browserSearch)
register(browserScrape)
register(emailSend)
register(calendarSchedule)
register(fileWrite)
register(fileRead)
register(apiCall)

export function getTool(name: string): Tool | null {
  return registry.get(name) ?? null
}

export function listTools(): Tool[] {
  return Array.from(registry.values())
}

// Allows tests to inject deterministic tools without modifying production code.
export function registerTool(tool: Tool): void {
  registry.set(tool.name, tool)
}

export function unregisterTool(name: string): void {
  registry.delete(name)
}

export {
  browserSearch, browserScrape,
  emailSend,
  calendarSchedule,
  fileWrite, fileRead,
  apiCall,
}
