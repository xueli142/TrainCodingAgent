import { spawn } from 'node:child_process'
import path from 'node:path'
import { z } from 'zod'
import type { ToolContent, ToolDefinition } from '../../tool.js'
import { buildProcessEnvironment } from '../../environment.js'
import { resolveToolPath } from '../../workspace.js'
import { jsonSchemaOf } from './schema-io.js'

const DEFAULT_TIMEOUT_MS = 120_000
const FORCE_KILL_GRACE_MS = 3_000
const MAX_OUTPUT_LINES = 2_000
const MAX_OUTPUT_BYTES = 50 * 1024

const schema = z.object({
  command: z.string().describe('The command to execute'),
  timeout: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('Optional timeout in milliseconds. Defaults to 120000ms.'),
  workdir: z
    .string()
    .optional()
    .describe(
      'The working directory to run the command in. Defaults to the current directory. Use this instead of cd commands.',
    ),
})

export type BashInput = z.infer<typeof schema>

function tokenize(commandLine: string): string[] {
  const parts: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null
  let escaping = false

  for (const char of commandLine) {
    if (escaping) {
      current += char
      escaping = false
      continue
    }
    if (char === '\\' && quote !== "'") {
      escaping = true
      continue
    }
    if (quote) {
      if (char === quote) {
        quote = null
      } else {
        current += char
      }
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      continue
    }
    if (/\s/.test(char)) {
      if (current.length > 0) {
        parts.push(current)
        current = ''
      }
      continue
    }
    current += char
  }

  if (escaping) {
    current += '\\'
  }
  if (current.length > 0) {
    parts.push(current)
  }
  return parts
}

async function approveCommandSegments(
  context: ToolContent,
  command: string,
  cwd: string,
): Promise<void> {
  for (const segment of command.split(/[;&|]+/)) {
    const tokens = tokenize(segment)
    if (tokens.length === 0) {
      continue
    }
    const [head, ...rest] = tokens
    await context.permissions?.ensureCommand(head, rest, cwd)
  }
}

