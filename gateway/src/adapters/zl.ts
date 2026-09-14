import { spawn, type ChildProcess } from 'node:child_process'
import readline from 'node:readline'
import { randomUUID } from 'node:crypto'
import { parseZlLine, initialZlState } from './zl-parse.js'
import { NO_EVENT_TIMEOUT_MS, type AdapterHooks, type BackendAdapter, type RunningTask, type SessionSummary, type StartTaskInput, type TaskEvent, type TaskResult } from './types.js'

/** 剔除从父进程（如 IDE 派生 shell）继承的 server 认证变量，保证回环 server 无 basic auth、行为一致。 */
function cleanEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env }
  delete env.KILO_SERVER_USERNAME
  delete env.KILO_SERVER_PASSWORD
  return env
}

/** 管理 zl serve 实例（每个 workspace 一个，server 与工作目录绑定，见 docs/research.md 5.3）。 */
export class ZlServerManager {
  private servers = new Map<string, { child: ChildProcess; url: string }>()

  constructor(
    private readonly bin: string = process.env.ZL_BIN ?? 'zl',
    private readonly hooks: AdapterHooks = {},
  ) {}

  async ensureServer(workspace: string): Promise<string> {
    const existing = this.servers.get(workspace)
    if (existing) return existing.url
    const child = spawn(this.bin, ['serve', '--port', '0', '--hostname', '127.0.0.1'], {
      cwd: workspace,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: cleanEnv(),
    })
    const url = await new Promise<string>((resolve, reject) => {
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
    this.servers.set(workspace, { child, url })
    // serve 启动后注册死亡检测：清除缓存，并通知网关（server 死亡会导致 attach 的 run 挂起）
    child.on('exit', (code) => {
      this.servers.delete(workspace)
      this.hooks.onServeDead?.(`zl serve（${workspace}）退出（code ${code}）`)
    })
    return url
  }

  async stop(): Promise<void> {
    for (const { child } of this.servers.values()) child.kill('SIGTERM')
    this.servers.clear()
  }
}

export class ZlAdapter implements BackendAdapter {
  readonly name = 'zl'
  private modelsCache?: string[]

  constructor(
    private readonly serverManager: ZlServerManager,
    private readonly bin: string = process.env.ZL_BIN ?? 'zl',
    private readonly noEventMs: number = NO_EVENT_TIMEOUT_MS,
  ) {}

  async listModels(): Promise<string[]> {
    if (this.modelsCache) return this.modelsCache
    const output = await new Promise<string>((resolve, reject) => {
      const child = spawn(this.bin, ['models'], { stdio: ['ignore', 'pipe', 'pipe'] })
      let out = ''
      child.stdout!.on('data', (d: Buffer) => { out += d.toString() })
      child.on('close', (code) => {
        if (code === 0) resolve(out)
        else reject(new Error(`zl models exited with code ${code}`))
      })
      child.on('error', reject)
    })
    this.modelsCache = output
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith('Available'))
    return this.modelsCache
  }

  defaultModel(): string | undefined {
    // 不显式传 -m，使用 zl server 配置的默认模型
    return undefined
  }

  async listEfforts(): Promise<string[]> {
    // zl 无 variant 枚举命令；--variant 为 provider-specific（help 示例：high/max/minimal）
    return ['minimal', 'low', 'medium', 'high', 'max']
  }

  /** 列出指定 workspace 的最近 session（server 按 directory 过滤，天然限定）。 */
  async listSessions(workspace: string): Promise<SessionSummary[]> {
    const base = await this.serverManager.ensureServer(workspace)
    const res = await fetch(`${base}/session`)
    if (!res.ok) throw new Error(`GET /session failed: HTTP ${res.status}`)
    const list = (await res.json()) as { id: string; title?: string }[]
    return list.slice(0, 5).map((s) => ({ id: s.id, title: s.title || s.id.slice(0, 14) }))
  }

  async startTask(input: StartTaskInput): Promise<RunningTask> {
    const serverUrl = await this.serverManager.ensureServer(input.workspace)
    const args = [
      'run', '--attach', serverUrl, '--format', 'json', '--dir', input.workspace,
      ...(input.nativeSessionId ? ['--session', input.nativeSessionId] : []),
      ...(input.model ? ['-m', input.model] : []),
      ...(input.effort ? ['--variant', input.effort] : []),
      input.prompt,
    ]
    const child = spawn(this.bin, args, { stdio: ['ignore', 'pipe', 'pipe'], env: cleanEnv() })

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

    // liveness 兜底：长时间无任何事件（如 serve 被杀导致 run 挂起）则报错并杀进程
    const liveness = setInterval(() => {
      if (produced) return
      const idleMin = Math.floor((Date.now() - state.lastEventAt) / 60_000)
      if (Date.now() - state.lastEventAt > this.noEventMs) {
        push({ type: 'error', message: `任务超过 ${idleMin} 分钟无事件，可能挂起（如 serve 被杀），已终止` })
        child.kill('SIGTERM')
      }
    }, 30_000)

    const done = new Promise<TaskResult>((resolve) => {
      child.on('close', (code) => {
        clearInterval(liveness)
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
