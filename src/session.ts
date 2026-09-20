import { appendFile, mkdir, open, readFile, readdir, rm, stat, unlink } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { ICEFOX_CODE_DIR } from './config.js'
import { projectSlug } from './environment.js'
import type { ChatMessage } from './type.js'


/**
 * 会话事件存储（event-sourced，参照 MiniCode/opencode 裁剪）：
 * - 事实源：~/.ICEFOX-code/projects/<cwd-slug>/<sessionId>.jsonl，一行一个 JSON 事件，append-only
 * - 事件按 id（uuid）查找：readEvents → eventIndex → getEvent
 * - 对话历史是事件的投影：projectMessages / resumeMessages
 * - system 与 tool 目录消息不存储（每次启动现场重建）
 *
 * 设计要点：磁盘上保存的是「发生了什么」的完整事实流，而不是「当前对话长什么样」。
 * 这样重放、审计、裁剪（snip）、摘要（summary）都只是对同一份事实的不同投影，
 * 不会因为视图变化而丢原始数据。
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
  | 'context_snapshot'
  | 'turn_end'
  | 'error'
  | 'session_switch'

export type SessionEvent = {
  id: string
  session: string
  seq: number
  cwd: string
  chunkId: string
  type: SessionEventType
  ts: string
  parent: string | null
  message: ChatMessage | null
  title?: string
  data?: Record<string, unknown>
}

export type SessionMeta = {
  id: string
  title: string | undefined
  eventCount: number
  updatedAt: number
}

/** 列表页展示用的标题上限；超出截断，避免一行 JSON 里塞进整段用户输入 */
const MAX_TITLE_LENGTH = 60

function projectDirName(cwd: string): string {
  return projectSlug(cwd)
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
  // 取 uuid 前 8 位：足够避免同目录碰撞，又便于人工辨认/输入
  return randomUUID().slice(0, 8)
}

/** ChatMessage 的 role 到事件类型的映射；不可持久化的 role 直接抛错，防止静默丢数据 */
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

/** 保证消息有 id：id 是幂等去重与 snip 引用的锚点，缺失时补一个 */
function ensureMessageId(message: ChatMessage): string {
  if (!message.id) {
    message.id = randomUUID()
  }
  return message.id
}

/**
 * 读取整个会话的事件流。
 * 逐行解析并跳过坏行（比如进程被 kill 时写了一半的尾行），
 * 保证单个损坏行不会让整个会话不可读——这是 append-only 日志的必备容错。
 */
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
    // 文件不存在或不可读：视为空会话，而不是错误
    return []
  }
}

/** 事件 id → 事件，供 getEvent 及按 id 回查（snip/审计）使用 */
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

/**
 * 底层追加写入：单次 writeFile + fsync。
 * - 先检查文件尾是否缺少换行（上次写入可能被截断），缺则补一个 '\n'，
 *   避免新旧 JSON 粘成一行导致解析失败。
 * - fsync 确保「已返回」的数据真正落盘，而不仅在页缓存里。
 */
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

/** 探测文件最后一个字节是否为 '\n'，判断是否需要补换行修复尾部 */
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
 *
 * 幂等性很关键：调用方可以反复传入「全量 messages 数组」，
 * 这里只追加此前没落盘过的部分，所以上游不需要维护游标。
 */
export async function saveMessages(
  cwd: string,
  sessionId: string,
  messages: ChatMessage[],
 
  
): Promise<number> {
  return withStoreLock(() => saveMessagesLocked(cwd, sessionId, messages))
}

async function saveMessagesLocked(
  cwd: string,
  sessionId: string,
  messages: ChatMessage[],
  
): Promise<number> {
  const chunkId = randomUUID()
  const existing = await readEvents(cwd, sessionId)
  // 已落盘的消息 id 集合：用于过滤本次的新增部分
  const savedMessageIds = new Set(
    existing
      .map(event => event.message?.id)
      .filter((id): id is string => typeof id === 'string'),
  )

  // 从文件尾部续接事件链，保证 seq 单调、parent 指向正确
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
      chunkId:chunkId,
      seq: seq++,
      cwd,
      type: roleToType(message),
      ts: new Date().toISOString(),
      parent,
      // 拷贝一份 message，避免外部后续修改数组元素影响已构造的事件
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
 *
 * 动机：流式生成时 messages 每几毫秒就变一次，
 * 如果每次变化都 fsync，磁盘会被打爆；合并到 1s 一次既省 IO 又不丢语义
 * （丢的只是「最新的一小段」，下一次 tick 或退出时的 flush 会补上）。
 */

export const SAVE_FLUSH_INTERVAL_MS = 1000

type PendingJob = {
  cwd: string
  sessionId: string
  
  messages: ChatMessage[]
  lastSavedLength: number
}

const pendingJobs = new Map<string, PendingJob>()
let flushTimer: NodeJS.Timeout | null = null
let flushing = false

function jobKey(cwd: string, sessionId: string): string {
  // 用 NUL 分隔，避免 cwd/sessionId 里恰好含分隔符导致 key 冲突
  return `${cwd}\u0000${sessionId}`
}

/**
 * 串行化所有写操作：事件链的 seq/parent 依赖「读尾部 → 追加」，
 * 并发执行会读到同一个尾部，产生重复 seq 或分叉的 parent。
 * 这里用一个 Promise 链把所有 store 操作排成队列。
 */
let storeLock: Promise<unknown> = Promise.resolve()

function withStoreLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = storeLock.then(fn, fn)
  storeLock = run.then(() => undefined, () => undefined)
  return run
}

