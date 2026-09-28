import path from 'node:path'
import os from 'node:os'
import 'dotenv/config'
// 不要 import 'dotenv/config'
import { readFileSync } from 'node:fs'
import { parse } from 'dotenv'

const dotenvVars = (() => {
  try { return parse(readFileSync(path.join(process.cwd(), '.env'))) }
  catch { return {} }
})()

export const MODEL   = process.env.MODEL   ?? dotenvVars.MODEL
export const API_KEY = process.env.API_KEY ?? dotenvVars.API_KEY
export const BASE_URL = process.env.BASE_URL ?? dotenvVars.BASE_URL

export type RuntimeConfig = {
  model: string
  baseUrl: string
  authToken?: string
  apiKey?: string
  maxOutputTokens?: number
 
  sourceSummary: string
}
export const ICEFOX_CODE_DIR = process.env.ICEFOX_CODE_HOME
  ? path.resolve(process.env.ICEFOX_CODE_HOME)
  : path.join(os.homedir(), '.ICEFOX-code')

export type McpServerConfig = {
  command?: string
  args?: string[]
  env?: Record<string, string>
  url?: string
  headers?: Record<string, string>
  enabled?: boolean
}

//兜底默认（BUILT_IN）；正式配置放 ~/.ICEFOX-code/mcp.json 与 <cwd>/.icefox/mcp.json
const DEFAULT_MCP_SERVERS: Record<string, McpServerConfig> = {
  fs: {
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem', process.cwd()],
  },

  cook:{
    command:'npx',
    args:['-y','howtocook-mcp']

  },
  remote_demo: {
    url: 'http://localhost:3000/mcp',
    headers: { Authorization: 'Bearer ${MY_TOKEN}' },  // 可选，$ENV 插值
    enabled: false,
  },
}

function shapeCheck(raw: unknown): Record<string, McpServerConfig> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {}
  const out: Record<string, McpServerConfig> = {}
  for (const [name, entry] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof entry === 'object' && entry !== null) {
      out[name] = entry as McpServerConfig
    }
  }
  return out
}

/** 两级合并：用户级 mcp.json → 项目级 .icefox/mcp.json 覆盖同名；都没有则用内置默认 */
export async function loadMcpConfig(cwd: string): Promise<Record<string, McpServerConfig>> {
  const { readFile } = await import('node:fs/promises')
  let merged: Record<string, McpServerConfig> = { ...DEFAULT_MCP_SERVERS }
  for (const file of [
    path.join(ICEFOX_CODE_DIR, 'mcp.json'),
    path.join(cwd, '.icefox', 'mcp.json'),
  ]) {
    try {
      const parsed = JSON.parse(await readFile(file, 'utf8')) as { mcpServers?: unknown }
      merged = { ...merged, ...shapeCheck(parsed.mcpServers ?? parsed) }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code
      if (code !== 'ENOENT') {
        console.warn(`[mcp] 配置解析失败 ${file}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }
  return merged
}

