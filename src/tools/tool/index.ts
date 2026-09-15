import type { ToolDefinition } from '../../tool.js'
import { BashTool } from './bash.js'
import { EditTool } from './edit.js'
import { GlobTool } from './glob.js'
import { GrepTool } from './grep.js'
import { QuestionTool } from './question.js'
import { ReadTool } from './read.js'
import { SkillTool } from './skill.js'
import { TaskTool } from './task.js'
import { TodoWriteTool } from './todowrite.js'
import { WebFetchTool } from './webfetch.js'
import { WriteTool } from './write.js'

export { setQuestionHandler } from './question.js'
export type { QuestionHandler, QuestionRequest } from './question.js'
export { setTaskExecutor } from './task.js'
export type { TaskExecutor } from './task.js'
export { discoverSkills, formatSkillsForPrompt } from './skill.js'
export type { SkillSummary } from './skill.js'
export { getTodos, clearTodos } from './todowrite.js'
export type { TodoItem } from './todowrite.js'

export const standardTools: ToolDefinition<any>[] = [
  BashTool,
  EditTool,
  GlobTool,
  GrepTool,
  QuestionTool,
  ReadTool,
  SkillTool,
  TaskTool,
  TodoWriteTool,
  WebFetchTool,
  WriteTool,
]

export function getStandardToolSchemas(): Array<{
  name: string
  description: string
  input_schema: Record<string, unknown>
}> {
  return standardTools.map(tool => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema,
  }))
}
