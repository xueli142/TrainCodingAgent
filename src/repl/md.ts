/**
 * Markdown 终端渲染（B3 配套）：模型爱吐 **加粗**、`code`、# 标题、[链接](url)，
 * 裸标记在终端里既难看又干扰阅读。本模块把它们转成 ANSI 样式或剥掉标记。
 *
 * 只动屏幕显示——messages/session/trace 存的仍是原始 markdown（UI 只订阅回调，不回改数据）。
 * 规则分层：
 *  - 行级：围栏代码块内原样保护、井号标题加粗、--- 转分隔线、尖括号引用置灰
 *  - 行内：行内代码青色、粗体/斜体/删除线转 ANSI、链接拆成"文本(url)"
 *  - Palette 恒等（非 TTY/NO_COLOR）时样式没有，但标记照样剥掉——管道里拿到干净文本
 *  - 表格/任务列表等结构保持原样：窄终端上二维排版本来也展不开
 */
import type { Palette } from './ui-kit.js'

const FENCE_RE = /^\s*(```|~~~)/
const HEADING_RE = /^\s{0,3}#{1,6}\s+\S/
const HR_RE = /^\s{0,3}(?:[-*_]\s*){3,}$/
const QUOTE_RE = /^\s{0,3}>\s?/

function inlineMarkdown(line: string, p: Palette): string {
  const codeSpans: string[] = []
  // 1) 保护行内代码（避免其中的 * _ [ 被误伤）
  let s = line.replace(/`([^`\n]+)`/g, (_m, body: string) => {
    codeSpans.push(body)
    return `\u0000${codeSpans.length - 1}\u0001`
  })
  // 2) 链接与图片：[文本](url) → 文本(url)；![alt](url) → alt(url)
  s = s.replace(/!?\[([^\]]*)\]\(([^)\s]+)\)/g, (_m, text: string, url: string) =>
    text ? `${text}(${url})` : url,
  )
  // 3) 删除线、粗体（** 与 __ 两种写法）、斜体（* 与带词边界的 _）
  s = s.replace(/~~([^~\n]+)~~/g, (_m, body: string) => p.dim(body))
  s = s.replace(/\*\*([^*\n]+)\*\*/g, (_m, body: string) => p.bold(body))
  s = s.replace(/__([^_\n]+)__/g, (_m, body: string) => p.bold(body))
  s = s.replace(/(^|[^*\\])\*([^*\n]+)\*/g, (_m, pre: string, body: string) => pre + p.italic(body))
  s = s.replace(/(^|[\s(（【「])_([^_\n]+)_(?=[\s),.。;；!！?？]|$)/g, (_m, pre: string, body: string) =>
    pre + p.italic(body),
  )
  // 4) 还原行内代码
  s = s.replace(/\u0000(\d+)\u0001/g, (_m, idx: string) => p.cyan(codeSpans[Number(idx)]))
  return s
}

export function renderTerminalMarkdown(text: string, p: Palette): string {
  const lines = text.split('\n')
  const out: string[] = []
  let fenceMarker = ''

  for (const line of lines) {
    const fence = FENCE_RE.exec(line)
    if (fence) {
      if (!fenceMarker) {
        fenceMarker = fence[1]
      } else if (line.trim().startsWith(fenceMarker)) {
        fenceMarker = ''
      }
      out.push(p.dim(line))
      continue
    }
    if (fenceMarker) {
      out.push(line) // 围栏内原样
      continue
    }
    if (HR_RE.test(line)) {
      out.push(p.dim('─'.repeat(48)))
      continue
    }
    if (HEADING_RE.test(line)) {
      out.push(p.bold(inlineMarkdown(line.replace(/^\s{0,3}#+\s+/, ''), p)))
      continue
    }
    if (QUOTE_RE.test(line)) {
      out.push(p.dim(`│ ${inlineMarkdown(line.replace(QUOTE_RE, ''), p)}`))
      continue
    }
    out.push(inlineMarkdown(line, p))
  }
  return out.join('\n')
}
