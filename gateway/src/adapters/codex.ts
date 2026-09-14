import { spawn } from 'node:child_process'
import readline from 'node:readline'
import { randomUUID } from 'node:crypto'
import { parseCodexLine, initialCodexState } from './codex-parse.js'
import type { BackendAdapter, RunningTask, StartTaskInput, TaskEvent, TaskResult } from './types.js'

export interface CodexAdapterOptions {
  bin?: string
  sandbox?: 'read-only' | 'workspace-write' | 'danger-full-access'
}

export class CodexAdapter implements BackendAdapter {
  readonly name = 'codex'
  private readonly bin: string
  private readonly sandbox: string

  constructor(options: CodexAdapterOptions = {}) {
    this.bin = options.bin ?? process.env.CODEX_BIN ?? 'codex'
    this.sandbox = options.sandbox ?? 'workspace-write'
  }

  async listModels(): Promise<string[]> {
    return ['gpt-5.2', 'gpt-5.2-codex']
  }

  defaultModel(): string {
    return 'gpt-5.2'
  }

  async startTask(input: StartTaskInput): Promise<RunningTask> {
    // resume 子命令不接受 -s/--sandbox（会话沿用创建时的配置），仅支持 --json/-m 等
    const args = input.nativeSessionId
      ? [
          'exec', 'resume', input.nativeSessionId, '--json',
          ...(input.model ? ['-m', input.model] : []),
          input.prompt,
        ]
      : [
          'exec', '--json', '-s', this.sandbox,
          '-C', input.workspace, '--skip-git-repo-check',
          ...(input.model ? ['-m', input.model] : []),
          input.prompt,
        ]

    const child = spawn(this.bin, args, { stdio: ['ignore', 'pipe', 'pipe'] })

    const queue: TaskEvent[] = []
    let notify: (() => void) | undefined
    let produced = false
    const push = (e: TaskEvent) => { queue.push(e); notify?.() }
    const close = () => { produced = true; notify?.() }

    let state = initialCodexState()
    const rl = readline.createInterface({ input: child.stdout! })
    rl.on('line', (line) => {
      const r = parseCodexLine(line, state)
      state = r.state
      for (const e of r.events) push(e)
    })

    let stderr = ''
    child.stderr!.on('data', (d: Buffer) => { stderr += d.toString() })

    const done = new Promise<TaskResult>((resolve) => {
      child.on('close', (code) => {
        close()
        resolve({
          ok: code === 0 && state.sawTurnCompleted,
          finalText: state.finalText,
          nativeSessionId: state.threadId ?? input.nativeSessionId,
          error: code === 0 ? undefined : (stderr.trim() || `codex exited with code ${code}`),
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
