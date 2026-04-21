/**
 * atomicWrite.ts — crash-safe file writes.
 *
 * Protocol: write to .tmp → fsync → rename
 * If the process is killed mid-write the .tmp is left behind;
 * the original file is untouched. On next start the .tmp is
 * silently ignored (never loaded by any reader).
 */

import * as fs from 'fs'
import * as path from 'path'

export function writeAtomic(filePath: string, data: string): void {
  const tmpPath = filePath + '.tmp'
  const dir = path.dirname(filePath)

  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })

  const fd = fs.openSync(tmpPath, 'w')
  try {
    fs.writeSync(fd, data)
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
  fs.renameSync(tmpPath, filePath)
}
