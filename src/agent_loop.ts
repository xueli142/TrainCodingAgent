import {  getTool } from './tools/index.js'
import { ToolContent, ToolResult } from './tool.js'
import { ChatMessage, ModelAdapter, ProviderThinkingBlock, ProviderUsage } from './type.js'
import { PermissionManager } from './permissionManager.js'
import { replaceLargeToolResult, applyToolResultBudget, PendingToolResult, ContentReplacementState } from './utils/tool-result.js'

export type TurnDiagInfo = {
  step: number
  kind: 'final' | 'empty' | 'tools' | 'max_steps'
  calls?: number
  usage?: ProviderUsage
  stopReason?: string
}

const LOOP_GUARD_AFTER_REPEATS = 3

function isEmptyAssistantResponse(content: string): boolean {
  return content.trim().length === 0
}

//TODO 未完善的tool执行工具
async function executeTool(name: string, rawInput: unknown, context: ToolContent): Promise<ToolResult> {
 
  console.log('Name:', name)
  console.log('Raw Input:', JSON.stringify(rawInput, null, 2))

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
 * 合约（修复版）：
 *  - 所有新消息【就地 push 进 args.messages】（共享数组）——回合中途调度器/压缩能看到真实进度
 *  - 返回值 = 仅本回合新增（增量），caller 不得再 push 回同一数组
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
  toolResultState?: ContentReplacementState
  onAssistantMessage?: (content: string, metadata?: { final?: boolean }) => void
  onProgressMessage?: (content: string) => void
  onTurnDiags?: (info: TurnDiagInfo) => void  
}): Promise<ChatMessage[]> {
  const messages = args.messages
  const maxSteps = args.maxSteps ?? 30
  const added: ChatMessage[] = []
  const callCounts = new Map<string, number>()
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

  const appendThinkingBlocks = (blocks: ProviderThinkingBlock[] | undefined): void => {
    if (!blocks || blocks.length === 0) return
    append({ role: 'assistant_thinking', blocks })
  }

  for (let step = 0; maxSteps > step; step++) {
    const response = await args.model.next(messages)

    if (response.type === 'assistant') {
      const isEmpty = isEmptyAssistantResponse(response.content)
      const isProgress = response.kind === 'progress'

      appendThinkingBlocks(response.thinkingBlocks)
//progress 中间态：只作提示展示，不视为回合的最终回复
      if (!isEmpty && isProgress) {
        args.onProgressMessage?.(response.content)
        append({ role: 'assistant_progress', content: response.content })
        continue
      }

      if (!isEmpty) {
        args.onAssistantMessage?.(response.content, { final: true })
      }
      const assistantMessage: ChatMessage = {
        role: 'assistant',
        content: response.content,
        ...(response.usage ? { usage: response.usage } : {}),
      }
      if (!isEmpty) {
        append(assistantMessage)
      }
      args.onTurnDiags?.({
        step,
        kind: 'final',
        usage: response.usage,
        ...(response.diagnostics?.stopReason ? { stopReason: response.diagnostics.stopReason } : {}),
      })
      return added
    }

    if ((response.calls?.length ?? 0) === 0) {
      if (response.content && response.contentKind !== 'progress') {
        appendThinkingBlocks(response.thinkingBlocks)
        append({ role: 'assistant_progress', content: response.content })
        args.onProgressMessage?.(response.content)
        args.onTurnDiags?.({
          step,
          kind: 'empty',
          usage: response.usage,
          ...(response.diagnostics?.stopReason ? { stopReason: response.diagnostics.stopReason } : {}),
        })
        continue
      }
      args.onTurnDiags?.({ step, kind: 'empty', usage: response.usage })
      return added
    }

    appendThinkingBlocks(response.thinkingBlocks)
    append(...response.calls.map(call => ({
      role: 'assistant_tool_call' as const,
      toolUseId: call.id,
      toolName: call.toolName,
      input: call.input,
    })))

    const toolResults: PendingToolResult[] = []
    for (const call of response.calls) {
      const key = `${call.toolName}\u0000${JSON.stringify(call.input ?? {})}`
      const count = (callCounts.get(key) ?? 0) + 1
      callCounts.set(key, count)

      const result = await executeTool(call.toolName, call.input, {
        cwd: args.cwd,
        permissions: args.permissions,
      })

      let output = result.output
      if (count === LOOP_GUARD_AFTER_REPEATS) {
        output = `${output}\n\n[loop-guard] 这是第 ${count} 次完全相同的 ${call.toolName} 调用。重复执行不会改变结果——换方法（不同工具/不同参数/读取已有结果文件），或直接基于此前结果给出回答。`
      }

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
  }

  args.onTurnDiags?.({ step: maxSteps, kind: 'max_steps' })
  const maxStepsNotice = `达到最大工具步数限制（${maxSteps}），已停止当前回合。`
  args.onAssistantMessage?.(maxStepsNotice, { final: true })
  append({ role: 'assistant', content: maxStepsNotice })
  return added
}
