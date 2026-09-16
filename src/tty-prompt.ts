import fs from 'node:fs'

/**
 * 直接打开控制台输入（Windows: CONIN$ / POSIX: /dev/tty），
 * 独立 fd 阻塞读一行——不与主 readline 的 stdin 流冲突。
 * 拿不到控制台（纯管道/无终端）返回 null。
 */
export function readLineFromConsole(prompt?: string): string | null {
  const source = process.platform === 'win32' ? '\\\\.\\CONIN$' : '/dev/tty'
  let fd: number | null = null
  try {
    fd = fs.openSync(source, 'r')
    if (prompt) {
      fs.writeSync(1, prompt)
    }
    const buf = Buffer.alloc(1)
    let line = ''
    for (;;) {
      let bytesRead = 0
      try {
        bytesRead = fs.readSync(fd, buf, 0, 1, null)
      } catch {
        break
      }
      if (bytesRead === 0) {
        break
      }
      const ch = buf.toString('utf8', 0, 1)
      if (ch === '\n') {
        break
      }
      if (ch === '\r') {
        continue
      }
      line += ch
      if (line.length > 2000) {
        break
      }
    }
    return line
  } catch {
    return null
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd)
      } catch {
        // ignore
      }
    }
  }
}

export function hasInteractiveConsole(): boolean {
  const source = process.platform === 'win32' ? '\\\\.\\CONIN$' : '/dev/tty'
  try {
    const fd = fs.openSync(source, 'r')
    fs.closeSync(fd)
    return true
  } catch {
    return false
  }
}
