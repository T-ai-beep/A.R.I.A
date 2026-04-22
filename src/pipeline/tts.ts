/**
 * tts.ts — TypeScript wrapper for the Python TTS worker
 *
 * OPT-5: Pre-warm on module import.
 * getProc() is called immediately when the module loads, which:
 *   1. Spawns the Python process
 *   2. Python opens the sounddevice OutputStream
 *   3. Python synthesises a silent pre-warm phrase to load Kokoro weights
 *
 * By the time the first real speak() call arrives, the OutputStream is
 * already open and Kokoro weights are paged into RAM. First audio latency
 * is warm, not cold.
 *
 * Path resolution uses import.meta.url so SCRIPT resolves correctly
 * regardless of cwd — works from both A.R.I.A/ and IRA_test_suite/.
 */
import { spawn } from 'child_process'
import * as path from 'path'
import { fileURLToPath } from 'url'
import { CONFIG } from '../config.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname  = path.dirname(__filename)
// Resolves to A.R.I.A/scripts/tts.py regardless of working directory
const SCRIPT = path.resolve(__dirname, '..', '..', 'scripts', 'tts.py')

type ProcLike = {
  stdin: { write: (data: string, cb?: (e: Error | null | undefined) => void) => void } | null
  killed: boolean
}

let proc: ReturnType<typeof spawn> | null = null
let spawnFailed = false

const NOP_PROC: ProcLike = { stdin: { write: () => {} }, killed: false }

process.on('uncaughtException', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EPIPE') return  // TTS pipe broken — ignore in test env
  throw err
})

function getProc(): ProcLike {
  if (process.env.NODE_ENV === 'test' || process.env.NO_TTS === '1' || spawnFailed) {
    return NOP_PROC
  }
  if (proc && !proc.killed) return proc

  proc = spawn(CONFIG.VENV_PYTHON, [SCRIPT])

  proc.stderr?.on('data', (d: Buffer) => {
    const msg = d.toString().trim()
    // Only log non-noise messages
    if (msg && !msg.startsWith('UserWarning') && !msg.startsWith('torch')) {
      console.error('[TTS]', msg)
    }
  })

  proc.stdout?.on('data', (d: Buffer) => {
    // Forward TTS process stdout logs (TTFC timing etc)
    const msg = d.toString().trim()
    if (msg) console.log(msg)
  })

  proc.on('error', (err) => {
    console.error('[TTS] spawn error (TTS disabled):', err.message)
    spawnFailed = true
    proc = null
  })

  proc.on('exit', (code) => {
    console.log(`[TTS] process exited (code=${code})`)
    proc = null
  })

  return proc
}

/**
 * speak() — enqueue text for TTS synthesis and playback.
 *
 * Fire-and-forget: returns immediately after writing to the worker's stdin.
 * The Python worker synthesises and plays in a background queue thread.
 *
 * Chunking is handled on the Python side (≤4 words per Kokoro call).
 * The TypeScript side can also pass pre-chunked text (3-word LLM streaming
 * chunks) — Python will re-chunk if needed but typically they arrive
 * already short enough to pass through as single chunks.
 */
export function speak(text: string): void {
  if (!text || !text.trim()) return

  const t0 = Date.now()
  const p  = getProc()

  const payload = JSON.stringify({ text: text.trim() }) + '\n'
  try {
    p.stdin?.write(payload, (err) => {
      if (err) console.log(`[TTS] write error (no-op in test): ${err.message}`)
    })
    console.log(`[TTS] ${Date.now() - t0}ms queued — "${text.slice(0, 60)}"`)
  } catch {
    console.log(`[TTS] skipped (pipe unavailable): "${text.slice(0, 40)}"`)
  }
}

// ── OPT-5: Pre-warm immediately on module load ────────────────────────────
// Spawns the Python process and triggers Kokoro weight loading.
// By the time the pipeline processes its first transcript, TTS is warm.
getProc()