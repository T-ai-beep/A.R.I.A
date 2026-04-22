/**
 * brainMap.ts — Knowledge graph over all memory
 *
 * Builds a traversable graph connecting:
 *   People ←→ Conversations ←→ Intents ←→ Outcomes ←→ Offers
 *
 * Node types:
 *   person      — someone you've talked to
 *   event       — an episodic memory
 *   intent      — PRICE_OBJECTION, AGREEMENT, etc.
 *   outcome     — won, lost, pending, stalled
 *   offer       — a dollar amount
 *   topic       — recurring subject (ServiceTitan, TTC, etc.)
 *   date        — a day node (groups events)
 *
 * Edge types:
 *   mentioned_in   — person ← event
 *   has_intent     — event → intent
 *   resulted_in    — event → outcome
 *   discussed      — event ↔ offer
 *   related_to     — event ↔ event (from episodic links)
 *   appears_on     — event → date
 *   follows_up     — event → event (temporal sequence)
 *
 * Usage:
 *   const map = await buildBrainMap()
 *   const node = map.getNode('person:marcus')
 *   const connections = map.getConnections('person:marcus')
 *   const path = map.shortestPath('person:marcus', 'outcome:won')
 *   const cluster = map.getCluster('intent:PRICE_OBJECTION')
 */

import { recallEpisodes, EpisodicEvent, getEpisode } from '../pipeline/epsodic.js'
import { getAllPeople }   from '../pipeline/people.js'
import { loadRecaps }     from './dailyRecap.js'
import * as fs            from 'fs'
import * as path          from 'path'
import * as os            from 'os'

const ARIA_DIR        = path.join(os.homedir(), '.aria')
const BRAIN_MAP_FILE  = path.join(ARIA_DIR, 'brain_map.json')
const REBUILD_INTERVAL_MS = 10 * 60 * 1000 // rebuild every 10 min max

// ── Types ──────────────────────────────────────────────────────────────────

export type NodeType = 'person' | 'event' | 'intent' | 'outcome' | 'offer' | 'topic' | 'date'
export type EdgeType =
  | 'mentioned_in'
  | 'has_intent'
  | 'resulted_in'
  | 'discussed'
  | 'related_to'
  | 'appears_on'
  | 'follows_up'
  | 'involves'

export interface GraphNode {
  id:         string       // type:key e.g. "person:marcus", "intent:PRICE_OBJECTION"
  type:       NodeType
  label:      string       // display name
  weight:     number       // importance / frequency
  ts:         number       // most recent activity
  metadata:   Record<string, any>
}

export interface GraphEdge {
  source:   string
  target:   string
  type:     EdgeType
  weight:   number
  ts:       number
}

export interface BrainMapData {
  nodes:       GraphNode[]
  edges:       GraphEdge[]
  builtAt:     number
  nodeCount:   number
  edgeCount:   number
  stats: {
    totalPeople:   number
    totalEvents:   number
    totalIntents:  number
    strongestLink: { source: string; target: string; weight: number } | null
  }
}

// ── BrainMap class ─────────────────────────────────────────────────────────

export class BrainMap {
  private nodes: Map<string, GraphNode>  = new Map()
  private edges: Map<string, GraphEdge>  = new Map()
  private adjacency: Map<string, Set<string>> = new Map()

  constructor(data?: BrainMapData) {
    if (data) {
      for (const n of data.nodes) this.nodes.set(n.id, n)
      for (const e of data.edges) {
        const key = `${e.source}:${e.target}:${e.type}`
        this.edges.set(key, e)
        this.addAdjacency(e.source, e.target)
      }
    }
  }

  // ── Mutation ───────────────────────────────────────────────────────────

  addNode(node: GraphNode): void {
    const existing = this.nodes.get(node.id)
    if (existing) {
      // Merge: bump weight, update ts
      existing.weight = Math.min(1.0, existing.weight + node.weight * 0.1)
      existing.ts     = Math.max(existing.ts, node.ts)
      Object.assign(existing.metadata, node.metadata)
    } else {
      this.nodes.set(node.id, { ...node })
    }
  }

  addEdge(edge: GraphEdge): void {
    const key = `${edge.source}:${edge.target}:${edge.type}`
    const existing = this.edges.get(key)
    if (existing) {
      existing.weight = Math.min(1.0, existing.weight + 0.1)
      existing.ts     = Math.max(existing.ts, edge.ts)
    } else {
      this.edges.set(key, { ...edge })
      this.addAdjacency(edge.source, edge.target)
    }
  }