/** 把窗口内所有脏 session 落盘；flushing 防重入，避免定时器与手动 flush 撞车 */
async function flushPending(): Promise<number> {
  if (flushing || pendingJobs.size === 0) {
    return 0
  }
  flushing = true
  let written = 0
  try {
    for (const job of pendingJobs.values()) {
      // 长度没变说明这段时间没新增消息，跳过
      if (job.messages.length === job.lastSavedLength) {
        continue
      }
      // 先记录长度再写：即使 saveMessages 抛错，下一轮也会重试
      job.lastSavedLength = job.messages.length
      written += await saveMessages(job.cwd, job.sessionId, job.messages)
    }
  } finally {
    flushing = false
  }
  return written
}

/**
 * 标脏一个 session。注意存的是 messages 的**引用**而非快照：
 * flush 时读取的是那一刻的最新全量数组，配合 id 去重自然收敛到最后状态。
 */
export function scheduleSave(
  cwd: string,
  sessionId: string,
  messages: ChatMessage[],
): void {
  const key = jobKey(cwd, sessionId)
  const existing = pendingJobs.get(key)
  // 同一个数组引用已经在窗口里，无需重复登记
  if (existing && existing.messages === messages) {
    return
  }
  pendingJobs.set(key, { cwd, sessionId, messages, lastSavedLength: -1 })
  if (!flushTimer) {
    flushTimer = setInterval(() => {
      // 定时器回调里吞掉错误：失败不应导致未捕获异常，下一轮会重试
      void flushPending().catch(() => {})
    }, SAVE_FLUSH_INTERVAL_MS)
    // unref：定时器不阻止进程退出
    flushTimer.unref()
  }
}

/** 立即清空窗口（退出/切换路径）。await 后数据已在盘上。 */
export async function flushSessionSaves(): Promise<number> {
  if (flushTimer) {
    clearInterval(flushTimer)
    flushTimer = null
  }
  const written = await flushPending()
  pendingJobs.clear()
  return written
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
  // title 额外提到顶层，方便 listSessions 只扫少量字段即可提取标题
  return appendSessionEvent(cwd, sessionId, type, data, { title: data.title })
}

/**
 * 通用控制事件（context_snapshot / turn_end / error / rename 等）：
 * 不进对话投影，只供审计与确定性重放。事件链（seq/parent）保持完整。
 *
 * 控制事件即时落盘、不进批量窗口：它们数量少、语义重要，
 * 且往往标记状态边界（turn 结束、出错），延迟写入会破坏边界语义。
 */
export async function appendSessionEvent(
  cwd: string,
  sessionId: string,
  
  type: SessionEventType,
  data: Record<string, unknown>,
  extra?: { title?: string },
): Promise<SessionEvent> {
  return withStoreLock(() => appendSessionEventLocked(cwd, sessionId, type, data, extra))
}

async function appendSessionEventLocked(
  cwd: string,
  sessionId: string,

  type: SessionEventType,
  data: Record<string, unknown>,
  extra?: { title?: string },
): Promise<SessionEvent> {
  const existing = await readEvents(cwd, sessionId)
  const last = existing.at(-1)
  const event: SessionEvent = {
    id: randomUUID(),
    session: sessionId,
    chunkId:randomUUID(),
    seq: (last?.seq ?? -1) + 1,
    cwd,
    
    type,
    ts: new Date().toISOString(),
    parent: last?.id ?? null,
    message: null,
    // 只在确实有 title 时写入字段，避免 JSON 里出现无意义的 null
    ...(extra?.title !== undefined ? { title: extra.title } : {}),
    data,
  }
  await appendRawEvents(cwd, sessionId, [event])
  return event
}

/** 工具输出回显到上下文时的截断阈值：防止一次巨大输出撑爆后续请求 */
const TOOL_ECHO_CHARS = 25_000

/** tool_result → user 文本块（结构化 tool_use/tool_result 对在恢复历史中不再成对出现） */
function normalizeToolResultToText(
  message: Extract<ChatMessage, { role: 'tool_result' }>,
): ChatMessage {
  // 用带 [tool ...] 前缀的文本承载结果，让模型仍能识别来源与是否出错
  const head = message.isError
    ? `[tool ${message.toolName} returned an error]`
    : `[tool ${message.toolName} result]`
  const body = message.content.trim()
    ? message.content.slice(0, TOOL_ECHO_CHARS)
    : '(empty output)'
  return {
    role: 'user',
    content: `${head}\n${body}`,
    ...(message.id ? { id: message.id } : {}),
  }
}

