import { z } from 'zod'
import type { ToolDefinition } from '../../tool.js'
import { jsonSchemaOf } from './schema-io.js'

const optionSchema = z.object({
  label: z.string().describe('Display text (1-5 words, concise)'),
  description: z.string().optional().describe('Explanation of choice'),
})

const questionSchema = z.object({
  question: z.string().describe('Complete question'),
  header: z.string().describe('Very short label (max 30 chars)'),
  options: z.array(optionSchema).describe('Available choices'),
  multiple: z.boolean().optional().describe('Allow selecting multiple choices'),
})

const schema = z.object({
  questions: z.array(questionSchema).describe('Questions to ask'),
})

export type QuestionRequest = z.infer<typeof questionSchema>
export type QuestionToolInput = z.infer<typeof schema>

export type QuestionHandler = (questions: QuestionRequest[]) => Promise<string[]>

let handler: QuestionHandler | undefined

export function setQuestionHandler(next: QuestionHandler | undefined): void {
  handler = next
}

export const QuestionTool: ToolDefinition<QuestionToolInput> = {
  name: 'question',
  description: [
    'Use this tool when you need to ask the user questions during execution. This allows you to:',
    '1. Gather user preferences or requirements',
    '2. Clarify ambiguous instructions',
    '3. Get decisions on implementation choices as you work',
    '4. Offer choices to the user about what direction to take.',
    '',
    'Usage notes:',
    '- Answers are returned per question. Set multiple: true to allow selecting more than one option.',
    '- Do not include catch-all options such as "Other".',
    '- If you recommend a specific option, make that the first option in the list and add "(Recommended)" at the end of the label.',
  ].join('\n'),
  inputSchema: jsonSchemaOf(schema),
  schema,
  async run(input) {
    if (!handler) {
      return {
        ok: false,
        output:
          'The question tool is not wired to an interactive UI yet. Register a handler with setQuestionHandler() in src/index.ts, or ask the question directly in plain text.',
      }
    }

    let answers: string[]
    try {
      answers = await handler(input.questions)
    } catch (error) {
      return {
        ok: false,
        output: `Question UI failed: ${error instanceof Error ? error.message : String(error)}`,
      }
    }

    const rendered = input.questions.map((question, index) => ({
      question: question.question,
      answer: answers[index] ?? '',
    }))

    return {
      ok: true,
      output: JSON.stringify(rendered, null, 2),
    }
  },
}
