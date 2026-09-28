import { pick as pickFromList } from './picker.js'
import { discardQueuedInput, readLine } from './tty-prompt.js'
import { setQuestionHandler } from './tools/tool/index.js'

/** question 工具的 TTY 接线：单选走 picker 模态，多选/无选项走行输入（防抢答先清排队行） */
export function installQuestionHandler(): void {
  setQuestionHandler(async (questions) => {
    const answers: string[] = []
    for (const q of questions) {
      if (q.options.length > 0 && !q.multiple) {
        // 单选走 picker 模态；"自定义文本"是最后一项，选中后回落到行输入
        const index = await pickFromList({
          title: `[${q.header}] ${q.question}`,
          options: [
            ...q.options.map(o => ({ label: o.label, hint: o.description })),
            { key: 't', label: '自定义文本…' },
          ],
          footer: '↑/↓ select · Enter confirm · Esc cancel',
        })
        if (index === null) throw new Error('No interactive console available') // question.ts 捕获 → ok:false 引导模型改纯文本提问
        if (index < q.options.length) {
          answers.push(q.options[index].label)
          continue
        }
        const free = (await readLine('your answer> '))?.trim()
        answers.push(free || '(no answer)')
        continue
      }
      // 多选/无选项：保留行输入路径
      const dropped = discardQueuedInput()
      if (dropped > 0) {
        console.log(`[question] 已丢弃排队的 ${dropped} 行输入（防止抢答），需要请重新输入`)
      }
      console.log(`\n? [${q.header}] ${q.question}`)
      q.options.forEach((o, i) =>
        console.log(`  ${i + 1}. ${o.label}${o.description ? ` — ${o.description}` : ''}`))
      const tip = q.multiple ? '输入编号(逗号分隔)或自述，回车确认: ' : '输入编号或自述: '
      const line = await readLine(tip)
      if (line === null) throw new Error('No interactive console available')
      const raw = line.trim()
      if (!q.multiple) {
        // 单选：仅当整行是合法编号才映射成选项，否则整行原样作为自由文本（避免带空格的回答被切碎）
        const n = Number(raw)
        answers.push(Number.isInteger(n) && n >= 1 && n <= q.options.length ? q.options[n - 1].label : raw)
        continue
      }
      const picked = raw.split(/[,，、\s]+/).map(s => {
        const n = Number(s)
        return Number.isInteger(n) && n >= 1 && n <= q.options.length ? q.options[n - 1].label : s
      }).filter(Boolean)
      answers.push(picked.join(', '))
    }
    return answers
  })
}
