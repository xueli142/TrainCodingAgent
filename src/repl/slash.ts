import { MODEL } from '../config.js'
import { maybeCompactContext } from '../compact.js'
import { disconnectMcpServer, getMcpStatus, reconnectMcpServer } from '../mcp.js'
import { getPermissionsPath } from '../permissionManager.js'
import { buildToolCatalogMessage } from '../tools/index.js'
import {
  appendControlEvent,
  appendSessionEvent,
  flushSessionSaves,
  listSessions,
  newSessionId,
  previewMessages,
  projectMessages,
  readEvents,
  resolveSessionId,
  resumeMessages,
  saveMessages,
  sessionFilePath,
} from '../session.js'
import { computeContextStats, formatTokens, getModelContextWindow } from '../utils/token-estimator.js'
import type { ReplContext } from './context.js'
import { captureContextSnapshot } from './turn.js'
import { statusLine } from './status.js'

export const SLASH_COMMANDS = ['/exit', '/clear', '/sessions', '/rename', '/resume', '/compact', '/mcp', '/delete', '/model', '/init', '/help']

export function slashCompleter(line: string): [string[], string] {
  if (!line.startsWith('/')) return [[], line]
  const head = line.split(/\s/)[0] ?? line
  const hits = SLASH_COMMANDS.filter(c => c.startsWith(head))
  return [hits.map(h => `${h} `), head]
}

export type SlashResult = 'exit' | 'continue' | 'passthrough'

/** 斜杠命令分发。'passthrough' = 不是已实现命令，按普通输入交给模型（与旧行为一致） */
export async function handleSlash(ctx: ReplContext, input: string): Promise<SlashResult> {
  if (input === '/exit') return 'exit'
  if (input === '/clear') {
    await handleClear(ctx)
    return 'continue'
  }
  if (input === '/sessions') {
    await listSessionsToConsole(ctx)
    return 'continue'
  }
  if (input === '/mcp' || input.startsWith('/mcp ')) {
    await handleMcp(ctx, input.slice(4).trim())
    return 'continue'
  }
  if (input === '/rename' || input.startsWith('/rename ')) {
    await handleRename(ctx, input.slice('/rename'.length).trim())
    return 'continue'
  }
  if (input === '/resume' || input.startsWith('/resume ')) {
    await handleResume(ctx, input.slice('/resume'.length).trim())
    return 'continue'
  }
  if (input === '/compact') {
    await handleCompact(ctx)
    return 'continue'
  }
  //删除会话（TODO：接 clearSession + 二次确认删除，对象应是「非当前会话」或先 /clear）
  if (input === '/delete') {
    console.log('（占位）/delete 尚未实现')
    return 'continue'
  }
  //切换模型（TODO：写 model 字段 + 重建 system 提示 + 重新 hydrate 窗口）
  if (input === '/model') {
    console.log('（占位）/model 尚未实现')
    return 'continue'
  }
  if (input === '/status') {
    printStatus(ctx)
    return 'continue'
  }
  if (input === '/help') {
    console.log([
      '/exit              退出（空闲时 Ctrl+C / Ctrl+D 亦可；回合中 Ctrl+C 只取消回合）',
      '/clear             清空上下文并开新会话（旧会话保留在盘上）',
      '/sessions          列出本项目历史会话（当前带 *）',
      '/mcp               MCP 服务器连接状态与工具数',
      '/rename <标题>     重命名当前会话',
      '/resume [id|序号]  切换会话（支持 id 前缀模糊）',
      '/compact           手动压缩上下文（micro 优先，必要时 summary）',
      '/delete /model /init  占位，尚未实现',
      'Ctrl+C             回合中=取消当前回合；空闲=退出',
      'Ctrl+G             会话选择器    Ctrl+L 状态行重绘    Tab slash 补全',
    ].join('\n'))
    return 'continue'
  }
  //初始化项目指令（TODO：生成 AGENTS.md 风格说明文件，见 TODO.md B1）
  if (input === '/init') {
    console.log('（占位）/init 尚未实现')
    return 'continue'
  }
  return 'passthrough'
}

async function handleClear(ctx: ReplContext): Promise<void> {
  await flushSessionSaves()                          // 旧会话的待写全部落盘（此刻还是旧引用、旧 sessionId）
  await saveMessages(ctx.cwd, ctx.sessionId, ctx.messages)       // 双保险：全量写旧文件
  const oldId = ctx.sessionId
  ctx.sessionId = newSessionId()
  ctx.messages = [                            // 重绑新数组（纪律 2：换会话场景，非压缩）
    { role: 'system', content: await ctx.systemContent() },
    buildToolCatalogMessage(),
  ]
  console.log(`已清空上下文，新会话 ${ctx.sessionId}；旧会话 ${oldId} 仍在盘上，/resume ${oldId} 可找回`)
}

async function listSessionsToConsole(ctx: ReplContext): Promise<void> {
  const sessions = await listSessions(ctx.cwd)
  if (sessions.length === 0) {
    console.log('No saved sessions.')
    return
  }
  sessions.forEach((s, i) => {
    const mark = s.id === ctx.sessionId ? '*' : ' '
    console.log(`${mark}${i + 1}. ${s.id}  ${new Date(s.updatedAt).toLocaleString()}  ${s.eventCount}e  ${s.title ?? ''}`)
  })
  console.log(`permissions: ${getPermissionsPath()}`)
}

