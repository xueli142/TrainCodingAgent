import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import {
  CallToolResultSchema,
  ToolListChangedNotificationSchema,
  type CallToolResult,
  type Tool as McpToolDef,
} from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import { registerTool, unregisterToolsByPrefix } from './tools/index.js'
import type { ToolDefinition, ToolResult } from './tool.js'
import type { McpServerConfig } from './config.js'

const CONNECT_TIMEOUT_MS = 10_000
const CALL_TIMEOUT_MS = 30_000

export type McpServerStatus = {
  name: string
  status: 'connected' | 'failed'
  toolCount: number
  error?: string
}

const statusMap = new Map<string, McpServerStatus>()
const clientMap = new Map<string, Client>()

export function getMcpStatus(): McpServerStatus[] {
  return [...statusMap.values()]
}

function sanitize(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, '_')
}

function toolId(serverName: string, toolName: string): string {
  return `mcp__${sanitize(serverName)}__${sanitize(toolName)}`
}
//CallToolResult是mcp拉下来的工具，转换为icefox的ToolResult，这样才能被注册进ciefox 的tools中
function toToolResult(r: CallToolResult): ToolResult {
  const text = (r.content ?? [])
    .map(c => (c.type === 'text' ? c.text : JSON.stringify(c, null, 2)))
    .join('\n\n')
  const structured =
    r.structuredContent === undefined
      ? ''
      : `STRUCTURED_CONTENT:\n${JSON.stringify(r.structuredContent, null, 2)}`
  const output = [text, structured].filter(Boolean).join('\n\n').trim()
  return { ok: !r.isError, output: output || (r.isError ? 'MCP tool returned an error' : '') }
}

async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`MCP ${label}: timed out after ${ms}ms`)), ms)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

async function connectOne(cfg: McpServerConfig): Promise<Client> {
  const client = new Client({ name: 'icefox', version: '0.1.0' }, { capabilities: {} })
  const transport = cfg.url
    ? new StreamableHTTPClientTransport(new URL(cfg.url), {
        requestInit: cfg.headers ? { headers: cfg.headers } : undefined,
      })
    : new StdioClientTransport({
        command: cfg.command ?? '',
        args: cfg.args ?? [],
        env: cfg.env,
        stderr: 'pipe',
      })
  await withTimeout(client.connect(transport), CONNECT_TIMEOUT_MS, 'connect')
  return client
}

async function listAllTools(client: Client): Promise<McpToolDef[]> {
  const tools: McpToolDef[] = []
  let cursor: string | undefined
  for (;;) {
    const page = await withTimeout(
      client.listTools(cursor ? { cursor } : {}, { timeout: CONNECT_TIMEOUT_MS }),
      CONNECT_TIMEOUT_MS * 2,
      'listTools',
    )
    tools.push(...page.tools)
    if (!page.nextCursor) return tools
    cursor = page.nextCursor
  }
}
//这里注册到Tool registerTool中
function publishTools(serverName: string, client: Client, defs: McpToolDef[]): void {
  unregisterToolsByPrefix(`mcp__${sanitize(serverName)}__`)
  for (const def of defs) {
    registerTool({
      name: toolId(serverName, def.name),
      //隐式分类标注：name 带 mcp__ 前缀，description 头部带 MCP tool 字样（进 schema 和目录消息）
      description: `MCP tool from server "${serverName}" (remote name: "${def.name}"). ${def.description?.trim() ?? ''}`.trim(),
      inputSchema: def.inputSchema as Record<string, unknown>,
      schema: z.unknown(),
      run: async input => {
        const result = (await withTimeout(
          client.callTool(
            { name: def.name, arguments: (input ?? {}) as Record<string, unknown> },
            CallToolResultSchema,
            { timeout: CALL_TIMEOUT_MS },
          ),
          CALL_TIMEOUT_MS + 1000,
          serverName,
        )) as CallToolResult
        return toToolResult(result)
      },
    } satisfies ToolDefinition<unknown>)
  }
}

export async function connectMcpServers(
  servers: Record<string, McpServerConfig>,
): Promise<McpServerStatus[]> {
  await Promise.all(
    Object.entries(servers).map(async ([name, cfg]) => {
      try {
        const client = await connectOne(cfg)
        const defs = await listAllTools(client)
        clientMap.set(name, client)
        statusMap.set(name, { name, status: 'connected', toolCount: defs.length })
        publishTools(name, client, defs)

        client.onclose = () => {
          statusMap.set(name, { name, status: 'failed', toolCount: 0, error: 'connection closed' })
          clientMap.delete(name)
          unregisterToolsByPrefix(`mcp__${sanitize(name)}__`)
        }
        // 服务器清单热更新（ToolListChangedNotification）
        client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
          try {
            const next = await listAllTools(client)
            statusMap.set(name, { name, status: 'connected', toolCount: next.length })
            publishTools(name, client, next)
          } catch {
            /* 保持旧清单 */
          }
        })
        console.log(`[mcp] ${name}: connected, ${defs.length} tools`)
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error)
        statusMap.set(name, { name, status: 'failed', toolCount: 0, error: msg })
        console.error(`[mcp] ${name}: ${msg}`)
      }
    }),
  )
  return getMcpStatus()
}

export async function disposeMcp(): Promise<void> {
  const clients = [...clientMap.values()]
  clientMap.clear()
  await Promise.all(clients.map(c => c.close().catch(() => {})))
}
