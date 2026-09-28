import { appendFile } from 'node:fs/promises'
import { MODEL } from '../config.js'
import { agentloop } from '../agent_loop.js'
import { maybeCompactContext } from '../compact.js'
import { appendSessionEvent, saveMessages, scheduleSave } from '../session.js'
import { getToolSchemas } from '../tools/index.js'
import { statusLine } from './status.js'
import type { ReplContext } from './context.js'

/** 启动 / 切会话后固化一份完整上下文（system+catalog+tools 全量）进 session 与 trace */
export async function captureContextSnapshot(ctx: ReplContext): Promise<void> {
  await appendSessionEvent(ctx.cwd, ctx.sessionId, 'context_snapshot', {
    model: MODEL,
    project: ctx.projectRoot,
    system: ctx.messages[0]?.role === 'system' ? ctx.messages[0].content : '',
    catalog: ctx.messages[1]?.role === 'tool' ? ctx.messages[1].content : '',
    tools: getToolSchemas(),
  })
  await saveMessages(ctx.cwd, ctx.sessionId, ctx.messages)
}

/** 一个完整回合：登记 user → 双层压缩 → agentloop → 收据收尾。UI 只经回调输出 */
export async function runTurn(ctx: ReplContext, input: string): Promise<void> {
  ctx.messages.push({ role: 'user', content: input })
  scheduleSave(ctx.cwd, ctx.sessionId, ctx.messages)
  void appendFile(ctx.historyFile, JSON.stringify({ input }) + '\n').catch(() => {})

  const outcome = await maybeCompactContext({ model: ctx.model, messages: ctx.messages })
  if (outcome.compacted) {
    // 原地 splice：不换数组引用（纪律 2，压缩场景必须）
    ctx.messages.splice(0, ctx.messages.length, ...outcome.messages)
    await saveMessages(ctx.cwd, ctx.sessionId, ctx.messages)
    await appendSessionEvent(ctx.cwd, ctx.sessionId, 'turn_end', {
      kind: 'compact',
      removedCount: outcome.removedCount,
      tokensBefore: outcome.tokensBefore,
      tokensAfter: outcome.tokensAfter,
    })
    console.log(`[compact] ${outcome.removedCount} 条旧消息 → summary（${outcome.tokensBefore} → ${outcome.tokensAfter} tok）`)
  } else if (outcome.removedCount > 0) {
    console.log(`[microcompact] 清理 ${outcome.removedCount} 条旧 tool_result`)
  }

  ctx.permissions.beginTurn()
  ctx.activeTurn = new AbortController()
  try {
    const receipt = await agentloop({
      model: ctx.model,
      messages: ctx.messages,
      cwd: ctx.cwd,
      permissions: ctx.permissions,
      maxSteps: 30,
      toolResultState: ctx.toolResultState,
      signal: ctx.activeTurn.signal,

      onAssistantMessage: content => { console.log(`\n${content}\n`) },
      onProgressMessage: content => { console.log(`[progress] ${content}`) },
      onThinking: content => {
        const preview = content.length > 400 ? `${content.slice(0, 400)}…` : content
        const dim = preview.replace(/\n/g, '\n\u001b[2m')
        console.log(`\u001b[2m[thinking] ${dim}\u001b[0m`)
      },
      onTurnDiags: info => {
        void appendSessionEvent(ctx.cwd, ctx.sessionId, 'turn_end', { ...info }).catch(() => {})
        if (info.kind === 'tools') process.stdout.write(`${statusLine(ctx)}\n`)
      },
    })
    if (receipt.kind === 'aborted') {
      console.log('[aborted] 本回合已取消，可继续输入')
    }
    scheduleSave(ctx.cwd, ctx.sessionId, ctx.messages)
  } catch (error) {
    await appendSessionEvent(ctx.cwd, ctx.sessionId, 'error', {
      where: 'agentloop',
      message: error instanceof Error ? error.message : String(error),
    }).catch(() => {})
    console.log(`\n[error] ${error instanceof Error ? error.message : String(error)}\n`)
  } finally {
    ctx.activeTurn = null
    ctx.permissions.endTurn()
  }
}
