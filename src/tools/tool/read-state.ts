import { stat } from 'node:fs/promises'
import path from 'node:path'
import { isEnoentError } from '../../utils/errors.js'

type ReadEntry = {
  mtimeMs: number
  size: number
}

const readFiles = new Map<string, ReadEntry>()

export async function rememberRead(targetPath: string): Promise<void> {
  const resolved = path.resolve(targetPath)
  try {
    const info = await stat(resolved)
    readFiles.set(resolved, { mtimeMs: info.mtimeMs, size: info.size })
  } catch {
    readFiles.delete(resolved)
  }
}

export async function validatePriorRead(targetPath: string): Promise<string | null> {
  const resolved = path.resolve(targetPath)
  let info
  try {
    info = await stat(resolved)
  } catch (error) {
    if (isEnoentError(error)) {
      return null
    }
    throw error
  }

  const entry = readFiles.get(resolved)
  if (!entry) {
    return `File "${targetPath}" exists but has not been read yet. Use the read tool on it first, then retry.`
  }

  if (entry.mtimeMs !== info.mtimeMs || entry.size !== info.size) {
    return `File "${targetPath}" changed since it was last read. Read it again before modifying it.`
  }

  return null
}
