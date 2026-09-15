import path from 'node:path'
import { readFile, stat } from 'node:fs/promises'
import { z } from 'zod'
import type { ToolDefinition } from '../../tool.js'
import { resolveToolPath } from '../../workspace.js'
import { globToRegExp, toPosixRelative, walkFiles } from './fs-walk.js'
import { jsonSchemaOf } from './schema-io.js'

const MAX_MATCHES = 200
const MAX_FILES_SCANNED = 6000
const MAX_FILE_SIZE_BYTES = 1024 * 1024
const MAX_LINE_CHARS = 300

const schema = z.object({
  pattern: z
    .string()
    .describe('The regex pattern to search for in file contents. Use (?i) style groups for case-insensitive matching.'),
  path: z
    .string()
    .optional()
    .describe('The directory to search in. Defaults to the current working directory.'),
  include: z
    .string()
    .optional()
    .describe('File pattern to include in the search (e.g. "*.ts", "*.{js,mjs}")'),
})

export type GrepInput = z.infer<typeof schema>

export const GrepTool: ToolDefinition<GrepInput> = {
  name: 'grep',
  description: [
    '- Fast content search tool that works with any codebase size',
    '- Searches file contents using regular expressions',
    "- Filter files by pattern with the include parameter (e.g. \"*.ts\")",
    '- Returns file paths and line numbers with matching lines, relative to the search directory',
    '- Use this tool when you need to find files containing specific patterns',
    '- Prefer full regex syntax, for example "log.*Error" or "function\\s+\\w+"',
  ].join('\n'),
  inputSchema: jsonSchemaOf(schema),
  schema,
  async run(input, context) {
    let regex: RegExp
    try {
      regex = new RegExp(input.pattern)
    } catch (error) {
      return {
        ok: false,
        output: `Invalid regex pattern: ${error instanceof Error ? error.message : String(error)}`,
      }
    }

    const root = input.path
      ? await resolveToolPath(context, input.path, 'search')
      : context.cwd

    const includeMatcher = input.include ? globToRegExp(input.include) : null
    const results: string[] = []
    let matches = 0
    let filesScanned = 0
    let truncated = false
    let filesHitLimit = false

    search: for await (const file of walkFiles(root, MAX_FILES_SCANNED + 1)) {
      filesScanned += 1
      if (filesScanned > MAX_FILES_SCANNED) {
        filesHitLimit = true
        break
      }

      const relative = toPosixRelative(root, file)
      if (
        includeMatcher &&
        !includeMatcher.test(relative) &&
        !includeMatcher.test(path.basename(file))
      ) {
        continue
      }

      let info
      try {
        info = await stat(file)
      } catch {
        continue
      }
      if (info.size > MAX_FILE_SIZE_BYTES) {
        continue
      }

      let buffer
      try {
        buffer = await readFile(file)
      } catch {
        continue
      }
      if (buffer.subarray(0, 4096).includes(0)) {
        continue
      }

      const lines = buffer.toString('utf8').split('\n')
      for (let i = 0; i < lines.length; i++) {
        if (!regex.test(lines[i])) {
          continue
        }

        const line = lines[i].replace(/\r$/, '')
        const clipped =
          line.length > MAX_LINE_CHARS
            ? `${line.slice(0, MAX_LINE_CHARS)}...`
            : line
        results.push(`${relative}:${i + 1}: ${clipped.trimEnd()}`)
        matches += 1

        if (matches >= MAX_MATCHES) {
          truncated = true
          break search
        }
      }
    }

    if (results.length === 0) {
      return {
        ok: true,
        output: filesHitLimit
          ? `No matches within the first ${MAX_FILES_SCANNED} files under ${root}. Narrow the pattern or include filter.`
          : `No matches found for pattern "${input.pattern}" in ${root}`,
      }
    }

    const notes: string[] = []
    if (truncated) {
      notes.push(`Results truncated at ${MAX_MATCHES} matches. Narrow the pattern or add an include filter.`)
    }
    if (filesHitLimit) {
      notes.push(`Search stopped after scanning ${MAX_FILES_SCANNED} files.`)
    }

    return {
      ok: true,
      output: [
        `${matches} match(es) in ${root}:`,
        ...results,
        ...notes.map(note => `NOTE: ${note}`),
      ].join('\n'),
    }
  },
}
