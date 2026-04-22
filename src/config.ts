import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')

export const CONFIG = {
  // Paths — override via env vars or fall back to project-relative defaults
  WHISPER_CLI:   process.env.WHISPER_CLI   ?? path.join(ROOT, 'whisper.cpp/build/bin/whisper-cli'),
  WHISPER_MODEL: process.env.WHISPER_MODEL ?? path.join(ROOT, 'whisper.cpp/models/ggml-tiny.en.bin'),
  VENV_PYTHON:   process.env.VENV_PYTHON   ?? path.join(ROOT, '.venv/bin/python3'),

  // Audio
  SAMPLE_RATE: 16000,
  CHANNELS: 1,
  VAD_THRESHOLD: 0.015,
  SILENCE_MS: 500,
  MIN_SPEECH_MS: 150,
  PRE_SPEECH_PAD_MS: 200,

  // Pipeline
  MAX_OUTPUT_WORDS: 7,
  CONFIDENCE_THRESHOLD: 0.7,
  LATENCY_BUDGET_MS: 300,
  MAX_TRANSCRIPT_CHARS: 2000,  // input cap before regex; ~300 spoken words

  // LLM
  OLLAMA_URL: 'http://localhost:11434/api/chat',
  OLLAMA_MODEL: 'llama3.2',

  // Timeouts (ms) — single source of truth for all network/IO calls
  OLLAMA_EMBED_TIMEOUT_MS:   5_000,
  OLLAMA_STREAM_TIMEOUT_MS: 15_000,
  OLLAMA_SUMMARY_TIMEOUT_MS: 10_000,
  OLLAMA_DRAFT_TIMEOUT_MS:    8_000,
  OLLAMA_RECALL_TIMEOUT_MS:   8_000,
  OLLAMA_STEERING_TIMEOUT_MS: 4_000,
  OLLAMA_RECAP_TIMEOUT_MS:   15_000,
  WEB_SEARCH_TIMEOUT_MS:      3_000,

  // Session
  SESSION_END_SILENCE_MS: 120_000,
  MIN_SESSION_TURNS: 2,
  MAX_SUMMARY_CHARS: 500,
  PLAYS_RETENTION_DAYS: 30,
} as const