  private addAdjacency(a: string, b: string): void {
    if (!this.adjacency.has(a)) this.adjacency.set(a, new Set())
    if (!this.adjacency.has(b)) this.adjacency.set(b, new Set())
    this.adjacency.get(a)!.add(b)
    this.adjacency.get(b)!.add(a)
  }

  // ── Query ──────────────────────────────────────────────────────────────

  getNode(id: string): GraphNode | null {
    return this.nodes.get(id) ?? null
  }

  getConnections(nodeId: string): { node: GraphNode; edge: GraphEdge }[] {
    const neighbors = this.adjacency.get(nodeId) ?? new Set()
    const results: { node: GraphNode; edge: GraphEdge }[] = []

    for (const neighbor of neighbors) {
      const node = this.nodes.get(neighbor)
      if (!node) continue

      // Find the strongest edge between these two
      let bestEdge: GraphEdge | null = null
      for (const edge of this.edges.values()) {
        if ((edge.source === nodeId && edge.target === neighbor) ||
            (edge.source === neighbor && edge.target === nodeId)) {
          if (!bestEdge || edge.weight > bestEdge.weight) bestEdge = edge
        }
      }
      if (bestEdge) results.push({ node, edge: bestEdge })
    }

    return results.sort((a, b) => b.edge.weight - a.edge.weight)
  }

  getNodesByType(type: NodeType): GraphNode[] {
    return Array.from(this.nodes.values())
      .filter(n => n.type === type)
      .sort((a, b) => b.weight - a.weight)
  }

  // ── BFS shortest path ──────────────────────────────────────────────────

  shortestPath(from: string, to: string): GraphNode[] {
    if (!this.nodes.has(from) || !this.nodes.has(to)) return []
    if (from === to) return [this.nodes.get(from)!]

    const visited  = new Set<string>([from])
    const queue:   Array<{ id: string; path: string[] }> = [{ id: from, path: [from] }]

    while (queue.length) {
      const item = queue.shift()
      if (!item) break
      const { id, path } = item
      const neighbors = this.adjacency.get(id) ?? new Set()

      for (const neighbor of neighbors) {
        if (neighbor === to) {
          const fullPath = [...path, neighbor]
          return fullPath.map(n => this.nodes.get(n)!).filter(Boolean)
        }
        if (!visited.has(neighbor)) {
          visited.add(neighbor)
          queue.push({ id: neighbor, path: [...path, neighbor] })
        }
      }
    }

    return [] // no path found
  }

  // ── Cluster: all nodes within N hops of a given node ──────────────────

  getCluster(nodeId: string, maxHops = 2): GraphNode[] {
    const visited = new Set<string>([nodeId])
    const queue: Array<{ id: string; hops: number }> = [{ id: nodeId, hops: 0 }]
    const result: GraphNode[] = []

    while (queue.length) {
      const item = queue.shift()
      if (!item) break
      const { id, hops } = item
      const node = this.nodes.get(id)
      if (node) result.push(node)
      if (hops >= maxHops) continue

      const neighbors = this.adjacency.get(id) ?? new Set()
      for (const neighbor of neighbors) {
        if (!visited.has(neighbor)) {
          visited.add(neighbor)
          queue.push({ id: neighbor, hops: hops + 1 })
        }
      }
    }

    return result.sort((a, b) => b.weight - a.weight)
  }

  // ── Timeline: events for a person ordered by time ─────────────────────

  getPersonTimeline(personName: string): GraphNode[] {
    const personId = `person:${personName.toLowerCase()}`
    const cluster  = this.getCluster(personId, 1)
    return cluster
      .filter(n => n.type === 'event')
      .sort((a, b) => a.ts - b.ts)
  }

  // ── Serialization ──────────────────────────────────────────────────────

  toData(): BrainMapData {
    const nodesArr = Array.from(this.nodes.values())
    const edgesArr = Array.from(this.edges.values())

    let strongestLink: BrainMapData['stats']['strongestLink'] = null
    let maxWeight = 0
    for (const edge of edgesArr) {
      if (edge.weight > maxWeight) {
        maxWeight     = edge.weight
        strongestLink = { source: edge.source, target: edge.target, weight: edge.weight }
      }
    }

    return {
      nodes:     nodesArr,
      edges:     edgesArr,
      builtAt:   Date.now(),
      nodeCount: nodesArr.length,
      edgeCount: edgesArr.length,
      stats: {
        totalPeople:  nodesArr.filter(n => n.type === 'person').length,
        totalEvents:  nodesArr.filter(n => n.type === 'event').length,
        totalIntents: nodesArr.filter(n => n.type === 'intent').length,
        strongestLink,
      },
    }
  }

  summary(): string {
    const d = this.toData()
    return `Brain Map: ${d.nodeCount} nodes (${d.stats.totalPeople} people, ${d.stats.totalEvents} events, ${d.stats.totalIntents} intents), ${d.edgeCount} edges`
  }
}

