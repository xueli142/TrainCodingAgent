import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ICEFOX_CODE_DIR } from './config.js'

/**
 * 两套环境（对齐"事实 vs 现场"原则）：
 *  - ProcessEnvironment：继承自进程（平台/架构/shell/home/data dir...），进程内不可变
 *  - ProjectEnvironment：项目信任环境（工作区根、git、trust 状态、项目数据目录）
 * 供 system prompt 的 env 块、权限摘要、会话分桶共用。
 */

export type ProcessEnvironment = {
  platform: string
  arch: string
  nodeVersion: string
  shell: string
  shellKind: 'powershell' | 'cmd' | 'posix'
  home: string
  hostname: string
  dataDir: string
  tmpDir: string
  startedAt: number
}

export type ProjectEnvironment = {
  directory: string
  root: string
  slug: string
  isGitRepo: boolean
  trusted: boolean
  storeDir: string
  skillsDir: string
}

function detectShell(): { shell: string; kind: 'powershell' | 'cmd' | 'posix' } {
  if (process.platform === 'win32') {
    const comspec = process.env.COMSPEC ?? ''
    if (/cmd\.exe$/i.test(comspec)) {
      return { shell: 'cmd.exe', kind: 'cmd' }
    }
    return { shell: 'powershell.exe', kind: 'powershell' }
  }
  return { shell: process.env.SHELL || '/bin/bash', kind: 'posix' }
}

export function buildProcessEnvironment(): ProcessEnvironment {
  const shell = detectShell()
  return {
    platform: process.platform,
    arch: process.arch,
    nodeVersion: process.version,
    shell: shell.shell,
    shellKind: shell.kind,
    home: os.homedir(),
    hostname: os.hostname(),
    dataDir: ICEFOX_CODE_DIR,
    tmpDir: os.tmpdir(),
    startedAt: Date.now(),
  }
}

export function projectSlug(directory: string): string {
  return path.resolve(directory).replace(/[/\\:]+/g, '-').replace(/^-+/, '')
}

function findGitRoot(start: string): string | null {
  let dir = path.resolve(start)
  for (let depth = 0; depth < 12; depth++) {
    if (fs.existsSync(path.join(dir, '.git'))) {
      return dir
    }
    const parent = path.dirname(dir)
    if (parent === dir) {
      return null
    }
    dir = parent
  }
  return null
}

const TRUST_PATH = path.join(ICEFOX_CODE_DIR, 'trust.json')

function readTrustList(): string[] {
  try {
    const raw = JSON.parse(fs.readFileSync(TRUST_PATH, 'utf8')) as { trusted?: string[] }
    return Array.isArray(raw.trusted) ? raw.trusted : []
  } catch {
    return []
  }
}

export function trustProject(root: string): void {
  const list = new Set(readTrustList())
  list.add(path.resolve(root))
  fs.mkdirSync(ICEFOX_CODE_DIR, { recursive: true })
  fs.writeFileSync(TRUST_PATH, JSON.stringify({ trusted: [...list] }, null, 2) + '\n', 'utf8')
}

export function buildProjectEnvironment(
  directory: string,
  proc: ProcessEnvironment = buildProcessEnvironment(),
): ProjectEnvironment {
  const resolved = path.resolve(directory)
  const root = findGitRoot(resolved) ?? resolved
  const slug = projectSlug(resolved)
  return {
    directory: resolved,
    root,
    slug,
    isGitRepo: findGitRoot(resolved) !== null,
    trusted: readTrustList().some(item => path.resolve(item) === root),
    storeDir: path.join(proc.dataDir, 'projects', slug),
    skillsDir: path.join(resolved, '.icefox', 'skills'),
  }
}

export function renderEnvironmentBlock(
  proc: ProcessEnvironment,
  project: ProjectEnvironment,
  modelId: string,
): string[] {
  return [
    [
      `You are running as an agent with this identity:`,
      `  model: ${modelId}`,
      `  platform: ${proc.platform} (${proc.arch}), shell: ${proc.shell} (${proc.shellKind}), node: ${proc.nodeVersion}`,
      `  home: ${proc.home}, data: ${proc.dataDir}`,
      `Today: ${new Date().toDateString()}`,
    ].join('\n'),
    [
      `<environment project="${project.slug}">`,
      `  working_directory: ${project.directory}`,
      `  workspace_root: ${project.root}`,
      `  git_repo: ${project.isGitRepo ? 'yes' : 'no'}`,
      `  trusted: ${project.trusted ? 'yes (persistent approvals allowed)' : 'no (approvals are session-only)'}`,
      `  session_store: ${project.storeDir}`,
      `</environment>`,
    ].join('\n'),
  ]
}
