import { spawn } from 'node:child_process'
import readline from 'node:readline'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { parseCodexLine, initialCodexState } from './codex-parse.js'
import type { BackendAdapter, RunningTask, StartTaskInput, TaskEvent, TaskResult } from './types.js'

export interface CodexAdapterOptions {
  bin?: string
  sandbox?: 'read-only' | 'workspace-write' | 'danger-full-access'
}

interface CodexModelCatalogEntry {
  slug: string
  display_name?: string
  default_reasoning_level?: string
  supported_reasoning_levels?: { effort?: string }[]
}

export class CodexAdapter implements BackendAdapter {
  readonly name = 'codex'
  private readonly bin: string
  private readonly sandbox: string
  private catalogCache?: CodexModelCatalogEntry[]
  private catalogFetchedAt?: string

  constructor(options: CodexAdapterOptions = {}) {
    this.bin = options.bin ?? process.env.CODEX_BIN ?? 'codex'
    this.sandbox = options.sandbox ?? 'workspace-write'
  }

  /** 读取 codex 模型 catalog（~/.codex/models_cache.json），结构变化时降级为空。 */
  private async loadCatalog(): Promise<CodexModelCatalogEntry[]> {
    if (this.catalogCache) return this.catalogCache
    try {
      const home = process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex')
      const raw = await readFile(path.join(home, 'models_cache.json'), 'utf8')
      const data = JSON.parse(raw) as { models?: CodexModelCatalogEntry[]; fetched_at?: string }
      this.catalogCache = Array.isArray(data.models) ? data.models : []
      this.catalogFetchedAt = data.fetched_at
    } catch {
      this.catalogCache = []
    }
    return this.catalogCache
  }

  /** 模型缓存的拉取时间（用于提示列表可能过期） */
  modelListNote(): string | undefined {
    return this.catalogFetchedAt
      ? `列表缓存于 ${this.catalogFetchedAt.slice(0, 10)}，可能过期；可用 /model <名称> 直写`
      : undefined
  }

  async listModels(): Promise<string[]> {
    const catalog = await this.loadCatalog()
    return catalog.map((m) => m.slug)
  }

  async listEfforts(model?: string): Promise<string[]> {
    const catalog = await this.loadCatalog()
    const entry = model ? catalog.find((m) => m.slug === model) : catalog[0]
    return (entry?.supported_reasoning_levels ?? [])
      .map((l) => l.effort)
      .filter((e): e is string => typeof e === 'string')
  }

  defaultModel(): string | undefined {
    // 不显式传 -m，使用 codex 配置的默认模型
    return undefined
  }

  async startTask(input: StartTaskInput): Promise<RunningTask> {
    const effortArgs = input.effort ? ['-c', `model_reasoning_effort="${input.effort}"`] : []
    const args = input.nativeSessionId
      ? [
          'exec', 'resume', input.nativeSessionId, '--json',
          ...(input.model ? ['-m', input.model] : []),
          ...effortArgs,
          input.prompt,
        ]
      : [
          'exec', '--json', '-s', this.sandbox,
          '-C', input.workspace, '--skip-git-repo-check',
          ...(input.model ? ['-m', input.model] : []),
          ...effortArgs,
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
        const ok = code === 0 && state.sawTurnCompleted && !state.lastError
        resolve({
          ok,
          finalText: state.finalText,
          nativeSessionId: state.threadId ?? input.nativeSessionId,
          error: ok ? undefined : (state.lastError ?? (stderr.trim() || `codex exited with code ${code}`)),
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
