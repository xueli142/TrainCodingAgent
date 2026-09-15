import { z } from 'zod'
import type { ToolDefinition } from '../../tool.js'
import { jsonSchemaOf } from './schema-io.js'

const todoSchema = z.object({
  content: z.string().describe('Brief description of the task'),
  status: z
    .enum(['pending', 'in_progress', 'completed', 'cancelled'])
    .describe('Current status of the task: pending, in_progress, completed, cancelled'),
  priority: z
    .enum(['high', 'medium', 'low'])
    .optional()
    .describe('Priority level of the task: high, medium, low'),
})

const schema = z.object({
  todos: z.array(todoSchema).describe('The updated todo list (full replacement each call)'),
})

export type TodoItem = z.infer<typeof todoSchema>
export type TodoWriteInput = z.infer<typeof schema>

let currentTodos: TodoItem[] = []

export function getTodos(): TodoItem[] {
  return currentTodos
}

export function clearTodos(): void {
  currentTodos = []
}

const STATUS_GLYPH: Record<TodoItem['status'], string> = {
  pending: '[ ]',
  'in_progress': '[>]',
  completed: '[x]',
  cancelled: '[-]',
}

export const TodoWriteTool: ToolDefinition<TodoWriteInput> = {
  name: 'todowrite',
  description: [
    'Create and maintain a structured task list for the current session. Tracks progress, organizes multi-step work, and surfaces status to the user.',
    '',
    'When to use:',
    '- The task requires 3+ distinct steps, or the user provides multiple tasks or asks for a todo list',
    '- New instructions arrive: capture them as todos',
    '- Each call replaces the full list. Keep exactly one item in_progress while work remains.',
    '',
    'When NOT to use:',
    '- Single straightforward tasks, purely informational questions, or trivial work',
    '',
    'Rules:',
    '- Update status in real time. Mark items completed only after the work is actually done and verified, never based on intent.',
    '- Preserve user-provided commands verbatim (flags, args, order).',
    '- Items should be specific and actionable. Break large work into smaller steps.',
  ].join('\n'),
  inputSchema: jsonSchemaOf(schema),
  schema,
  async run(input) {
    const inProgress = input.todos.filter(todo => todo.status === 'in_progress').length
    if (inProgress > 1) {
      return {
        ok: false,
        output: `Invalid todo list: ${inProgress} items are in_progress. Keep exactly one in_progress at a time.`,
      }
    }

    currentTodos = input.todos.map(todo => ({ ...todo }))

    if (currentTodos.length === 0) {
      return { ok: true, output: 'Todo list cleared.' }
    }

    const lines = currentTodos.map((todo, index) => {
      const priority = todo.priority ? ` (${todo.priority})` : ''
      return `${index + 1}. ${STATUS_GLYPH[todo.status]}${priority} ${todo.content}`
    })

    const counts = {
      completed: currentTodos.filter(t => t.status === 'completed').length,
      inProgress: currentTodos.filter(t => t.status === 'in_progress').length,
      pending: currentTodos.filter(t => t.status === 'pending').length,
      cancelled: currentTodos.filter(t => t.status === 'cancelled').length,
    }

    return {
      ok: true,
      output: [
        ...lines,
        '',
        `Summary: ${counts.completed} completed, ${counts.inProgress} in progress, ${counts.pending} pending, ${counts.cancelled} cancelled (total ${currentTodos.length})`,
      ].join('\n'),
    }
  },
}
