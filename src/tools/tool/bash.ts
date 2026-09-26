import { spawn } from 'node:child_process'
import { openSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import type { ToolContent, ToolDefinition, ToolResult } from '../../tool.js'
import { buildProcessEnvironment } from '../../environment.js'
import { resolveToolPath } from '../../workspace.js'
import { jsonSchemaOf } from './schema-io.js'
import { ICEFOX_CODE_DIR } from '../../config.js'

const DEFAULT_TIMEOUT_MS = 120_000
const FORCE_KILL_GRACE_MS = 3_000

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
  background: z
    .boolean()
    .optional()
    .describe(
      'If true, detach the job immediately: output streams to a log file you can read with the read tool, returns pid/log path right away. Also auto-detected from a trailing &.',
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

type RunOutcome = {
  text: string
  exitCode: number | null
  timedOut: boolean
  aborted: boolean
  spawnError?: string
}

function runShell(
  shell: string,
  shellArgs: string[],
  cwd: string,
  timeoutMs: number,
  signal?: AbortSignal,
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
    let aborted = false
    let settled = false

    const finish = (exitCode: number | null, spawnError?: string) => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      resolve({
        text: Buffer.concat(chunks).toString('utf8'),
        exitCode,
        timedOut,
        aborted,
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

    const onAbort = () => {
      if (settled) {
        return
      }
      aborted = true
      killTree()
      setTimeout(() => finish(null), FORCE_KILL_GRACE_MS + 500).unref()
    }
    if (signal) {
      if (signal.aborted) {
        onAbort()
      } else {
        signal.addEventListener('abort', onAbort, { once: true })
      }
    }
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

async function runBackground(
  shell: string,
  prefixArgs: string[],
  command: string,
  cwd: string,
): Promise<ToolResult> {
  const jobId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
  const jobsDir = path.join(ICEFOX_CODE_DIR, 'jobs')
  await mkdir(jobsDir, { recursive: true })
  const logPath = path.join(jobsDir, `${jobId}.log`)
  const fd = openSync(logPath, 'a')
  //sentinel：shell 收尾时往日志尾追一行退出码，模型据此判活/判死
  const wrapped =
    shell === 'powershell.exe'
      ? `${command}\nWrite-Output "[icefox-job exited code $LASTEXITCODE]"`
      : `${command}\necho "[icefox-job exited code $?]"`
  const child = spawn(shell, [...prefixArgs, wrapped], {
    cwd,
    env: process.env,
    stdio: ['ignore', fd, fd],
    detached: true,
    windowsHide: true,
  })
  child.unref()
  const pid = child.pid ?? '?'
  return {
    ok: true,
    output: [
      `Started background job ${jobId} (pid ${pid}).`,
      `Log: ${logPath}`,
      'Check progress with the read tool on the log path; the log ends with "[icefox-job exited code N]".',
      process.platform === 'win32'
        ? `Kill via bash: taskkill /pid ${pid} /T /F`
        : `Kill via bash: kill ${pid}`,
    ].join('\n'),
  }
}

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
    '- For long-running work (dev servers, builds, watch), pass background:true (or end with &): you get a pid + log path immediately and can read the log later.',
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

    //尾随 & 自动识别为后台任务
    const trimmedCommand = input.command.trimEnd()
    const isBackground = input.background === true || /&$/.test(trimmedCommand)
    const command = isBackground ? trimmedCommand.replace(/&$/, '').trimEnd() : trimmedCommand

    await approveCommandSegments(context, command, cwd)
    await gateTouchedPaths(context, command, cwd)

    const { shell, prefixArgs } = shellForPlatform()

    if (isBackground) {
      return runBackground(shell, prefixArgs, command, cwd)
    }

    const outcome = await runShell(
      shell,
      [...prefixArgs, command],
      cwd,
      timeout,
      context.signal,
    )

    if (outcome.spawnError) {
      return {
        ok: false,
        output: `Failed to start shell (${shell}): ${outcome.spawnError}`,
      }
    }

    const text = outcome.text.replace(/\r/g, '').trim()
    const parts: string[] = [text.length > 0 ? text : '(no output)']

    if (outcome.aborted) {
      parts.push('<shell_metadata>Command aborted by user (turn cancelled via Ctrl+C).</shell_metadata>')
    } else if (outcome.timedOut) {
      parts.push(
        `<shell_metadata>Command terminated after exceeding the ${timeout} ms timeout. If it legitimately needs longer, pass a larger timeout, use background:true, or split the command.</shell_metadata>`,
      )
    } else if (outcome.exitCode !== 0) {
      parts.push(`<shell_metadata>Exit code: ${outcome.exitCode}</shell_metadata>`)
    }

    return {
      ok: !outcome.timedOut && !outcome.aborted && outcome.exitCode === 0,
      output: parts.join('\n\n'),
    }
  },
}
