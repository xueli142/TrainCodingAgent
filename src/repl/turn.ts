import { appendFile } from 'node:fs/promises'
import { MODEL } from '../config.js'
import { agentloop } from '../agent_loop.js'
import { maybeCompactContext } from '../compact.js'
import { appendSessionEvent, saveMessages, scheduleSave } from '../session.js'
import { getToolSchemas } from '../tools/index.js'
import { onExternalWrite, onModalChange } from '../tty-prompt.js'
import { statusLine } from './status.js'
import { createTurnRenderer, disposeActiveTurnRenderer } from './renderer.js'
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

/**
 * 一个完整回合：登记 user → 双层压缩 → agentloop → 收据收尾。
 * UI 只经回调输出（纪律 3），回合内 stdout 发言权归本回合渲染器一家：
 * 审批卡/question 等外部输出进来时，先广播 commitForModal 把活区落成历史再让对方画
 * （onModalChange/onExternalWrite 接线，非 TTY 下渲染器自动退化为纯追加，这些广播是无害空转）。
 */
export async function runTurn(ctx: ReplContext, input: string): Promise<void> {
  ctx.messages.push({ role: 'user', content: input })
  scheduleSave(ctx.cwd, ctx.sessionId, ctx.messages)
  void appendFile(ctx.historyFile, JSON.stringify({ input }) + '\n').catch(() => {})

  const ui = createTurnRenderer({ statusLine: () => statusLine(ctx) })
  const unsubscribes = [
    onModalChange(depth => {
      if (depth > 0) ui.commitForModal()
    }),
    onExternalWrite(() => ui.commitForModal()),
  ]
  const turnStartedAt = Date.now()
  let toolCalls = 0
  let outcomeKind = 'failed'
  try {
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
      ui.notice(`[compact] ${outcome.removedCount} 条旧消息 → summary（${outcome.tokensBefore} → ${outcome.tokensAfter} tok）`)
    } else if (outcome.removedCount > 0) {
      ui.notice('[microcompact] 清理旧 tool_result')
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

        onModelStart: () => ui.onModelStart(0),
        onThinking: content => ui.onThinking(content),
        onAssistantMessage: content => ui.onAssistant(content),
        onProgressMessage: content => ui.onProgress(content),
        onToolStart: info => {
          toolCalls++
          ui.onToolStart(info)
        },
        onToolResult: info => ui.onToolResult(info),
        onTurnDiags: info => {
          void appendSessionEvent(ctx.cwd, ctx.sessionId, 'turn_end', { ...info }).catch(() => {})
        },
      })
      outcomeKind = receipt.kind
      if (receipt.kind === 'aborted') {
        ui.notice('[aborted] 本回合已取消，可继续输入')
      }
      scheduleSave(ctx.cwd, ctx.sessionId, ctx.messages)
    } catch (error) {
      await appendSessionEvent(ctx.cwd, ctx.sessionId, 'error', {
        where: 'agentloop',
        message: error instanceof Error ? error.message : String(error),
      }).catch(() => {})
      ui.notice(`\n[error] ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      ctx.activeTurn = null
      ctx.permissions.endTurn()
    }
  } finally {
    ui.finish({ kind: outcomeKind, elapsedMs: Date.now() - turnStartedAt, toolCalls })
    for (const off of unsubscribes) off()
    disposeActiveTurnRenderer()
  }
}
