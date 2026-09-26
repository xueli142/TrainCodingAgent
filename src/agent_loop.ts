import {  getTool } from './tools/index.js'
import { ToolContent, ToolResult } from './tool.js'
import { ChatMessage, ModelAdapter, ProviderThinkingBlock, ProviderUsage } from './type.js'
import { PermissionManager } from './permissionManager.js'
import { replaceLargeToolResult, applyToolResultBudget, PendingToolResult, ContentReplacementState } from './utils/tool-result.js'
//根据模型选择内容判断当前回答的状态
//TODO aborted — 用户取消 failed — 失败 retry — 重试
export type TurnDiagInfo = {
  step: number
  kind: 'final' | 'empty' | 'tools' | 'max_steps' | 'aborted'
  calls?: number
  usage?: ProviderUsage
  stopReason?: string
}

export type TurnReceipt = {
  addedCount: number
  kind: 'final' | 'empty' | 'max_steps' | 'aborted'
  usage?: ProviderUsage
  stopReason?: string
}

export const LOOP_GUARD_AFTER_REPEATS = 10

function isEmptyAssistantResponse(content: string): boolean {
  return content.trim().length === 0
}

async function executeTool(name: string, rawInput: unknown, context: ToolContent): Promise<ToolResult> {
  const tool = getTool(name)
  if (!tool) {
    return {
      ok: false,
      output: `Error: Tool "${name}" not found`,
    }
  }

  const parse = tool.schema.safeParse(rawInput)
  if (!parse.success) {
    return {
      ok: false,
      output: `Error: ${parse.error.message}`,
    }
  }

  try {
    return await tool.run(parse.data, context)
  } catch (error) {
    return {
      ok: false,
      output: error instanceof Error ? error.message : String(error),
    }
  }
}

/**
 * 
 * 
 * 合约（收据版）：
 *  - 所有新消息【就地 push 进 args.messages】（共享数组）——回合中途调度器/压缩能看到真实进度
 *  - 返回值 = TurnReceipt（新增条数 + 结束类型 + usage），不回传消息本身——caller 回推在类型层已不可能
 *  - 完全相同的 (tool,input) 调用达 LOOP_GUARD_AFTER_REPEATS 次 → 注入 loop-guard 提示
 * 
 *  args权威定义了参数
 */
