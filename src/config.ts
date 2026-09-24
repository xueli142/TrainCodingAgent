import path from 'node:path'
import os from 'node:os'
import 'dotenv/config'
export const MODEL = process.env.MODEL as string
export const API_KEY = process.env.API_KEY as string
 export const BASE_URL = process.env.BASE_URL as string
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
}

export const mcpConfig: Record<string, McpServerConfig> = {
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
  },
}