async function handleMcp(ctx: ReplContext, rest: string): Promise<void> {
  const parts = rest.split(/\s+/)
  const sub = parts[0]
  if (sub === 'connect' && parts[1]) {
    const status = await reconnectMcpServer(parts[1])
    console.log(`/mcp connect ${parts[1]} → ${status.status}${status.error ? `: ${status.error}` : ''}`)
    return
  }
  if (sub === 'disconnect' && parts[1]) {
    await disconnectMcpServer(parts[1])
    console.log(`/mcp disconnect ${parts[1]}：已断开并摘除工具（重连用 /mcp connect ${parts[1]}）`)
    return
  }
  const statuses = getMcpStatus()
  if (statuses.length === 0) {
    console.log('未配置任何 MCP 服务器（~/.ICEFOX-code/mcp.json 或 .icefox/mcp.json）')
    return
  }
  for (const s of statuses) {
    const mark = s.status === 'connected' ? '\u001b[32m●\u001b[0m' : s.status === 'disabled' ? '\u001b[90m○\u001b[0m' : '\u001b[31m✗\u001b[0m'
    console.log(`${mark} ${s.name}  ${s.status}${s.status === 'connected' ? ` (${s.toolCount} tools)` : ''}${s.error ? `  ${s.error}` : ''}`)
  }
  console.log('用法: /mcp connect <name> | /mcp disconnect <name>')
}

async function handleRename(ctx: ReplContext, title: string): Promise<void> {
  if (!title) {
    console.log('用法: /rename <标题>')
    return
  }
  await appendControlEvent(ctx.cwd, ctx.sessionId, 'rename', { title })   // 控制事件即时落盘，不进批量窗口
  console.log(`当前会话已命名：${title}`)
}

async function handleResume(ctx: ReplContext, arg: string): Promise<void> {
  const sessions = await listSessions(ctx.cwd)
  if (!arg) {
    console.log('\nsessions:')
    sessions.forEach((s, i) => console.log(`  ${i + 1}. ${s.id}  ${s.eventCount}e  ${s.title ?? ''}`))
    console.log('用法: /resume <id|序号>')
    return
  }
  const target = resolveSessionId(sessions, arg)
  if (!target) {
    console.log(`session not found: ${arg}（支持序号/完整id/唯一前缀）`)
    return
  }
  if (target === ctx.sessionId) {
    console.log(`already in session ${ctx.sessionId}`)
    return
  }

  const oldEvents = await readEvents(ctx.cwd, ctx.sessionId)
  const oldProjection = projectMessages(oldEvents)
  console.log(`\n切换前会话 ${ctx.sessionId}（投影后 ${oldProjection.length} 条，模型当前可见）:`)
  for (const line of previewMessages(oldProjection, 6)) {
    console.log(`  ${line}`)
  }

  await saveMessages(ctx.cwd, ctx.sessionId, ctx.messages)
  await flushSessionSaves()
  await appendSessionEvent(ctx.cwd, ctx.sessionId, 'session_switch', { to: target, at: Date.now() })

  const loaded = await resumeMessages(ctx.cwd, target)
  if (!loaded) {
    console.log(`session ${target} empty after switch`)
    return
  }
  //重绑新数组（纪律 2：换会话场景）；旧数组引用此刻已 flush 完毕
  ctx.messages = [{ role: 'system', content: await ctx.systemContent() }, buildToolCatalogMessage(), ...loaded]
  ctx.sessionId = target
  await captureContextSnapshot(ctx)

  console.log(`已切换到会话 ${target}（${loaded.length} 条消息进入上下文）:`)
  for (const line of previewMessages(loaded, 6)) {
    console.log(`  ${line}`)
  }
  console.log(`store: ${sessionFilePath(ctx.cwd, target)}`)
}

async function handleCompact(ctx: ReplContext): Promise<void> {
  const outcome = await maybeCompactContext({ model: ctx.model, messages: ctx.messages, force: true })
  if (outcome.compacted) {
    ctx.messages.splice(0, ctx.messages.length, ...outcome.messages)  // 原地 splice（压缩场景，纪律 2）
    await saveMessages(ctx.cwd, ctx.sessionId, ctx.messages)
    await appendSessionEvent(ctx.cwd, ctx.sessionId, 'turn_end', {
      kind: 'compact',
      removedCount: outcome.removedCount,
      tokensBefore: outcome.tokensBefore,
      tokensAfter: outcome.tokensAfter,
    })
    console.log(`/compact: ${outcome.removedCount} 条 → summary（${outcome.tokensBefore} → ${outcome.tokensAfter} tok）`)
  } else if (outcome.removedCount > 0) {
    console.log(`/compact(micro): 清理 ${outcome.removedCount} 条旧 tool_result 为 [cleared]`)
  } else {
    console.log('/compact: 无可压缩内容（中段太短或已经够小）')
  }
}

function printStatus(ctx: ReplContext): void {
  console.log(statusLine(ctx))
  const stats = computeContextStats(ctx.messages, MODEL)
  console.log(`  tokens ${formatTokens(stats.totalTokens)}/${formatTokens(stats.effectiveInput)} (source=${stats.source}, level=${stats.warningLevel})`)
  const contextWindow = getModelContextWindow(MODEL).contextWindow
  console.log(`  窗口占用 ${Math.round(stats.totalTokens / contextWindow * 100)}% of ${formatTokens(contextWindow)}（输入预算 ${formatTokens(stats.effectiveInput)}，压缩阈值 85%）`)
  console.log(`  messages=${ctx.messages.length}  session=${ctx.sessionId}`)
  for (const s of getMcpStatus()) console.log(`  mcp ${s.name}: ${s.status} (${s.toolCount}${s.error ? ` ${s.error}` : ''})`)
}