// ── Builder ────────────────────────────────────────────────────────────────

export async function buildBrainMap(): Promise<BrainMap> {
  const map = new BrainMap()

  // 1. Add all people as nodes
  const people = getAllPeople()
  for (const person of people) {
    map.addNode({
      id:       `person:${person.name}`,
      type:     'person',
      label:    person.displayName,
      weight:   Math.min(1.0, 0.2 + person.mentions * 0.05),
      ts:       person.lastSeen,
      metadata: {
        tags:       person.tags,
        lastOffer:  person.lastOffer,
        lastIntent: person.lastIntent,
        mentions:   person.mentions,
      },
    })

    // Person → intent edges
    if (person.lastIntent) {
      map.addNode({
        id:       `intent:${person.lastIntent}`,
        type:     'intent',
        label:    person.lastIntent,
        weight:   0.5,
        ts:       person.lastSeen,
        metadata: {},
      })
      map.addEdge({
        source: `person:${person.name}`,
        target: `intent:${person.lastIntent}`,
        type:   'has_intent',
        weight: 0.6,
        ts:     person.lastSeen,
      })
    }

    // Person → offer edges
    if (person.lastOffer) {
      const offerBucket = `offer:${Math.round(person.lastOffer / 1000) * 1000}`
      map.addNode({
        id:       offerBucket,
        type:     'offer',
        label:    `$${(Math.round(person.lastOffer / 1000) * 1000).toLocaleString()}`,
        weight:   0.4,
        ts:       person.lastSeen,
        metadata: { value: person.lastOffer },
      })
      map.addEdge({
        source: `person:${person.name}`,
        target: offerBucket,
        type:   'discussed',
        weight: 0.7,
        ts:     person.lastSeen,
      })
    }

    // Person → tag (topic) edges
    for (const tag of person.tags.slice(0, 3)) {
      map.addNode({
        id:       `topic:${tag}`,
        type:     'topic',
        label:    tag,
        weight:   0.3,
        ts:       person.lastSeen,
        metadata: {},
      })
      map.addEdge({
        source: `person:${person.name}`,
        target: `topic:${tag}`,
        type:   'involves',
        weight: 0.5,
        ts:     person.lastSeen,
      })
    }
  }

  // 2. Add episodic events as nodes
  const episodes = await recallEpisodes('', 200, { minImportance: 0.2 })
  for (const ep of episodes) {
    const eventId = `event:${ep.id}`

    map.addNode({
      id:       eventId,
      type:     'event',
      label:    ep.object.slice(0, 60),
      weight:   ep.importance,
      ts:       ep.time,
      metadata: {
        type:    ep.type,
        outcome: ep.outcome,
        context: ep.context.slice(0, 100),
        tags:    ep.tags,
      },
    })

    // Date node
    const date    = new Date(ep.time).toISOString().slice(0, 10)
    const dateId  = `date:${date}`
    map.addNode({
      id:       dateId,
      type:     'date',
      label:    date,
      weight:   0.3,
      ts:       ep.time,
      metadata: {},
    })
    map.addEdge({
      source: eventId,
      target: dateId,
      type:   'appears_on',
      weight: 0.4,
      ts:     ep.time,
    })

    // Event → person edges
    if (ep.person) {
      const personId = `person:${ep.person.toLowerCase()}`
      map.addEdge({
        source: personId,
        target: eventId,
        type:   'mentioned_in',
        weight: 0.8,
        ts:     ep.time,
      })
    }

    // Event → intent/tag edges
    for (const tag of ep.tags) {
      const tagId = tag.startsWith('PRICE') || tag.startsWith('AGREE') || tag.startsWith('STALL')
        ? `intent:${tag}`
        : `topic:${tag}`

      map.addNode({
        id:       tagId,
        type:     tag.startsWith('PRICE') || tag.startsWith('AGREE') || tag.startsWith('STALL') ? 'intent' : 'topic',
        label:    tag,
        weight:   0.4,
        ts:       ep.time,
        metadata: {},
      })
      map.addEdge({
        source: eventId,
        target: tagId,
        type:   'has_intent',
        weight: 0.5,
        ts:     ep.time,
      })
    }

    // Event → outcome edges
    if (ep.outcome && ep.outcome !== 'pending') {
      const outcomeId = `outcome:${ep.outcome}`
      map.addNode({
        id:       outcomeId,
        type:     'outcome',
        label:    ep.outcome,
        weight:   0.5,
        ts:       ep.time,
        metadata: {},
      })
      map.addEdge({
        source: eventId,
        target: outcomeId,
        type:   'resulted_in',
        weight: 0.9,
        ts:     ep.time,
      })
    }

    // Event ↔ linked events
    for (const linkedId of (ep.links ?? []).slice(0, 3)) {
      map.addEdge({
        source: eventId,
        target: `event:${linkedId}`,
        type:   'related_to',
        weight: 0.4,
        ts:     ep.time,
      })
    }
  }

  console.log(`[BRAIN MAP] ${map.summary()}`)
  return map
}

