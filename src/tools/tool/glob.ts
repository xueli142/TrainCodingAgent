import { stat } from 'node:fs/promises'
import { z } from 'zod'
import type { ToolDefinition } from '../../tool.js'
import { resolveToolPath } from '../../workspace.js'
import { globToRegExp, toPosixRelative, walkFiles } from './fs-walk.js'
import { jsonSchemaOf } from './schema-io.js'

const RESULT_LIMIT = 100

const schema = z.object({
  pattern: z
    .string()
    .describe('The glob pattern to match files against, e.g. "**/*.ts" or "src/**/*.tsx"'),
  path: z
    .string()
    .optional()
    .describe(
      'The directory to search in. If not specified, the current working directory will be used. Must be a valid directory path if provided.',
    ),
})

export type GlobInput = z.infer<typeof schema>

export const GlobTool: ToolDefinition<GlobInput> = {
  name: 'glob',
  description: [
    '- Fast file pattern matching tool that works with any codebase size',
    '- Supports glob patterns like "**/*.js" or "src/**/*.ts"',
    '- Returns matching file paths sorted by modification time (newest first)',
    '- Use this tool when you need to find files by name patterns',
    '- You have the capability to call multiple tools in a single response. Batch multiple speculative searches in one message.',
  ].join('\n'),
  inputSchema: jsonSchemaOf(schema),
  schema,
  async run(input, context) {
    const root = input.path
      ? await resolveToolPath(context, input.path, 'search')
      : context.cwd

    const matcher = globToRegExp(input.pattern)
    const found: Array<{ relative: string; mtimeMs: number }> = []
    let overflow = false

    for await (const file of walkFiles(root)) {
      const relative = toPosixRelative(root, file)
      if (!matcher.test(relative)) {
        continue
      }

      let mtimeMs = 0
      try {
        mtimeMs = (await stat(file)).mtimeMs
      } catch {
        // best effort
      }

      found.push({ relative, mtimeMs })

      if (found.length >= RESULT_LIMIT + 1) {
        overflow = true
        break
      }
    }

    if (found.length === 0) {
      return {
        ok: true,
        output: `No files found matching pattern "${input.pattern}" in ${root}`,
      }
    }

    const limited = overflow ? found.slice(0, RESULT_LIMIT) : found
    limited.sort((a, b) => b.mtimeMs - a.mtimeMs)

    return {
      ok: true,
      output: [
        `Found ${limited.length}${overflow ? `+` : ''} file(s) matching pattern "${input.pattern}" in ${root} (newest first):`,
        ...limited.map(entry => entry.relative),
      ].join('\n'),
    }
  },
}
