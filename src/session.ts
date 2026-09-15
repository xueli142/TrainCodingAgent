import { appendFile, mkdir, open, readFile, readdir, rm, stat, unlink } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { ICEFOX_CODE_DIR } from './config.js'
import type { ChatMessage } from './type.js'

/**
 * 会话事件存储（event-sourced，参照 MiniCode/opencode 裁剪）：
 * - 事实源：~/.ICEFOX-code/projects/<cwd-slug>/<sessionId>.jsonl，一行一个 JSON 事件，append-only
 * - 事件按 id（uuid）查找：readEvents → eventIndex → getEvent
 * - 对话历史是事件的投影：projectMessages / resumeMessages
 * - system 与 tool 目录消息不存储（每次启动现场重建）
 */

export type SessionEventType =
  | 'user'
  | 'assistant'
  | 'thinking'
  | 'progress'
  | 'tool_call'
  | 'tool_result'
  | 'summary'
  | 'snip_boundary'
  | 'rename'

export type SessionEvent = {
  id: string
  session: string
  seq: number
  cwd: string
  type: SessionEventType
  ts: string
  parent: string | null
  message: ChatMessage | null
  title?: string
}

export type SessionMeta = {
  id: string
  title: string | undefined
  eventCount: number
  updatedAt: number
}

const MAX_TITLE_LENGTH = 60

function projectDirName(cwd: string): string {
  return cwd.replace(/[/\\:]+/g, '-').replace(/^-+/, '')
}

export function projectsRoot(): string {
  return path.join(ICEFOX_CODE_DIR, 'projects')
}

function projectDir(cwd: string): string {
  return path.join(projectsRoot(), projectDirName(cwd))
}

export function sessionFilePath(cwd: string, sessionId: string): string {
  return path.join(projectDir(cwd), `${sessionId}.jsonl`)
}

export function newSessionId(): string {
  return randomUUID().slice(0, 8)
}

function roleToType(message: ChatMessage): SessionEventType {
  switch (message.role) {
    case 'user':
      return 'user'
    case 'assistant':
      return 'assistant'
    case 'assistant_thinking':
      return 'thinking'
    case 'assistant_progress':
      return 'progress'
    case 'assistant_tool_call':
      return 'tool_call'
    case 'tool_result':
      return 'tool_result'
    case 'context_summary':
      return 'summary'
    case 'snip_boundary':
      return 'snip_boundary'
    default:
      throw new Error(`Message role is not persistable: ${message.role}`)
  }
}

function ensureMessageId(message: ChatMessage): string {
  if (!message.id) {
    message.id = randomUUID()
  }
  return message.id
}

export async function readEvents(
  cwd: string,
  sessionId: string,
): Promise<SessionEvent[]> {
  try {
    const content = await readFile(sessionFilePath(cwd, sessionId), 'utf8')
    return content
      .trim()
      .split('\n')
      .filter(Boolean)
      .map(line => {
        try {
          return JSON.parse(line) as SessionEvent
        } catch {
          return null
        }
      })
      .filter((event): event is SessionEvent => Boolean(event?.id))
  } catch {
    return []
  }
}

export function eventIndex(events: SessionEvent[]): Map<string, SessionEvent> {
  return new Map(events.map(event => [event.id, event]))
}

export async function getEvent(
  cwd: string,
  sessionId: string,
  eventId: string,
): Promise<SessionEvent | null> {
  const events = await readEvents(cwd, sessionId)
  return eventIndex(events).get(eventId) ?? null
}

