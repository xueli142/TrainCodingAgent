import { z } from 'zod'
import type { ToolDefinition } from '../../tool.js'
import { jsonSchemaOf } from './schema-io.js'

const DEFAULT_TIMEOUT_SECONDS = 60
const MAX_CONTENT_CHARS = 100_000

const schema = z.object({
  url: z.string().describe('The URL to fetch content from'),
  format: z
    .enum(['text', 'markdown', 'html'])
    .optional()
    .describe('The format to return the content in (text, markdown, or html). Defaults to markdown.'),
  timeout: z
    .number()
    .int()
    .positive()
    .max(120)
    .optional()
    .describe('Optional timeout in seconds (max 120)'),
})

export type WebFetchInput = z.infer<typeof schema>

function htmlToText(html: string): string {
  let text = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(br|hr)\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|section|article|header|footer|li|tr|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, '')

  text = text
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")

  return text
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export const WebFetchTool: ToolDefinition<WebFetchInput> = {
  name: 'webfetch',
  description: [
    '- Fetches content from a specified URL',
    '- Takes a URL and optional format as input',
    '- Fetches the URL content, converts HTML to readable text (markdown/text formats), returns raw HTML for the html format',
    '- Use this tool when you need to retrieve and analyze web content',
    '',
    'Usage notes:',
    '  - IMPORTANT: if another tool offers better web fetching capabilities, prefer that tool instead.',
    '  - The URL must be a fully-formed valid URL. HTTP URLs will be automatically upgraded to HTTPS.',
    '  - Results may be truncated if the content is very large.',
  ].join('\n'),
  inputSchema: jsonSchemaOf(schema),
  schema,
  async run(input) {
    if (!/^https?:\/\//i.test(input.url)) {
      return {
        ok: false,
        output: `Invalid URL: ${input.url}. The URL must start with http:// or https://. Do not guess URLs; only fetch URLs the user provided or that you found in local files.`,
      }
    }

    const url = input.url.replace(/^http:\/\//i, 'https://')
    const timeoutMs = (input.timeout ?? DEFAULT_TIMEOUT_SECONDS) * 1000

    let response: Response
    try {
      response = await fetch(url, {
        signal: AbortSignal.timeout(timeoutMs),
        redirect: 'follow',
        headers: {
          'user-agent': 'icefox-agent/1.0',
          accept: 'text/html,application/xhtml+xml,text/plain,application/json,*/*',
        },
      })
    } catch (error) {
      return {
        ok: false,
        output: `Fetch failed for ${url}: ${error instanceof Error ? error.message : String(error)}`,
      }
    }

    if (!response.ok) {
      return {
        ok: false,
        output: `GET ${url} failed: HTTP ${response.status} ${response.statusText}`,
      }
    }

    const contentType = response.headers.get('content-type') ?? ''
    if (/image\/|application\/pdf|application\/octet-stream/i.test(contentType)) {
      return {
        ok: false,
        output: `Unsupported content type for webfetch: ${contentType}`,
      }
    }

    const body = await response.text()

    let output: string
    if (input.format === 'html' || !/text\/html|application\/xml/i.test(contentType)) {
      output = body
    } else {
      output = htmlToText(body)
    }

    const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(body)
    const title = titleMatch?.[1]?.replace(/<[^>]+>/g, '').trim()

    const truncated = output.length > MAX_CONTENT_CHARS
    const clipped = truncated ? output.slice(0, MAX_CONTENT_CHARS) : output

    const header = [
      `URL: ${url}`,
      title ? `Title: ${title}` : undefined,
      `ContentType: ${contentType || 'unknown'}`,
      truncated
        ? `...content truncated at ${MAX_CONTENT_CHARS} chars (total ${output.length} chars)`
        : undefined,
    ]
      .filter(Boolean)
      .join('\n')

    return {
      ok: true,
      output: `${header}\n\n${clipped}`,
    }
  },
}
