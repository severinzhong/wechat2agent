import { appendFile, mkdir, stat, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { LogEntry, LogTransport } from '@wechatbot/wechatbot'

/** gateway 统一日志文件：<storageDir>/gateway.log */
export class GatewayLog {
  readonly file: string

  constructor(storageDir: string) {
    this.file = path.join(storageDir, 'gateway.log')
  }

  /** 启动时调用：超过 2MB 则滚动为 gateway.log.1（只保留一代，Phase 1 简化） */
  async rotate(): Promise<void> {
    const st = await stat(this.file).catch(() => undefined)
    if (st && st.size > 2 * 1024 * 1024) {
      await rename(this.file, this.file + '.1').catch(() => {})
      await writeFile(this.file, '', 'utf8')
    }
    await mkdir(path.dirname(this.file), { recursive: true })
  }

  /** 写一行日志（同时输出到 stderr） */
  say(level: string, message: string): void {
    const line = `[${new Date().toISOString()}] [${level.toUpperCase()}] ${message}`
    process.stderr.write(line + '\n')
    appendFile(this.file, line + '\n').catch(() => {})
  }
}

/** SDK logger 的 transport：stderr + 文件双写 */
export class TeeTransport implements LogTransport {
  constructor(private readonly log: GatewayLog) {}

  write(entry: LogEntry): void {
    const data = entry.data ? ' ' + JSON.stringify(entry.data) : ''
    const ctx = entry.context ? ` [${entry.context}]` : ''
    this.log.say(entry.level, `${ctx} ${entry.message}${data}`.trim())
  }
}
