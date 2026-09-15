import { readFile, writeFile } from 'node:fs/promises'
import { z } from 'zod'
import type { ToolDefinition } from '../../tool.js'
import { buildUnifiedDiff } from '../../file-review.js'
import { isEnoentError } from '../../utils/errors.js'
import { resolveToolPath } from '../../workspace.js'
import { rememberRead, validatePriorRead } from './read-state.js'
import { jsonSchemaOf } from './schema-io.js'

const DIFF_PREVIEW_CHARS = 4000

const schema = z.object({
  filePath: z.string().describe('The absolute path to the file to modify'),
  oldString: z.string().describe('The text to replace'),
  newString: z
    .string()
    .describe('The text to replace it with (must be different from oldString)'),
  replaceAll: z
    .boolean()
    .optional()
    .describe('Replace all occurrences of oldString (default false)'),
})

export type EditInput = z.infer<typeof schema>

export const EditTool: ToolDefinition<EditInput> = {
  name: 'edit',
  description: [
    'Performs exact string replacements in files.',
    '',
    'Usage:',
    '- You must use the read tool at least once in the conversation before editing. This tool will error if you attempt an edit without reading the file.',
    '- When editing text from read tool output, preserve the exact indentation after the line number prefix. Never include any part of the line number prefix in oldString or newString.',
    '- ALWAYS prefer editing existing files in the codebase. NEVER write new files unless explicitly required.',
    '- The edit will FAIL if oldString is not found in the file.',
    '- The edit will FAIL if oldString is found multiple times, unless replaceAll is true. Provide more surrounding context to make it unique, or set replaceAll to change every instance.',
  ].join('\n'),
  inputSchema: jsonSchemaOf(schema),
  schema,
  async run(input, context) {
    const target = await resolveToolPath(context, input.filePath, 'write')
    const problem = await validatePriorRead(target)
    if (problem) {
      return { ok: false, output: problem }
    }

    if (input.oldString === input.newString) {
      return {
        ok: false,
        output: 'oldString and newString must be different.',
      }
    }

    let previous
    try {
      previous = await readFile(target, 'utf8')
    } catch (error) {
      if (isEnoentError(error)) {
        return {
          ok: false,
          output: `File "${input.filePath}" does not exist. Use write to create it first.`,
        }
      }
      throw error
    }

    const occurrences = previous.split(input.oldString).length - 1
    if (occurrences === 0) {
      return {
        ok: false,
        output: 'oldString not found in content. Re-read the file and copy the exact text (including indentation) from the read output.',
      }
    }
    if (occurrences > 1 && !input.replaceAll) {
      return {
        ok: false,
        output: `Found ${occurrences} matches for oldString. Provide more surrounding lines in oldString to identify the correct match, or set replaceAll to true.`,
      }
    }

    const next = input.replaceAll
      ? previous.split(input.oldString).join(input.newString)
      : (() => {
          const index = previous.indexOf(input.oldString)
          return (
            previous.slice(0, index) +
            input.newString +
            previous.slice(index + input.oldString.length)
          )
        })()

    const diff = buildUnifiedDiff(input.filePath, previous, next)
    await context.permissions?.ensureEdit(target, diff)

    await writeFile(target, next, 'utf8')
    await rememberRead(target)

    const clipped =
      diff.length > DIFF_PREVIEW_CHARS
        ? `${diff.slice(0, DIFF_PREVIEW_CHARS)}\n... (diff truncated)`
        : diff

    return {
      ok: true,
      output: `Applied edit to ${input.filePath}\nDiff:\n${clipped}`,
    }
  },
}
