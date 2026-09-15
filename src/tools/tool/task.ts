import { z } from 'zod'
import type { ToolContent, ToolDefinition } from '../../tool.js'
import { jsonSchemaOf } from './schema-io.js'

const schema = z.object({
  description: z
    .string()
    .describe('A short (3-5 words) description of the task'),
  prompt: z
    .string()
    .describe(
      'The task for the agent to perform. Include exactly what information the agent should return in its final message.',
    ),
  subagent_type: z
    .string()
    .describe('The type of specialized agent to use for this task'),
  task_id: z
    .string()
    .optional()
    .describe('Resume a previous subagent session instead of starting a fresh one'),
})

export type TaskInput = z.infer<typeof schema>

export type TaskExecutor = (
  task: { description: string; prompt: string; subagentType: string; taskId?: string },
  context: ToolContent,
) => Promise<string>

let executor: TaskExecutor | undefined

export function setTaskExecutor(next: TaskExecutor | undefined): void {
  executor = next
}

const NOT_WIRED_MESSAGE = [
  'The task tool is not wired to a subagent executor yet.',
  'Register one with setTaskExecutor() in src/index.ts.',
  'Suggested design: spawn a nested agentloop with a fresh messages array, a restricted child toolset,',
  'and return only the final text of the subagent (with a task identifier usable for resume).',
].join(' ')

export const TaskTool: ToolDefinition<TaskInput> = {
  name: 'task',
  description: [
    'Launch a new agent to handle complex, multistep tasks autonomously.',
    'When using the task tool, you must specify a subagent_type parameter to select which agent type to use.',
    '',
    'When NOT to use the task tool:',
    '- If you want to read a specific file path, use read or glob instead',
    '- If you are searching for a specific definition or keyword, use grep instead',
    '- If you are searching code within 2-3 specific files, use read instead',
    '',
    'Usage notes:',
    '1. Launch multiple agents concurrently whenever possible, in a single message with multiple tool uses.',
    '2. Once you delegate work to an agent, do not duplicate that work yourself.',
    '3. The agent returns a single message that is NOT visible to the user. Summarize it for the user yourself.',
    '4. Each invocation starts with a fresh context unless you pass task_id to resume the same session.',
    '5. Clearly tell the agent whether it should write code or only do research (search, file reads, web fetches).',
  ].join('\n'),
  inputSchema: jsonSchemaOf(schema),
  schema,
  async run(input, context) {
    if (!executor) {
      return { ok: false, output: NOT_WIRED_MESSAGE }
    }

    try {
      const output = await executor(
        {
          description: input.description,
          prompt: input.prompt,
          subagentType: input.subagent_type,
          taskId: input.task_id,
        },
        context,
      )
      return { ok: true, output }
    } catch (error) {
      return {
        ok: false,
        output: `Task failed: ${error instanceof Error ? error.message : String(error)}`,
      }
    }
  },
}
