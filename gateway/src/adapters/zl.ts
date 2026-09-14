import { spawn, type ChildProcess } from 'node:child_process'
import readline from 'node:readline'
import { randomUUID } from 'node:crypto'
import { parseZlLine, initialZlState } from './zl-parse.js'
import type { BackendAdapter, RunningTask, StartTaskInput, TaskEvent, TaskResult } from './types.js'

/** 管理单 workspace 的 zl serve 实例（server 与工作目录绑定，见 docs/research.md 5.3）。 */
export class ZlServerManager {
  private server?: ChildProcess
  private url?: string

  constructor(
    private readonly workspace: string,
    private readonly bin: string = process.env.ZL_BIN ?? 'zl',
  ) {}

  async ensureServer(): Promise<string> {
    if (this.url) return this.url
    const child = spawn(this.bin, ['serve', '--port', '0', '--hostname', '127.0.0.1'], {
      cwd: this.workspace,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    this.server = child
    this.url = await new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('zl serve start timeout')), 15_000)
      child.stdout!.on('data', (d: Buffer) => {
        const m = /listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(d.toString())
        if (m) {
          clearTimeout(timeout)
          resolve(m[1]!)
        }
      })
      child.on('exit', (code) => {
        clearTimeout(timeout)
        reject(new Error(`zl serve exited early: ${code}`))
      })
    })
    return this.url
  }

  async stop(): Promise<void> {
    this.server?.kill('SIGTERM')
    this.server = undefined
    this.url = undefined
  }
}

export class ZlAdapter implements BackendAdapter {
  readonly name = 'zl'

  constructor(
    private readonly serverManager: ZlServerManager,
    private readonly bin: string = process.env.ZL_BIN ?? 'zl',
  ) {}

  async listModels(): Promise<string[]> {
    return ['zhanlu/qwen3.7-max', 'zhanlu/glm-5.2']
  }

  defaultModel(): string {
    return 'zhanlu/qwen3.7-max'
  }

  async startTask(input: StartTaskInput): Promise<RunningTask> {
    const serverUrl = await this.serverManager.ensureServer()
    const args = [
      'run', '--attach', serverUrl, '--format', 'json', '--dir', input.workspace,
      ...(input.nativeSessionId ? ['--session', input.nativeSessionId] : []),
      ...(input.model ? ['-m', input.model] : []),
      input.prompt,
    ]
    const child = spawn(this.bin, args, { stdio: ['ignore', 'pipe', 'pipe'] })

    const queue: TaskEvent[] = []
    let notify: (() => void) | undefined
    let produced = false
    const push = (e: TaskEvent) => { queue.push(e); notify?.() }
    const close = () => { produced = true; notify?.() }

    let state = initialZlState()
    const rl = readline.createInterface({ input: child.stdout! })
    rl.on('line', (line) => {
      const r = parseZlLine(line, state)
      state = r.state
      for (const e of r.events) push(e)
    })

    let stderr = ''
    child.stderr!.on('data', (d: Buffer) => { stderr += d.toString() })

    const done = new Promise<TaskResult>((resolve) => {
      child.on('close', (code) => {
        close()
        resolve({
          ok: code === 0 && state.sawStepFinish,
          finalText: state.text,
          nativeSessionId: state.sessionId ?? input.nativeSessionId,
          error: code === 0 ? undefined : (stderr.trim() || `zl exited with code ${code}`),
        })
      })
    })

    return {
      id: randomUUID(),
      events: (async function* () {
        for (;;) {
          while (queue.length) yield queue.shift()!
          if (produced && queue.length === 0) return
          await new Promise<void>((r) => { notify = r })
        }
      })(),
      done,
      cancel: async () => { child.kill('SIGTERM') },
    }
  }
}
