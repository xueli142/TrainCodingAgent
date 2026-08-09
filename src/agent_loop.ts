import { execFile } from 'node:child_process';

import {  getTool, getToolSchemas } from './tools/index.js'
import { buildSystemPrompt } from './prompt.js'
import { ToolContent ,ToolResult,ToolRegistry} from './tool.js'

import { PermissionManager } from './permissionManager.js'
import { ChatMessage ,ModelAdapter,ProviderThinkingBlock,} from './type.js'
import { replaceLargeToolResult,PendingToolResult,applyToolResultBudget } from './utils/tool-result.js';
import { any, boolean, endsWith } from 'zod';
import { isEnoentError } from './utils/errors.js';

const cwd = process.cwd()
let sawToolResultThisTurn = false

function isEmptyAssistantResponse(content: string): boolean {
  return content.trim().length === 0
}
//对话是否终止的判断函数，具体判断依照大模型
function shouldTreatAssistantAsProgress(args: {
  kind?: 'final' | 'progress'
  content: string
  sawToolResultThisTurn: boolean
}): boolean {
  if (args.kind === 'progress') {
    return true
  }

  if (args.kind === 'final') {
    return false
  }

  if (!args.sawToolResultThisTurn) {
    return false
  }

  return false
}

type AnthropicContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
//TODO 未完善的tool执行工具
async function executeTool(name: string, rawInput: unknown,context:ToolContent): Promise<ToolResult> {
  console.log('=== Tool Call ===')
  console.log('Name:', name)
  console.log('Raw Input:', JSON.stringify(rawInput, null, 2))

  const tool = getTool(name)
  if (!tool) {
    return {
      ok:false,
      output:`Error: Tool "${name}" not found`
    }
  }

  const parse = tool.schema.safeParse(rawInput)
  if (!parse.success) {
    return {
      ok:false,
      output:`Error: ${parse.error.message}`
    }
  }

  try {
    return await tool.run(parse.data,context)
  } catch (error) {
    return {
      ok: false,
      output: error instanceof Error ? error.message : String(error),
    }
  }
}

const messages: Array<{ role: string; content: unknown }> = []
/*
参数：
model: ModelAdapter
  tools: ToolRegistry
  messages: ChatMessage[]
  cwd: string
  permissions?: PermissionManager
*/ 
export async function agentloop(args:{
  
  model:ModelAdapter
  messages: ChatMessage[]
  cwd: string
  permissions?: PermissionManager
  maxSteps?:number
  onAssistantMessage?: (content: string, metadata?: { final?: boolean }) => void
  onProgressMessage?: (content: string) => void
  
}
): Promise<ChatMessage[]> {
  let messages = args.messages
  const maxSteps = args.maxSteps
  
  const pushContinuationPrompt=(content:string)=>{
    messages=[
      ...messages,
      {
        role: 'user',
        content
      }
    ]
  }
const appendThinkingBlocks = (blocks: ProviderThinkingBlock[] | undefined) => {
    if (!blocks || blocks.length === 0) return
    messages = [
      ...messages,
      {
        role: 'assistant_thinking',
        blocks,
      },
    ]
  }
//原本是不限制次数的，这个限制最大请求次数
  for(let step=0 ; maxSteps==null||maxSteps>step;step++) {
//TODO 函数未完善：上下文压缩，确保上下文不超过字数
   
/**if(setp==0){}
 * 
 */


    const response = await args.model.next(messages)
    





    
//TODO 函数未完善：检查模型返回内容应该继续或结束 
// 完善了检查progress状态的函数
//TODO 缺少判空函数
    if(response.type == 'assistant'){
      const isEmpty = isEmptyAssistantResponse(response.content)
      if(!isEmpty&&shouldTreatAssistantAsProgress({kind: response.kind,
          content: response.content,
          sawToolResultThisTurn,})
        ){
          args.onProgressMessage?.(response.content)
          //添加思考过程
          appendThinkingBlocks(response.thinkingBlocks)
          messages=[
            ...messages,
            {role:'assistant_progress',content:response.content}
          ]
          pushContinuationPrompt(
            sawToolResultThisTurn && response.kind !== 'progress'
            ?""
            :""
          )
          continue
        }

        const assistantMessages:ChatMessage={
          role: 'assistant',
          content : response.content
        }
        appendThinkingBlocks(response.thinkingBlocks)
        if (!isEmpty) {
        args.onAssistantMessage?.(response.content, { final: true })
      }

        return [assistantMessages]


    }

    

    
    if ((response.calls?.length ?? 0) === 0 && response.content && response.contentKind !== 'progress') {
      return messages
    }
    //这是一个数组，包含已有的工具执行的结果
    const executedToolResults: Array<{
      call: (typeof response.calls)[number]
//TODO 接受函数类型不完善,注册器没写，暂时先这样
     result: Awaited<ReturnType<ToolRegistry['execute']>>
      toolResult: PendingToolResult
    }> = []
    for (const call of response.calls){
      const result = await executeTool(call.toolName , call.input,{cwd:args.cwd,permissions:args.permissions})

      const toolResult = await replaceLargeToolResult({
        role: 'tool_result',
        toolUseId: call.id,
        toolName: call.toolName,
        content: result.output,
        isError: !result.ok,
      }, undefined  )
      //TODO contentReplacementState将过大的tool输出转化为文件txt形式，返回文件路径
       executedToolResults.push ({
        call,
        result,
        toolResult

      })
    }


//TODO 预算评估函数，评估新加进去的文本会不会导致上下文超过上线
 //const budgetedResults  
//TODO 建立索引
//const ToolResultById 


//TODO 处理信息返回结果，没有就使用toolResult 

const toolCallMessages = executedToolResults.map((entry,i)=>{
  const toolCallMessages: ChatMessage={
    role:'assistant_tool_call',
    toolUseId:entry.call.id,
    toolName:entry.call.toolName,
    input:entry.call.input,
    
  }
  return toolCallMessages
})

const toolResults = executedToolResults.map(entry=>entry.toolResult)
messages = [
      ...messages,
      ...toolCallMessages,
      ...toolResults, 
    ]
sawToolResultThisTurn = true
  }

  const maxStepContent = `达到最大工具步数限制，已停止当前回合。`
  
  return [
    ...messages,
    {
      role: 'assistant',
      content: maxStepContent,
    },
  ]
}

