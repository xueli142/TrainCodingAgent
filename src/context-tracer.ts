import { appendFile, mkdir, readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { ICEFOX_CODE_DIR } from './config.js'

/**
 * 完整上下文监视：每个发往模型的请求（fold 后的 system、线格式 messages、
 * tools 全 schema）逐轮 append 成 trace jsonl，供 inspect-trace 离线查看。
 * 关闭状态下零开销（traceRequest 直接 return）。
 */

export type TracedTool = {
  name: string
  description: string
  descChars: number
  schemaChars: number
  schema: unknown
}

export type RequestTraceEntry = {
  ts: string
  turn: number
  model: string
  systemChars: number
  messagesChars: number
  totalChars: number
  system: string
  messages: unknown[]
  tools: TracedTool[]
}

export type RequestTraceInput = {
  model: string
  system: string
  messages: unknown[]
  tools: Array<{ name: string; description: string; input_schema: unknown }>
}

let tracePath: string | null = null
let turn = 0
let writeQueue: Promise<void> = Promise.resolve()

export function tracesDir(): string {
  return path.join(ICEFOX_CODE_DIR, 'traces')
}

export async function enableTrace(tag: string): Promise<string> {
  const safe = tag.replace(/[^A-Za-z0-9._-]/g, '_') || 'session'
  await mkdir(tracesDir(), { recursive: true })
  tracePath = path.join(tracesDir(), `${Date.now()}-${safe}.jsonl`)
  turn = 0
  return tracePath
}

export function traceFilePath(): string | null {
  return tracePath
}

export function isTraceEnabled(): boolean {
  return tracePath !== null
}

export function traceRequest(input: RequestTraceInput): void {
  if (!tracePath) {
    return
  }
  turn += 1
  const tools: TracedTool[] = input.tools.map(tool => {
    const schema = JSON.stringify(tool.input_schema)
    return {
      name: tool.name,
      description: tool.description,
      descChars: tool.description.length,
      schemaChars: schema.length,
      schema: tool.input_schema,
    }
  })
  const messages = JSON.stringify(input.messages)
  const entry: RequestTraceEntry = {
    ts: new Date().toISOString(),
    turn,
    model: input.model,
    systemChars: input.system.length,
    messagesChars: messages.length,
    totalChars: input.system.length + messages.length + JSON.stringify(tools).length,
    system: input.system,
    messages: input.messages,
    tools,
  }
  const payload = JSON.stringify(entry) + '\n'
  const target = tracePath
  writeQueue = writeQueue.then(() => appendFile(target, payload, 'utf8').then(() => undefined))
  writeQueue = writeQueue.catch(() => {})
}

export async function flushTrace(): Promise<void> {
  await writeQueue
}

export async function listTraceFiles(): Promise<string[]> {
  try {
    const entries = await readdir(tracesDir())
    return entries
      .filter(name => name.endsWith('.jsonl'))
      .sort()
      .map(name => path.join(tracesDir(), name))
  } catch {
    return []
  }
}

export async function readTraceEntries(file: string): Promise<RequestTraceEntry[]> {
  const content = await readFile(file, 'utf8')
  return content
    .trim()
    .split('\n')
    .filter(Boolean)
    .map(line => {
      try {
        return JSON.parse(line) as RequestTraceEntry
      } catch {
        return null
      }
    })
    .filter((entry): entry is RequestTraceEntry => Boolean(entry))
}
