import path from 'node:path'
import { readFile } from 'node:fs/promises'
import { z } from 'zod'
import type { ToolDefinition } from '../../tool.js'
import { ICEFOX_CODE_DIR } from '../../config.js'
import { walkFiles } from './fs-walk.js'
import { jsonSchemaOf } from './schema-io.js'

export type SkillSummary = {
  name: string
  description: string
  location: string
}

const schema = z.object({
  name: z.string().describe('The name of the skill from available_skills'),
})

export type SkillInput = z.infer<typeof schema>

function parseFrontmatter(text: string): {
  name?: string
  description?: string
  body: string
} {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)
  if (!match) {
    return { body: text }
  }

  const fields = new Map<string, string>()
  for (const line of match[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line)
    if (kv) {
      fields.set(kv[1].toLowerCase(), kv[2].trim().replace(/^["']|["']$/g, ''))
    }
  }

  return {  
    name: fields.get('name'),
    description: fields.get('description'),
    body: text.slice(match[0].length + 1),
  }
}

function skillRoots(cwd: string): string[] {
  return [path.join(cwd, '.icefox', 'skills'), path.join(ICEFOX_CODE_DIR, 'skills')]
}
//这个返回的只是skill摘要（name/description/location），供 system prompt 目录使用；完整 body 由 SkillTool 按需加载
export async function discoverSkills(cwd: string): Promise<SkillSummary[]> {
  const skills = new Map<string, SkillSummary>()

  for (const root of skillRoots(cwd)) {
    for await (const file of walkFiles(root, 500)) {
      if (path.basename(file).toLowerCase() !== 'skill.md') {
        continue
      }

      let text: string
      try {
        text = await readFile(file, 'utf8')
      } catch {
        continue
      }

      const meta = parseFrontmatter(text)
      const name = meta.name || path.basename(path.dirname(file))
      if (skills.has(name)) {
        continue
      }

      skills.set(name, {
        name,
        description: meta.description || '',
        location: file,
      })
    }
  }

  return [...skills.values()].sort((a, b) => a.name.localeCompare(b.name))
}
//把一批技能（skills）的摘要格式化成一段 XML 风格的文本，
// 嵌进给模型的 prompt 里，告诉模型有哪些技能可用、各自是干什么的、以及去哪加载
export function formatSkillsForPrompt(skills: SkillSummary[]): string | undefined {
  const described = skills.filter(skill => skill.description.length > 0)
  if (described.length === 0) {
    return undefined
  }

  return [
    'Skills provide specialized instructions and workflows for specific tasks.',
    'Use the skill tool to load a skill when a task matches its description.',
    '<available_skills>',
    ...described.flatMap(skill => [
      '  <skill>',
      `    <name>${skill.name}</name>`,
      `    <description>${skill.description}</description>`,
      `    <location>${skill.location}</location>`,
      '  </skill>',
    ]),
    '</available_skills>',
  ].join('\n')
}

export const SkillTool: ToolDefinition<SkillInput> = {
  name: 'skill',
  description: [
    'Load a specialized skill when the task at hand matches one of the skills listed in the system prompt.',
    '',
    'Use this tool to inject the skill instructions and resources into the conversation. The output may contain detailed workflow guidance as well as references to files in the same directory as the skill.',
    '',
    'The skill name must match one of the skills listed in your system prompt.',
  ].join('\n'),
  inputSchema: jsonSchemaOf(schema),
  schema,
  async run(input, context) {
    const skills = await discoverSkills(context.cwd)
    const wanted = input.name.trim().toLowerCase()
    const match = skills.find(skill => skill.name.toLowerCase() === wanted)

    if (!match) {
      const available = skills.map(skill => skill.name).join(', ')
      return {
        ok: false,
        output: `Skill "${input.name}" not found. Available skills: ${available || 'none'}`,
      }
    }

    const text = await readFile(match.location, 'utf8')
    const meta = parseFrontmatter(text)
    const baseDir = path.dirname(match.location)

    const sampleFiles: string[] = []
    for await (const file of walkFiles(baseDir, 10)) {
      if (path.basename(file).toLowerCase() === 'skill.md') {
        continue
      }
      sampleFiles.push(file)
    }

    return {
      ok: true,
      output: [
        `<skill_content name="${match.name}">`,
        `# Skill: ${match.name}`,
        '',
        //body在这里使用上，是只有使用具体的某个skill的时候，才会把body加上去
        meta.body.trim(),
        '',
        `Base directory for this skill: ${baseDir}`,
        'Relative paths in this skill are relative to this base directory.',
        sampleFiles.length > 0
          ? ['<skill_files>', ...sampleFiles.map(f => `<file>${f}</file>`), '</skill_files>'].join('\n')
          : '',
        '</skill_content>',
      ]
        .filter(Boolean)
        .join('\n'),
    }
  },
}
