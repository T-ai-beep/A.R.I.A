// ── LeaseManager — file-based atomic lease using mkdir CAS ───────────────────
//
// Uses fs.mkdirSync (without { recursive: true }) as an atomic compare-and-set.
// On POSIX: mkdir is atomic — exactly one caller gets EEXIST, all others fail.
// Lease metadata (owner pid, expiry) is written inside the lease directory.
// Expired leases are automatically reclaimed on next acquireLease() attempt.

import * as fs   from 'node:fs'
import * as path from 'node:path'
import * as os   from 'node:os'

const LEASES_DIR = process.env['AXON_LEASES_DIR'] ?? path.join(os.homedir(), '.aria', 'leases')

interface LeaseData {
  key:       string
  owner:     string   // process.pid as string
  pid:       number
  expiresAt: number
  acquiredAt: number
}

function leaseDir(key: string): string {
  // Sanitize key to a safe directory name
  const safe = key.replace(/[:/\\]/g, '_').replace(/[^a-zA-Z0-9_\-\.]/g, '_')
  return path.join(LEASES_DIR, safe)
}

function leaseFile(key: string): string {
  return path.join(leaseDir(key), 'lease.json')
}

function ensureLeasesDir(): void {
  if (!fs.existsSync(LEASES_DIR)) fs.mkdirSync(LEASES_DIR, { recursive: true })
}

function readLeaseData(key: string): LeaseData | null {
  try {
    return JSON.parse(fs.readFileSync(leaseFile(key), 'utf-8')) as LeaseData
  } catch {
    return null
  }
}

function writeLeaseData(key: string, data: LeaseData): void {
  const file = leaseFile(key)
  const tmp  = file + '.tmp'
  const buf  = Buffer.from(JSON.stringify(data))
  const fd   = fs.openSync(tmp, 'w')
  try {
    fs.writeSync(fd, buf)
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
  fs.renameSync(tmp, file)
}

// ── Public API ────────────────────────────────────────────────────────────────

export function acquireLease(key: string, ttlMs = 30_000): boolean {
  ensureLeasesDir()
  const dir = leaseDir(key)

  try {
    // Atomic: throws EEXIST if another process already holds the lease
    fs.mkdirSync(dir)
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e

    // Directory exists — check if lease is expired
    const data = readLeaseData(key)
    if (!data) {
      // Corrupted lease — remove and retry once
      try { fs.rmSync(dir, { recursive: true }) } catch { /* ignore */ }
      return acquireLease(key, ttlMs)
    }

    if (data.expiresAt < Date.now()) {
      // Expired lease — reclaim it
      console.log(`[LEASE] reclaiming expired lease for "${key}" (was owned by pid=${data.pid})`)
      releaseLease(key)
      return acquireLease(key, ttlMs)
    }

    return false   // another process holds a valid lease
  }

  // We own the directory — write lease metadata
  const leaseData: LeaseData = {
    key,
    owner:      String(process.pid),
    pid:        process.pid,
    expiresAt:  Date.now() + ttlMs,
    acquiredAt: Date.now(),
  }
  try {
    writeLeaseData(key, leaseData)
  } catch {
    // Failed to write metadata — release the dir so we don't leave a ghost lease
    try { fs.rmdirSync(dir) } catch { /* ignore */ }
    return false
  }

  return true
}

export function releaseLease(key: string): void {
  const dir = leaseDir(key)
  try {
    fs.rmSync(dir, { recursive: true })
  } catch {
    // Already released — that's fine
  }
}

export function renewLease(key: string, ttlMs = 30_000): boolean {
  const data = readLeaseData(key)
  if (!data || data.pid !== process.pid) return false
  data.expiresAt = Date.now() + ttlMs
  try {
    writeLeaseData(key, data)
    return true
  } catch {
    return false
  }
}

export function isLeaseHeld(key: string): boolean {
  const data = readLeaseData(key)
  if (!data) return false
  return data.expiresAt >= Date.now()
}

export function isLeaseExpired(key: string): boolean {
  const data = readLeaseData(key)
  if (!data) return false           // no lease directory at all
  return data.expiresAt < Date.now()
}

export function getLeaseOwner(key: string): LeaseData | null {
  return readLeaseData(key)
}

export function getLeasesDir(): string {
  return LEASES_DIR
}