/** 从整条命令行抽路径候选：引号包裹的绝对路径 / 裸盘符路径 / ..相对路径 */
export function extractPathCandidates(command: string): string[] {
  const found = new Set<string>()
  const patterns = [
    /["']((?:[A-Za-z]:[\\/]|\\\\)[^"']+)["']/g,
    /(?:^|[\s=,(])([A-Za-z]:[\\/][^\s"',;)|>]*)/g,
    /(?:^|[\s=,(])((?:\.\.[\\/])+[^\s"',;)|>]*)/g,
  ]
  for (const pattern of patterns) {
    for (const match of command.matchAll(pattern)) {
      const raw = match[1]?.trim()
      if (raw && raw.length > 2) {
        found.add(raw)
      }
    }
  }
  return [...found]
}

/**
 * 绕行硬闸：命令里触碰的每个路径——
 *  - 越出 workspace → 过与 write 同一把 path 闸（同一张卡、同一份拒绝记忆）
 *    （path 闸无 approver 时会抛中性硬停文案，不会被当成绕行线索）
 *  - 命中已被用户拒绝的 edit 目标 → 直接抛，不再弹卡（deny 记忆不可被 bash 洗掉）
 */
async function gateTouchedPaths(context: ToolContent, command: string, cwd: string): Promise<void> {
  const permissions = context.permissions
  if (!permissions) {
    return
  }
  for (const raw of extractPathCandidates(command)) {
    let candidate: string
    try {
      candidate = path.resolve(cwd, raw)
    } catch {
      continue
    }
    const relative = path.relative(cwd, candidate)
    const inside =
      relative === '' ||
      (!relative.startsWith('..') && !path.isAbsolute(relative))

    if (await permissions.isEditDenied(candidate)) {
      throw new Error(
        `Blocked: the user already denied edits touching ${candidate}. This denial cannot be bypassed via bash — stop and ask the user what to do.`,
      )
    }
    if (!inside) {
      await permissions.ensurePathAccess(candidate, 'write')
    }
  }
}

function tailLimit(text: string): { text: string; cut: boolean } {
  const lines = text.split('\n')
  const kept: string[] = []
  let bytes = 0
  let cut = false

  for (let i = lines.length - 1; i >= 0; i--) {
    const size = Buffer.byteLength(lines[i], 'utf8') + (kept.length > 0 ? 1 : 0)
    if (kept.length >= MAX_OUTPUT_LINES || bytes + size > MAX_OUTPUT_BYTES) {
      cut = true
      break
    }
    kept.unshift(lines[i])
    bytes += size
  }

  return { text: kept.join('\n'), cut }
}

type RunOutcome = {
  text: string
  exitCode: number | null
  timedOut: boolean
  spawnError?: string
}

function runShell(
  shell: string,
  shellArgs: string[],
  cwd: string,
  timeoutMs: number,
): Promise<RunOutcome> {
  return new Promise(resolve => {
    const child = spawn(shell, shellArgs, {
      cwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })

    const chunks: Buffer[] = []
    let timedOut = false
    let settled = false

    const finish = (exitCode: number | null, spawnError?: string) => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timer)
      resolve({
        text: Buffer.concat(chunks).toString('utf8'),
        exitCode,
        timedOut,
        spawnError,
      })
    }

    child.stdout.on('data', chunk => chunks.push(Buffer.from(chunk)))
    child.stderr.on('data', chunk => chunks.push(Buffer.from(chunk)))

    child.on('error', error => {
      finish(null, error.message)
    })

    child.on('close', code => {
      finish(typeof code === 'number' ? code : null)
    })

    const killTree = () => {
      timedOut = true
      if (process.platform === 'win32') {
        const killer = spawn(
          'taskkill',
          ['/pid', String(child.pid), '/T', '/F'],
          { windowsHide: true, stdio: 'ignore' },
        )
        killer.on('error', () => {
          child.kill()
        })
      } else {
        child.kill('SIGTERM')
        setTimeout(() => {
          if (!settled) {
            child.kill('SIGKILL')
          }
        }, FORCE_KILL_GRACE_MS).unref()
      }
    }

    const timer = setTimeout(() => {
      if (settled) {
        return
      }
      killTree()
      setTimeout(() => finish(null), FORCE_KILL_GRACE_MS + 500).unref()
    }, timeoutMs)
  })
}

function shellForPlatform(): { shell: string; prefixArgs: string[] } {
  if (process.platform === 'win32') {
    return {
      shell: 'powershell.exe',
      prefixArgs: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command'],
    }
  }
  return { shell: process.env.SHELL || '/bin/bash', prefixArgs: ['-lc'] }
}

const PROC_ENV = buildProcessEnvironment()

export const BashTool: ToolDefinition<BashInput> = {
  name: 'bash',
  description: [
    'Executes a given shell command with optional timeout, and returns combined stdout/stderr.',
    `Be aware: OS=${PROC_ENV.platform}, Shell=${PROC_ENV.shellKind}.`,
    '',
    'Usage:',
    '- This tool is for terminal operations like git, npm, docker. Use the read/write/edit/glob/grep tools for file operations instead of cat/sed/Get-Content.',
    "- All commands run in the current working directory by default. Use the workdir parameter to change directory; do NOT cd inside the command string.",
    '- Quote file paths that contain spaces. Chain dependent commands with "&&" on unix shells and with `; if ($?) { cmd2 }` on Windows PowerShell.',
    '- If you need to run multiple independent commands in parallel, make multiple bash tool calls in a single response.',
    '- Before running commands that create files or directories, verify the parent path exists.',
    '- If a previous write/edit to a path was denied by the user, you MUST NOT recreate that effect via bash (Set-Content, Out-File, redirection, WriteAllText, rm, mv, ...). Denials are enforced at this tool and are final for the session.',
    '',
    'Git:',
    '- Only commit, amend, push, or create PRs when explicitly requested by the user.',
    '- Before committing, inspect git status, git diff, and git log. Stage only intended files and never commit secrets.',
  ].join('\n'),
  inputSchema: jsonSchemaOf(schema),
  schema,
  async run(input, context) {
    const cwd = input.workdir
      ? await resolveToolPath(context, input.workdir, 'list')
      : context.cwd

    const timeout = input.timeout ?? DEFAULT_TIMEOUT_MS

    await approveCommandSegments(context, input.command, cwd)
    await gateTouchedPaths(context, input.command, cwd)

    const { shell, prefixArgs } = shellForPlatform()
    const outcome = await runShell(shell, [...prefixArgs, input.command], cwd, timeout)

    if (outcome.spawnError) {
      return {
        ok: false,
        output: `Failed to start shell (${shell}): ${outcome.spawnError}`,
      }
    }

    const trimmed = outcome.text.replace(/\r/g, '').trim()
    const limited = tailLimit(trimmed)

    const parts: string[] = []
    if (limited.cut) {
      parts.push('... (earlier output truncated, showing the tail)')
    }
    parts.push(limited.text.length > 0 ? limited.text : '(no output)')

    if (outcome.timedOut) {
      parts.push(
        `<shell_metadata>Command terminated after exceeding the ${timeout} ms timeout. If it legitimately needs longer, pass a larger timeout. User aborted the command.</shell_metadata>`,
      )
    } else if (outcome.exitCode !== 0) {
      parts.push(`<shell_metadata>Exit code: ${outcome.exitCode}</shell_metadata>`)
    }

    return {
      ok: !outcome.timedOut && outcome.exitCode === 0,
      output: parts.join('\n\n'),
    }
  },
}