export async function agentloop(args: {
  model: ModelAdapter
  messages: ChatMessage[]
  cwd: string
  permissions?: PermissionManager
  maxSteps?: number
//  mcpTools?:
  toolResultState?: ContentReplacementState
  signal?: AbortSignal
  onAssistantMessage?: (content: string, metadata?: { final?: boolean }) => void
  onProgressMessage?: (content: string) => void
  onThinking?: (content: string) => void
  onTurnDiags?: (info: TurnDiagInfo) => void
}): Promise<TurnReceipt> {
  const messages = args.messages
  const maxSteps = args.maxSteps ?? 30
  const added: ChatMessage[] = []
  const callCounts = new Map<string, number>()

  //回合唯一出口：发诊断 + 铸收据
  const endTurn = (
    step: number,
    kind: TurnReceipt['kind'],
    meta?: { usage?: ProviderUsage; stopReason?: string },
  ): TurnReceipt => {
    args.onTurnDiags?.({
      step,
      kind,
      ...(meta?.usage ? { usage: meta.usage } : {}),
      ...(meta?.stopReason ? { stopReason: meta.stopReason } : {}),
    })
    return {
      addedCount: added.length,
      kind,
      ...(meta?.usage ? { usage: meta.usage } : {}),
      ...(meta?.stopReason ? { stopReason: meta.stopReason } : {}),
    }
  }
  //append 这个函数使用都是添加上下文的操作
  const append = (...items: ChatMessage[]): void => {
    for (const item of items) {
      const content = (item as { content?: string }).content
      if (item.role === 'user' && (content === undefined || content.trim() === '')) {
        continue
      }
      messages.push(item)
      added.push(item)
    }
  }
//添加思考块
  const appendThinkingBlocks = (blocks: ProviderThinkingBlock[] | undefined): void => {
    if (!blocks || blocks.length === 0) return
    append({ role: 'assistant_thinking', blocks })
    for (const block of blocks) {
      const text = typeof block.thinking === 'string' ? block.thinking : ''
      if (text.trim()) args.onThinking?.(text)
    }
  }
//最大步数计数
  for (let step = 0; maxSteps > step; step++) {
    if (args.signal?.aborted) {
      return endTurn(step, 'aborted')
    }
    let response: Awaited<ReturnType<ModelAdapter['next']>>
    try {
      response = await args.model.next(messages, args.signal)
    } catch (error) {
      //fetch 被打断（Ctrl+C）：按用户取消收尾，不算错
      if (args.signal?.aborted) {
        return endTurn(step, 'aborted')
      }
      throw error
    }

    if (response.type === 'assistant') {
      const isEmpty = isEmptyAssistantResponse(response.content)
      const isProgress = response.kind === 'progress'

      appendThinkingBlocks(response.thinkingBlocks)
      //progress 中间态：只作提示展示，不视为回合的最终回复
      if (!isEmpty && isProgress) {
        args.onProgressMessage?.(response.content)
        append({
          role: 'assistant_progress',
          content: response.content,
          ...(response.usage ? { providerUsage: response.usage } : {}),
        })
        continue
      }

      if (!isEmpty) {
        args.onAssistantMessage?.(response.content, { final: true })
      }
      const assistantMessage: ChatMessage = {
        role: 'assistant',
        content: response.content,
        ...(response.usage ? { providerUsage: response.usage } : {}),
      }
      if (!isEmpty) {
        append(assistantMessage)
      }
      //最终输出
      return endTurn(step, 'final', {
        ...(response.usage ? { usage: response.usage } : {}),
        ...(response.diagnostics?.stopReason ? { stopReason: response.diagnostics.stopReason } : {}),
      })
    }

    if ((response.calls?.length ?? 0) === 0) {
      if (response.content && response.contentKind !== 'progress') {
        appendThinkingBlocks(response.thinkingBlocks)
        append({
          role: 'assistant_progress',
          content: response.content,
          ...(response.usage ? { providerUsage: response.usage } : {}),
        })
        args.onProgressMessage?.(response.content)
        args.onTurnDiags?.({
          step,
          kind: 'empty',
          usage: response.usage,
          ...(response.diagnostics?.stopReason ? { stopReason: response.diagnostics.stopReason } : {}),
        })
        continue
      }
      return endTurn(step, 'empty', response.usage ? { usage: response.usage } : undefined)
    }
    //思考块和工具shu
    appendThinkingBlocks(response.thinkingBlocks)
    append(...response.calls.map(call => ({
      role: 'assistant_tool_call' as const,
      toolUseId: call.id,
      toolName: call.toolName,
      input: call.input,
      ...(response.usage ? { providerUsage: response.usage } : {}),
    })))

    const toolResults: PendingToolResult[] = []
    for (const call of response.calls) {
      //取消落地：本 step 内未执行的调用也必须配对回 tool_result，否则 tool_use 孤儿会炸下一次请求
      if (args.signal?.aborted) {
        toolResults.push({
          role: 'tool_result',
          toolUseId: call.id,
          toolName: call.toolName,
          content: '(turn aborted by user before this call ran)',
          isError: true,
        })
        continue
      }
      const key = `${call.toolName}\u0000${JSON.stringify(call.input ?? {})}`
      const count = (callCounts.get(key) ?? 0) + 1
      callCounts.set(key, count)

      const result = await executeTool(call.toolName, call.input, {
        cwd: args.cwd,
        permissions: args.permissions,
        signal: args.signal,
      })

      let output = result.output
      if (count === LOOP_GUARD_AFTER_REPEATS) {
        output = `${output}\n\n[loop-guard] 这是第 ${count} 次完全相同的 ${call.toolName} 调用。重复执行不会改变结果——换方法（不同工具/不同参数/读取已有结果文件），或直接基于此前结果给出回答。`
      }
          //替换成chatmessage的输出格式
      toolResults.push(await replaceLargeToolResult({
        role: 'tool_result',
        toolUseId: call.id,
        toolName: call.toolName,
        content: output,
        isError: !result.ok || count >= LOOP_GUARD_AFTER_REPEATS,
        //toolResultState：按 toolUseId 记忆已发生的替换，跨请求字节级稳定复放 + 批量预算
      }, args.toolResultState))
    }
    const budgeted  = args.toolResultState
    ?await applyToolResultBudget(toolResults,args.toolResultState)
    :{results:toolResults}
    append(...budgeted.results)
    args.onTurnDiags?.({
      step,
      kind: 'tools',
      calls: response.calls.length,
      usage: response.usage,
      ...(response.diagnostics?.stopReason ? { stopReason: response.diagnostics.stopReason } : {}),
    })
    if (args.signal?.aborted) {
      return endTurn(step, 'aborted')
    }
  }
  //最大次数限制
  const maxStepsNotice = `达到最大工具步数限制（${maxSteps}），已停止当前回合。`
  args.onAssistantMessage?.(maxStepsNotice, { final: true })
  append({ role: 'assistant', content: maxStepsNotice })
  return endTurn(maxSteps, 'max_steps')
}