// ── Persistence ────────────────────────────────────────────────────────────

let _cachedMap:  BrainMap | null = null
let _cacheBuilt: number         = 0

export async function getBrainMap(forceRebuild = false): Promise<BrainMap> {
  const now = Date.now()

  if (!forceRebuild && _cachedMap && (now - _cacheBuilt) < REBUILD_INTERVAL_MS) {
    return _cachedMap
  }

  // Try loading from disk first
  if (!forceRebuild && fs.existsSync(BRAIN_MAP_FILE)) {
    try {
      const data = JSON.parse(fs.readFileSync(BRAIN_MAP_FILE, 'utf-8')) as BrainMapData
      if (now - data.builtAt < REBUILD_INTERVAL_MS) {
        _cachedMap  = new BrainMap(data)
        _cacheBuilt = data.builtAt
        return _cachedMap
      }
    } catch {}
  }

  // Rebuild
  const map = await buildBrainMap()
  _cachedMap  = map
  _cacheBuilt = now

  // Persist
  try {
    if (!fs.existsSync(ARIA_DIR)) fs.mkdirSync(ARIA_DIR, { recursive: true })
    fs.writeFileSync(BRAIN_MAP_FILE, JSON.stringify(map.toData(), null, 2))
  } catch {}

  return map
}

// ── CLI / query interface ─────────────────────────────────────────────────

export async function queryBrainMap(query: string): Promise<string> {
  const map = await getBrainMap()

  // Person query: "show me Marcus" / "what about Marcus"
  const personMatch = query.match(/\b([A-Z][a-z]{2,14})\b/)
  if (personMatch) {
    const name  = personMatch[1].toLowerCase()
    const node  = map.getNode(`person:${name}`)
    if (node) {
      const connections = map.getConnections(`person:${name}`)
      const timeline    = map.getPersonTimeline(personMatch[1])
      const recentEvents = timeline.slice(-3).map(e => e.label).join('; ')

      return `${node.label}: ${node.metadata.mentions ?? 0} mentions, ` +
             `tags: [${(node.metadata.tags ?? []).join(', ')}], ` +
             `last intent: ${node.metadata.lastIntent ?? 'none'}, ` +
             `${node.metadata.lastOffer ? `last offer: $${node.metadata.lastOffer.toLocaleString()}, ` : ''}` +
             `${connections.length} connections. ` +
             (recentEvents ? `Recent: ${recentEvents}` : '')
    }
  }

  // Intent query: "show me all price objections"
  const intentMap: Record<string, string> = {
    price: 'PRICE_OBJECTION',
    stall: 'STALLING',
    agree: 'AGREEMENT',
    competitor: 'COMPETITOR',
    authority: 'AUTHORITY',
  }
  for (const [keyword, intent] of Object.entries(intentMap)) {
    if (query.toLowerCase().includes(keyword)) {
      const cluster = map.getCluster(`intent:${intent}`, 1)
      const people  = cluster.filter(n => n.type === 'person').map(n => n.label)
      return `${intent}: connected to ${people.length} people (${people.slice(0, 3).join(', ')})`
    }
  }

  // Default: summary
  return map.summary()
}

// ── Entrypoint ────────────────────────────────────────────────────────────

async function main() {
  const query = process.argv.slice(2).join(' ')
  if (query) {
    const result = await queryBrainMap(query)
    console.log(result)
  } else {
    const map = await getBrainMap(true)
    console.log(map.summary())

    // Print top people
    const people = map.getNodesByType('person').slice(0, 5)
    if (people.length) {
      console.log('\nTop people:')
      people.forEach(p => {
        const connections = map.getConnections(p.id)
        console.log(`  ${p.label}: weight=${p.weight.toFixed(2)}, connections=${connections.length}`)
      })
    }

    // Print top intents
    const intents = map.getNodesByType('intent').slice(0, 5)
    if (intents.length) {
      console.log('\nTop intents:')
      intents.forEach(i => console.log(`  ${i.label}: weight=${i.weight.toFixed(2)}`))
    }
  }
}

if (process.argv[1]?.endsWith('brainMap.ts') || process.argv[1]?.endsWith('brainMap.js')) {
  main().catch(e => { console.error(e); process.exit(1) })
}