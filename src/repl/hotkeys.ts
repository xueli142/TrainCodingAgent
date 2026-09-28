import { pick as pickFromList } from '../picker.js'
import { listSessions } from '../session.js'
import { deliverLine, onGlobalKey } from '../tty-prompt.js'
import { statusLine } from './status.js'
import type { ReplContext } from './context.js'

/** 空闲快捷键：Ctrl+G 会话选择器 / Ctrl+L 状态行重绘；回合进行中一律放行 */
export function registerIdleHotkeys(ctx: ReplContext): void {
  onGlobalKey((_str, key) => {
    if (ctx.activeTurn) return false
    if (key.ctrl && key.name === 'g') {
      void (async () => {
        const sessions = await listSessions(ctx.cwd)
        if (sessions.length === 0) {
          console.log('No saved sessions.')
          return
        }
        const index = await pickFromList({
          title: 'Resume session',
          options: sessions.map(s => ({ label: s.title ?? s.id, hint: `${s.id} · ${new Date(s.updatedAt).toLocaleString()}` })),
        })
        if (index !== null) deliverLine(`/resume ${sessions[index].id}`)
      })()
      return true
    }
    if (key.ctrl && key.name === 'l') {
      process.stdout.write(`${statusLine(ctx)}\n`)
      return true
    }
    return false
  })
}
