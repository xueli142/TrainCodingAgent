import { z } from 'zod'
import type { ToolDefinition } from '../../tool.js'
import { applyReviewedFileChange } from '../../file-review.js'
import { resolveToolPath } from '../../workspace.js'
import { rememberRead, validatePriorRead } from './read-state.js'
import { jsonSchemaOf } from './schema-io.js'

const schema = z.object({
  filePath: z
    .string()
    .describe('The absolute path to the file to write (must be absolute, not relative)'),
  content: z.string().describe('The content to write to the file'),
})

export type WriteInput = z.infer<typeof schema>

export const WriteTool: ToolDefinition<WriteInput> = {
  name: 'write',
  description: [
    'Writes a file to the local filesystem.',
    '',
    'Usage:',
    '- This tool will overwrite the existing file if there is one at the provided path.',
    "- If this is an existing file, you MUST use the read tool first to read the file's contents. This tool will fail if you did not read the file first.",
    '- ALWAYS prefer editing existing files in the codebase. NEVER write new files unless explicitly required.',
    '- NEVER proactively create documentation files (*.md) or README files. Only create documentation files if explicitly requested.',
  ].join('\n'),
  inputSchema: jsonSchemaOf(schema),
  schema,
  async run(input, context) {
    const target = await resolveToolPath(context, input.filePath, 'write')
    const problem = await validatePriorRead(target)
    if (problem) {
      return { ok: false, output: problem }
    }

    const result = await applyReviewedFileChange(
      context,
      input.filePath,
      target,
      input.content,
    )
    if (result.ok) {
      await rememberRead(target)
    }
    return result
  },
}
