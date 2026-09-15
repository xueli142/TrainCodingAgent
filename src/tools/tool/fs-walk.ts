import { readdir } from 'node:fs/promises'
import path from 'node:path'

export const SKIP_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  'out',
  '.next',
  '__pycache__',
])

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function globToRegExp(pattern: string): RegExp {
  const normalized = pattern.replace(/\\/g, '/')
  let source = ''
  let i = 0

  while (i < normalized.length) {
    const ch = normalized[i]

    if (ch === '*') {
      if (normalized[i + 1] === '*') {
        i += 2
        if (normalized[i] === '/') {
          i += 1
          source += '(?:.*/)?'
        } else {
          source += '.*'
        }
        continue
      }
      i += 1
      source += '[^/]*'
      continue
    }

    if (ch === '?') {
      i += 1
      source += '[^/]'
      continue
    }

    if (ch === '{') {
      const end = normalized.indexOf('}', i)
      if (end !== -1) {
        const options = normalized
          .slice(i + 1, end)
          .split(',')
          .map(option => escapeRegExp(option.trim()))
          .join('|')
        source += `(?:${options})`
        i = end + 1
        continue
      }
    }

    source += escapeRegExp(ch)
    i += 1
  }

  return new RegExp(`^${source}$`, 'i')
}

export function toPosixRelative(root: string, target: string): string {
  return path.relative(root, target).split(path.sep).join('/')
}

export async function* walkFiles(
  root: string,
  limit = 20_000,
): AsyncGenerator<string> {
  const stack = [path.resolve(root)]
  let yielded = 0

  while (stack.length > 0 && yielded < limit) {
    const dir = stack.pop() as string
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }

    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) {
          stack.push(full)
        }
        continue
      }

      if (!entry.isFile()) {
        continue
      }

      yielded += 1
      yield full

      if (yielded >= limit) {
        return
      }
    }
  }
}
