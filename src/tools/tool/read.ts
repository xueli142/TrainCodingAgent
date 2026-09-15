import { readdir, readFile, stat } from 'node:fs/promises'
import { z } from 'zod'
import type { ToolDefinition } from '../../tool.js'
import { resolveToolPath } from '../../workspace.js'
import { rememberRead } from './read-state.js'
import { jsonSchemaOf } from './schema-io.js'

const MAX_LINE_CHARS = 2000
const DEFAULT_LIMIT = 2000

const schema = z.object({
  filePath: z
    .string()
    .describe('The absolute path to the file or directory to read'),
  offset: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe('The line number to start reading from (1-indexed)'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(DEFAULT_LIMIT)
    .optional()
    .describe('The maximum number of lines to read (defaults to 2000)'),
})

export type ReadInput = z.infer<typeof schema>

export const ReadTool: ToolDefinition<ReadInput> = {
  name: 'read',
  description: [
    'Read a file or directory from the local filesystem. If the path does not exist, an error is returned.',
    '',
    'Usage:',
    '- The filePath parameter should be an absolute path.',
    '- By default, this tool returns up to 2000 lines from the start of the file.',
    '- The offset parameter is the line number to start from (1-indexed).',
    '- Contents are returned with each line prefixed by its line number as `<line>: <content>`.',
    '- For directories, entries are returned one per line with a trailing `/` for subdirectories.',
    '- Any line longer than 2000 characters is truncated.',
    '- Call this tool in parallel when you know there are multiple files you want to read.',
    '- Avoid tiny repeated slices. If you need more context, read a larger window.',
    '- A file must be read with this tool before it can be modified by edit or write.',
  ].join('\n'),
  inputSchema: jsonSchemaOf(schema),
  schema,
  async run(input, context) {
    let target
    try {
      target = await resolveToolPath(context, input.filePath, 'read')
    } catch (error) {
      return {
        ok: false,
        output: error instanceof Error ? error.message : String(error),
      }
    }

    const info = await stat(target)
    if (info.isDirectory()) {
      const entries = await readdir(target, { withFileTypes: true })
      const names = entries
        .map(entry => (entry.isDirectory() ? `${entry.name}/` : entry.name))
        .sort((a, b) => a.localeCompare(b))
      return {
        ok: true,
        output: `${target} (${names.length} entries):\n${names.join('\n')}`,
      }
    }

    const buffer = await readFile(target)
    if (buffer.subarray(0, 4096).includes(0)) {
      return {
        ok: false,
        output: `Binary file not supported: ${input.filePath}`,
      }
    }

    const text = buffer.toString('utf8')
    const lines = text.split('\n')
    const start = Math.max(1, input.offset ?? 1)
    const count = input.limit ?? DEFAULT_LIMIT
    const slice = lines.slice(start - 1, start - 1 + count)

    if (slice.length === 0) {
      return {
        ok: false,
        output: `Offset ${start} is beyond the end of file (${lines.length} total lines).`,
      }
    }

    const rendered = slice.map((line, index) => {
      const number = start + index
      const clipped =
        line.length > MAX_LINE_CHARS
          ? `${line.slice(0, MAX_LINE_CHARS)}... (line truncated)`
          : line
      return `${number}: ${clipped}`
    })

    const remaining = lines.length - (start - 1 + slice.length)
    if (remaining > 0) {
      rendered.push(
        `... (${remaining} more lines. Use offset=${start + slice.length} to continue)`,
      )
    }

    await rememberRead(target)

    return {
      ok: true,
      output: text.length === 0 ? '(empty file)' : rendered.join('\n'),
    }
  },
}