async function appendRawEvents(
  cwd: string,
  sessionId: string,
  events: SessionEvent[],
): Promise<void> {
  await mkdir(projectDir(cwd), { recursive: true })
  const filePath = sessionFilePath(cwd, sessionId)

  const payload = events.map(event => JSON.stringify(event)).join('\n') + '\n'
  const repairedTail = await needsLineTerminator(filePath)
  const handle = await open(filePath, 'a')
  try {
    await handle.writeFile(repairedTail ? '\n' + payload : payload, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
}

async function needsLineTerminator(filePath: string): Promise<boolean> {
  let info
  try {
    info = await stat(filePath)
  } catch {
    return false
  }
  if (info.size === 0) {
    return false
  }
  const probe = await open(filePath, 'r')
  try {
    const buf = Buffer.alloc(1)
    const { bytesRead } = await probe.read(buf, 0, 1, info.size - 1)
    return bytesRead === 1 && buf[0] !== 0x0a
  } finally {
    await probe.close()
  }
}

/**
 * 增量保存：按 message.id 幂等去重，parent/seq 从文件尾部续链。
 * system 与 tool（目录消息）被过滤——它们是现场构建物，不是事实。
 */
export async function saveMessages(
  cwd: string,
  sessionId: string,
  messages: ChatMessage[],
): Promise<number> {
  const existing = await readEvents(cwd, sessionId)
  const savedMessageIds = new Set(
    existing
      .map(event => event.message?.id)
      .filter((id): id is string => typeof id === 'string'),
  )

  const last = existing.at(-1)
  let parent = last?.id ?? null
  let seq = (last?.seq ?? -1) + 1

  const fresh = messages.filter(
    message =>
      message.role !== 'system' &&
      message.role !== 'tool' &&
      !(message.id && savedMessageIds.has(message.id)),
  )

  if (fresh.length === 0) {
    return 0
  }

  const events: SessionEvent[] = []
  for (const message of fresh) {
    const messageId = ensureMessageId(message)
    const event: SessionEvent = {
      id: randomUUID(),
      session: sessionId,
      seq: seq++,
      cwd,
      type: roleToType(message),
      ts: new Date().toISOString(),
      parent,
      message: { ...message, id: messageId },
    }
    parent = event.id
    events.push(event)
  }

  await appendRawEvents(cwd, sessionId, events)
  return events.length
}

/**
 * 批量落盘调度器：scheduleSave 只标脏，tick（默认 1s）合并写。
 * - 同一 session 窗口内多次调用合并为一次 appendRawEvents（单 write + fsync）
 * - 存的是 messages 数组引用，flush 时读取最新全量状态，配合 id 去重天然收敛
 * - 控制事件（rename/snip）不进窗口，仍然即时落盘
 */

export const SAVE_FLUSH_INTERVAL_MS = 1000

type PendingJob = {
  cwd: string
  sessionId: string
  messages: ChatMessage[]
}

const pendingJobs = new Map<string, PendingJob>()
let flushTimer: NodeJS.Timeout | null = null
let flushing = false

function jobKey(cwd: string, sessionId: string): string {
  return `${cwd}\u0000${sessionId}`
}

async function flushPending(): Promise<number> {
  if (flushing || pendingJobs.size === 0) {
    return 0
  }
  flushing = true
  let written = 0
  try {
    for (const job of [...pendingJobs.values()]) {
      pendingJobs.delete(jobKey(job.cwd, job.sessionId))
      written += await saveMessages(job.cwd, job.sessionId, job.messages)
    }
  } finally {
    flushing = false
  }
  return written
}

export function scheduleSave(
  cwd: string,
  sessionId: string,
  messages: ChatMessage[],
): void {
  pendingJobs.set(jobKey(cwd, sessionId), { cwd, sessionId, messages })
  if (!flushTimer) {
    flushTimer = setInterval(() => {
      void flushPending().catch(() => {})
    }, SAVE_FLUSH_INTERVAL_MS)
    flushTimer.unref()
  }
}

/** 立即清空窗口（退出路径：/exit、SIGINT、finally）。await 后数据已在盘上。 */
export async function flushSessionSaves(): Promise<number> {
  if (flushTimer) {
    clearInterval(flushTimer)
    flushTimer = null
  }
  return flushPending()
}

export function hasPendingSaves(): boolean {
  return pendingJobs.size > 0
}

/** 追加控制类事件（rename 等不携带 message 的事实） */
export async function appendControlEvent(
  cwd: string,
  sessionId: string,
  type: 'rename',
  data: { title: string },
): Promise<SessionEvent> {
  const existing = await readEvents(cwd, sessionId)
  const last = existing.at(-1)
  const event: SessionEvent = {
    id: randomUUID(),
    session: sessionId,
    seq: (last?.seq ?? -1) + 1,
    cwd,
    type,
    ts: new Date().toISOString(),
    parent: last?.id ?? null,
    message: null,
    title: data.title,
  }
  await appendRawEvents(cwd, sessionId, [event])
  return event
}

/** 投影：事件 → 下一轮请求可用的 ChatMessage[]（snip 重排，rename 不进对话） */
export function projectMessages(events: SessionEvent[]): ChatMessage[] {
  const snips = events.filter(
    event =>
      event.type === 'snip_boundary' &&
      Array.isArray(
        (event.message as Extract<ChatMessage, { role: 'snip_boundary' }> | null)
          ?.removedMessageIds,
      ),
  )

  const removedToSnip = new Map<string, SessionEvent>()
  for (const snip of snips) {
    const removed = (
      snip.message as Extract<ChatMessage, { role: 'snip_boundary' }>
    ).removedMessageIds
    for (const removedId of removed) {
      removedToSnip.set(removedId, snip)
    }
  }

  const projected: ChatMessage[] = []
  const emittedSnips = new Set<string>()

  for (const event of events) {
    if (event.type === 'rename') {
      continue
    }

    if (event.type === 'snip_boundary') {
      if (snips.length === 0 || !removedToSnip.size) {
        if (event.message) projected.push(event.message)
      }
      continue
    }

    const owningSnip = removedToSnip.get(event.message?.id ?? '')
    if (owningSnip) {
      if (!emittedSnips.has(owningSnip.id)) {
        projected.push(owningSnip.message as ChatMessage)
        emittedSnips.add(owningSnip.id)
      }
      continue
    }

    if (event.message) {
      projected.push({ ...event.message, id: event.message.id } as ChatMessage)
    }
  }

  return projected
}

export async function resumeMessages(
  cwd: string,
  sessionId: string,
): Promise<ChatMessage[] | null> {
  const events = await readEvents(cwd, sessionId)
  if (events.length === 0) {
    return null
  }
  const messages = projectMessages(events)
  return messages.length > 0 ? messages : null
}

export async function sessionExists(
  cwd: string,
  sessionId: string,
): Promise<boolean> {
  const events = await readEvents(cwd, sessionId)
  return events.length > 0
}

function extractTitle(events: SessionEvent[]): string | undefined {
  const renamed = [...events].reverse().find(e => e.type === 'rename' && e.title)
  if (renamed?.title) {
    return renamed.title
  }
  const firstUser = events.find(e => e.type === 'user')
  const content = (firstUser?.message as { content?: unknown } | undefined)?.content
  if (typeof content !== 'string' || !content.trim()) {
    return undefined
  }
  const text = content.trim()
  return text.length > MAX_TITLE_LENGTH
    ? `${text.slice(0, MAX_TITLE_LENGTH)}...`
    : text
}

export async function listSessions(cwd: string): Promise<SessionMeta[]> {
  let entries: string[]
  try {
    entries = await readdir(projectDir(cwd))
  } catch {
    return []
  }

  const results: SessionMeta[] = []
  for (const name of entries.filter(n => n.endsWith('.jsonl'))) {
    const id = name.slice(0, -'.jsonl'.length)
    const filePath = path.join(projectDir(cwd), name)
    try {
      const [info, events] = await Promise.all([
        stat(filePath),
        readEvents(cwd, id),
      ])
      results.push({
        id,
        title: extractTitle(events),
        eventCount: events.length,
        updatedAt: info.mtime?.getTime() ?? 0,
      })
    } catch {
      continue
    }
  }

  results.sort((a, b) => b.updatedAt - a.updatedAt)
  return results
}

export async function latestSessionId(cwd: string): Promise<string | null> {
  const sessions = await listSessions(cwd)
  return sessions[0]?.id ?? null
}

export async function clearSession(
  cwd: string,
  sessionId: string,
): Promise<void> {
  try {
    await unlink(sessionFilePath(cwd, sessionId))
  } catch {
    // already gone
  }
  try {
    const remaining = await readdir(projectDir(cwd))
    if (remaining.length === 0) {
      await rm(projectDir(cwd), { recursive: true, force: true })
    }
  } catch {
    // dir already gone
  }
}