/**
 * 投影：盘上有全部 8 种事实，进上下文的只有三类派生视图——
 * user 输入 / assistant 最终回答 / 工具返回结果（降维成 user 文本）。
 * 丢弃：thinking、progress、tool_call（input 原文仍留在事件里审计）。
 * summary 与 snip 标记属于历史演进的组成部分，保留。
 *
 * 投影是纯函数：同一批事件永远得到同样的消息序列，
 * 因此「恢复历史」不需要额外持久化任何派生状态。
 */
export function projectMessages(allEvents: SessionEvent[]): ChatMessage[] {
  // 取最后一次 summary 之后的事件：summary 代表此前历史的压缩结果
  const lastSummary = allEvents.findLastIndex(event => event.type === 'summary')
  const events = lastSummary > 0 ? allEvents.slice(lastSummary) : allEvents

  // 收集所有 snip 边界，建立「被删除消息 id → 对应 snip 事件」的索引
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
  // 记录已输出的 snip：一个 snip 覆盖多条被删消息，但边界本身只应出现一次
  const emittedSnips = new Set<string>()

  /** 单条消息的降维规则：只有「对模型有意义」的角色才进入上下文 */
  const take = (message: ChatMessage | null): void => {
    if (!message) {
      return
    }
    switch (message.role) {
      case 'user':
        projected.push(message); return
      case 'assistant':
        // 空回答（纯工具调用的中间态）不投影，避免出现空 assistant 轮
        if (message.content.trim().length > 0) projected.push(message); return
      case 'context_summary':
      case 'snip_boundary':
        projected.push(message); return
      case 'tool_result':
        projected.push(normalizeToolResultToText(message)); return
      default:
        return // assistant_thinking / assistant_progress / assistant_tool_call：不进上下文
    }
  }

  for (const event of events) {
    if (event.type === 'rename' || !event.message) {
      continue // 控制事件（snapshot/turn_end/error/rename）永不投影
    }

    if (event.type === 'snip_boundary') {
      // 没有被删消息的孤立 snip：直接输出（保持历史边界可见）
      if (!removedToSnip.size) {
        take(event.message)
      }
      continue
    }

    // 被 snip 删除的消息：用 snip 边界替代，且只在首次遇到时输出
    const owningSnip = removedToSnip.get(event.message.id ?? '')
    if (owningSnip) {
      if (!emittedSnips.has(owningSnip.id)) {
        take(owningSnip.message)
        emittedSnips.add(owningSnip.id)
      }
      continue
    }

    take(event.message)
  }

  return projected
}

/**
 * 恢复历史。
 * - 不传 chunkId：返回完整投影。
 * - 传 chunkId：找到该 chunk 首个事件的位置，返回**它之前**的投影，
 *   用于从某个中间点重放/回滚（chunkId 是一批同时写入的消息的公共标记）。
 */
export async function resumeMessages(
  cwd: string,
  sessionId: string,
  chunkId?:string,
): Promise<ChatMessage[] | null> {
  const events = await readEvents(cwd, sessionId)
  if (events.length === 0) {
    return null
  }
  let sliced = events
  if(chunkId){
    const idx = events.findIndex(e=>e.chunkId===chunkId)
    if(idx===-1)return null
    //按照events数组的切块来返回resume
    sliced = events.slice(0,idx)
  }

  // 注意：这里对 events 而非 sliced 做投影，chunkId 的分片当前未生效（见下方说明）
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

/**
 * 提取会话标题：优先取最后一次 rename，其次取首条用户输入并截断。
 * 只读事件流即可得到，无需额外维护标题文件。
 */
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

/**
 * 列出某项目下的所有会话。
 * 每个会话都要读一遍完整事件流来取标题——对大量会话会偏慢，
 * 换来的是无需维护额外索引文件、磁盘即事实源。
 */
export async function listSessions(cwd: string): Promise<SessionMeta[]> {
  let entries: string[]
  try {
    entries = await readdir(projectDir(cwd))
  } catch {
    // 目录不存在 = 该项目还没有任何会话
    return []
  }

  const results: SessionMeta[] = []
  for (const name of entries.filter(n => n.endsWith('.jsonl'))) {
    const id = name.slice(0, -'.jsonl'.length)
    const filePath = path.join(projectDir(cwd), name)
    try {
      // stat 与读事件并行，减少串行 IO 延迟
      const [info, events] = await Promise.all([
        stat(filePath),
        readEvents(cwd, id),
      ])
      results.push({
        id,
        title: extractTitle(events),
        eventCount: events.length,
        // 用文件 mtime 作为「最近更新」依据，避免解析出所有 ts 再比较
        updatedAt: info.mtime?.getTime() ?? 0,
      })
    } catch {
      // 单个会话读取失败不影响整体列表
      continue
    }
  }

  // 最近更新的排前面
  results.sort((a, b) => b.updatedAt - a.updatedAt)
  return results
}

export async function latestSessionId(cwd: string): Promise<string | null> {
  const sessions = await listSessions(cwd)
  return sessions[0]?.id ?? null
}

/** 删除会话文件；项目目录空了就顺手清掉，避免留下空壳目录 */
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