import { spawn } from 'node:child_process'
import readline from 'node:readline'
import { randomUUID } from 'node:crypto'
import { readFile, readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { parseCodexLine, initialCodexState } from './codex-parse.js'
import { NO_EVENT_TIMEOUT_MS, type BackendAdapter, type RunningTask, type SessionSummary, type StartTaskInput, type TaskEvent, type TaskResult } from './types.js'

export interface CodexAdapterOptions {
  bin?: string
  sandbox?: 'read-only' | 'workspace-write' | 'danger-full-access'
  /** liveness 兜底超时（毫秒），测试可注入小值 */
  noEventMs?: number
  /** liveness 检查间隔（毫秒），测试可注入小值 */
  livenessCheckMs?: number
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
  private readonly noEventMs: number
  private readonly livenessCheckMs: number
  private catalogCache?: CodexModelCatalogEntry[]
  private catalogFetchedAt?: string

  constructor(options: CodexAdapterOptions = {}) {
    this.bin = options.bin ?? process.env.CODEX_BIN ?? 'codex'
    this.sandbox = options.sandbox ?? 'workspace-write'
    this.noEventMs = options.noEventMs ?? NO_EVENT_TIMEOUT_MS
    this.livenessCheckMs = options.livenessCheckMs ?? 30_000
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

  /**
   * 列出当前 workspace 的最近 session。
   * 扫描 ~/.codex/sessions/Y/M/D/rollout-*.jsonl，解析首行 session_meta，
   * 按 cwd === workspace 过滤（resume 会沿用原 cwd，跨目录会绕过 workspace 白名单）。
   */
  async listSessions(workspace: string): Promise<SessionSummary[]> {
    const home = process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex')
    const root = path.join(home, 'sessions')
    const files: { file: string; mtime: number }[] = []
    for (const y of await readdirSafe(root)) {
      for (const m of await readdirSafe(path.join(root, y))) {
        for (const d of await readdirSafe(path.join(root, y, m))) {
          for (const f of await readdirSafe(path.join(root, y, m, d))) {
            if (!f.endsWith('.jsonl')) continue
            const file = path.join(root, y, m, d, f)
            const st = await stat(file).catch(() => undefined)
            if (st) files.push({ file, mtime: st.mtimeMs })
          }
        }
      }
    }
    files.sort((a, b) => b.mtime - a.mtime)

    const out: SessionSummary[] = []
    for (const { file, mtime } of files) {
      if (out.length >= 5) break
      const meta = await readSessionMeta(file)
      if (!meta || meta.cwd !== workspace) continue
      out.push({
        id: meta.id,
        title: new Date(meta.timestamp).toLocaleString('zh-CN', { hour12: false }),
        updatedAt: new Date(mtime).toISOString(),
      })
    }
    return out
  }

  async startTask(input: StartTaskInput): Promise<RunningTask> {
    const effortArgs = input.effort ? ['-c', `model_reasoning_effort="${input.effort}"`] : []
    // resume 子命令不接受 -s/--sandbox（会话沿用创建时的配置）
    const args = input.nativeSessionId
      ? [
          'exec', 'resume', input.nativeSessionId, '--json', '--skip-git-repo-check',
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

    // liveness 兜底：长时间无任何事件则报错并杀进程
    const liveness = setInterval(() => {
      if (produced) return
      const idleMin = Math.floor((Date.now() - state.lastEventAt) / 60_000)
      if (Date.now() - state.lastEventAt > this.noEventMs) {
        push({ type: 'error', message: `任务超过 ${idleMin} 分钟无事件，可能挂起，已终止` })
        child.kill('SIGTERM')
      }
    }, this.livenessCheckMs)

    const done = new Promise<TaskResult>((resolve) => {
      child.on('close', (code) => {
        clearInterval(liveness)
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

async function readdirSafe(dir: string): Promise<string[]> {
  try {
    return await readdir(dir)
  } catch {
    return []
  }
}

async function readSessionMeta(file: string): Promise<{ id: string; cwd: string; timestamp: string } | undefined> {
  try {
    const content = await readFile(file, 'utf8')
    const firstLine = content.split('\n', 1)[0] ?? ''
    const e = JSON.parse(firstLine) as { type?: string; payload?: { session_id?: string; cwd?: string; timestamp?: string } }
    if (e.type !== 'session_meta' || !e.payload?.session_id || !e.payload.cwd) return undefined
    return {
      id: e.payload.session_id,
      cwd: e.payload.cwd,
      timestamp: e.payload.timestamp ?? '',
    }
  } catch {
    return undefined
  }
}
