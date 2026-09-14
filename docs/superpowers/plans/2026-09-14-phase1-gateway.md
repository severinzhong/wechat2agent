# Phase 1 最小 Gateway 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **git 操作约定：** 计划中的 commit 步骤需在执行前经用户确认。

**Goal:** 把 `gateway/` 从 echo 原型演进为可正式使用的最小 Gateway：微信消息经斜杠命令协议路由，普通消息作为 prompt 发送到当前 backend（Codex / ZL），回复最终文本，session 持久化到本地文件。

**Architecture:** Node.js + TypeScript（tsx 运行、vitest 测试）。`@wechatbot/wechatbot` 负责 iLink 通道；Codex adapter 封装 `codex exec --json`（含 `resume` 续接）；ZL adapter 封装 `zl serve` + `zl run --attach --format json`（事件流解析基于真实 fixture）。命令层沿用已验证的斜杠命名空间协议（见 docs/decisions.md）。

**Tech Stack:** Node.js ≥22、TypeScript、tsx、vitest、`@wechatbot/wechatbot` 2.2.0、`codex` CLI 0.153.4、`zl` CLI 1.5.1。

**已验证事实（探测结论，adapter 实现依据）：**

- Codex `codex exec --json` JSONL 事件：`thread.started` 携带 `thread_id`（resume 用）；`item.completed` 且 `item.type === 'agent_message'` 携带 `item.text`（最终回复）；`turn.completed` 携带 `usage`；`error` 事件可能是非致命流重连（探测样本中 "Reconnecting... 1/5" 后仍正常完成）——成功判定 = 进程退出码 0 且出现过 `turn.completed`。
- Codex 续接：`codex exec resume <SESSION_ID> [PROMPT]`（`--json` 等选项同 exec）。
- Codex spawn 注意：prompt 以位置参数传入；stdin 必须 `ignore`（否则 stderr 出现 "Reading additional input from stdin..."）。
- ZL 必须 `zl serve` + `zl run --attach <url>`：直连 `zl run` 探测时挂起 120s 无输出且偶发 `Session not found`，不可用。
- ZL `zl serve --port 0 --hostname 127.0.0.1` 启动后 stdout 打印 `Zhanlu server listening on http://127.0.0.1:<port>`，由此解析端口。
- ZL JSON 事件：`type` ∈ `step_start` / `text` / `step_finish`；每个事件携带 `sessionID`（`ses_` 前缀，续接用）；`text` 事件正文在 `part.text`；`step_finish` 携带 `reason`、`tokens`、`cost`。成功判定 = 退出码 0 且出现过 `step_finish`。
- ZL 续接：`zl run --attach <url> --session <sessionID> --format json "<prompt>"`。
- 测试 fixture 已就位：`gateway/test/fixtures/codex-events.jsonl`、`gateway/test/fixtures/zl-events.jsonl`（真实探测输出）。

**Phase 1 范围（对照 docs/architecture.md）：** 单一 iLink 账号、单一白名单 workspace（`GATEWAY_WORKSPACE`）、`/help` `/status` `/backend` `/model` `/cancel`、Codex/ZL 文字输入输出与同 backend 原生续接、本地文件 session。不在范围：多 workspace、多账号、handoff/compact、审批交互、媒体消息、SwiftUI 控制面。

---

### Task 1: TypeScript 骨架与工具链

**Files:**
- Modify: `gateway/package.json`
- Create: `gateway/tsconfig.json`
- Create: `gateway/src/index.ts`（临时占位，Task 10 填充）
- Move: `gateway/echo-bot.mjs` → 保留不动（作为参考，Task 12 删除）

- [ ] **Step 1: 安装开发依赖**

```bash
cd gateway
npm install --save-dev typescript tsx vitest @types/node
```

- [ ] **Step 2: 写 tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "outDir": "dist",
    "types": ["node"]
  },
  "include": ["src", "test"]
}
```

- [ ] **Step 3: 更新 package.json**

```json
{
  "name": "wechat2agent-gateway",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "start": "tsx src/index.ts",
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@wechatbot/wechatbot": "^2.2.0"
  }
}
```

- [ ] **Step 4: 创建占位入口并验证工具链**

`gateway/src/index.ts`:

```typescript
console.log('gateway skeleton ok')
```

```bash
cd gateway
npm run typecheck   # 预期：无错误
npm start           # 预期输出：gateway skeleton ok
npm test            # 预期：vitest 报 "No test files found"（属正常，后续任务补测试）
```

- [ ] **Step 5: Commit（需用户确认）**

```bash
git add gateway/package.json gateway/package-lock.json gateway/tsconfig.json gateway/src/index.ts gateway/test/fixtures/
git commit -m "chore(gateway): TypeScript toolchain skeleton"
```

---

### Task 2: SessionStore（接口 + JSON 文件实现）

**Files:**
- Create: `gateway/src/sessions/types.ts`
- Create: `gateway/src/sessions/file-store.ts`
- Test: `gateway/test/file-store.test.ts`

- [ ] **Step 1: 写失败测试**

`gateway/test/file-store.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { FileSessionStore } from '../src/sessions/file-store.js'

describe('FileSessionStore', () => {
  let dir: string
  let store: FileSessionStore

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'w2a-sessions-'))
    store = new FileSessionStore(dir)
  })
  afterEach(async () => rm(dir, { recursive: true, force: true }))

  it('returns undefined for unknown peer', async () => {
    expect(await store.load('nobody@im.wechat')).toBeUndefined()
  })

  it('saves and loads a session', async () => {
    await store.save({
      wechatPeer: 'u1@im.wechat',
      backend: 'codex',
      model: 'gpt-5.2',
      nativeSessionIds: {},
      updatedAt: new Date().toISOString(),
    })
    const loaded = await store.load('u1@im.wechat')
    expect(loaded?.backend).toBe('codex')
    expect(loaded?.model).toBe('gpt-5.2')
  })

  it('persists native session ids per backend', async () => {
    const s = {
      wechatPeer: 'u1@im.wechat',
      backend: 'zl',
      nativeSessionIds: { codex: '01a0a046-2ce0-7fe3-a6ab-46335b175523', zl: 'ses_abc' },
      updatedAt: new Date().toISOString(),
    }
    await store.save(s)
    const loaded = await store.load('u1@im.wechat')
    expect(loaded?.nativeSessionIds.zl).toBe('ses_abc')
    expect(loaded?.nativeSessionIds.codex).toBe('01a0a046-2ce0-7fe3-a6ab-46335b175523')
  })

  it('survives a new store instance (persistence)', async () => {
    await store.save({
      wechatPeer: 'u2@im.wechat',
      backend: 'zl',
      nativeSessionIds: {},
      updatedAt: new Date().toISOString(),
    })
    const fresh = new FileSessionStore(dir)
    expect((await fresh.load('u2@im.wechat'))?.backend).toBe('zl')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd gateway && npx vitest run test/file-store.test.ts
```

预期：FAIL，`Cannot find module '../src/sessions/file-store.js'`。

- [ ] **Step 3: 实现类型与存储**

`gateway/src/sessions/types.ts`:

```typescript
export interface GatewaySession {
  wechatPeer: string
  backend: string
  model?: string
  /** backend name -> native session id（同 backend 续接用；跨 backend 不迁移） */
  nativeSessionIds: Record<string, string>
  updatedAt: string
}

export interface SessionStore {
  load(peer: string): Promise<GatewaySession | undefined>
  save(session: GatewaySession): Promise<void>
}
```

`gateway/src/sessions/file-store.ts`:

```typescript
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { GatewaySession, SessionStore } from './types.js'

export class FileSessionStore implements SessionStore {
  constructor(private readonly dir: string) {}

  private fileOf(peer: string): string {
    const safe = peer.replace(/[^a-zA-Z0-9@._-]/g, '_')
    return path.join(this.dir, `${safe}.json`)
  }

  async load(peer: string): Promise<GatewaySession | undefined> {
    try {
      const raw = await readFile(this.fileOf(peer), 'utf8')
      return JSON.parse(raw) as GatewaySession
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw err
    }
  }

  async save(session: GatewaySession): Promise<void> {
    await mkdir(this.dir, { recursive: true })
    session.updatedAt = new Date().toISOString()
    await writeFile(this.fileOf(session.wechatPeer), JSON.stringify(session, null, 2), {
      encoding: 'utf8',
      mode: 0o600,
    })
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

```bash
cd gateway && npx vitest run test/file-store.test.ts && npm run typecheck
```

预期：4 passed；typecheck 无错误。

- [ ] **Step 5: Commit（需用户确认）**

```bash
git add gateway/src/sessions/ gateway/test/file-store.test.ts
git commit -m "feat(gateway): FileSessionStore with per-backend native session ids"
```

---

### Task 3: BackendAdapter 类型与事件模型

**Files:**
- Create: `gateway/src/adapters/types.ts`

- [ ] **Step 1: 写类型定义（纯类型任务，以 typecheck 作为验证）**

`gateway/src/adapters/types.ts`:

```typescript
/** 规范化任务事件。adapter 把 backend 原生事件流映射为该模型，网关不感知 backend 内部结构。 */
export type TaskEvent =
  | { type: 'text'; text: string }        // agent 产出的文本片段
  | { type: 'progress'; message: string } // 非致命进度信息（如流重连）
  | { type: 'error'; message: string }    // 致命错误

export interface TaskResult {
  ok: boolean
  /** 汇总的最终回复文本（用于微信回复） */
  finalText: string
  /** backend 原生 session id（续接用） */
  nativeSessionId?: string
  error?: string
}

export interface RunningTask {
  /** gateway 侧任务 id */
  readonly id: string
  readonly events: AsyncIterable<TaskEvent>
  readonly done: Promise<TaskResult>
  cancel(): Promise<void>
}

export interface StartTaskInput {
  prompt: string
  workspace: string
  model?: string
  /** 同 backend 原生续接；跨 backend 不迁移 */
  nativeSessionId?: string
}

export interface BackendAdapter {
  readonly name: string
  startTask(input: StartTaskInput): Promise<RunningTask>
  listModels(): Promise<string[]>
  defaultModel(): string
}
```

- [ ] **Step 2: typecheck**

```bash
cd gateway && npm run typecheck
```

预期：无错误。

- [ ] **Step 3: Commit（需用户确认）**

```bash
git add gateway/src/adapters/types.ts
git commit -m "feat(gateway): BackendAdapter interface and task event model"
```

---

### Task 4: Codex 事件解析器（fixture TDD）

**Files:**
- Create: `gateway/src/adapters/codex-parse.ts`
- Test: `gateway/test/codex-parse.test.ts`

- [ ] **Step 1: 写失败测试**

`gateway/test/codex-parse.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { parseCodexLine, initialCodexState } from '../src/adapters/codex-parse.js'

const fixture = readFileSync(path.join(__dirname, 'fixtures/codex-events.jsonl'), 'utf8')
  .trim().split('\n')

describe('parseCodexLine', () => {
  it('extracts thread_id from thread.started', () => {
    const r = parseCodexLine(fixture[0]!, initialCodexState())
    expect(r.state.threadId).toBe('01a0a046-2ce0-7fe3-a6ab-46335b175523')
  })

  it('collects agent_message text from item.completed', () => {
    let state = initialCodexState()
    for (const line of fixture) state = parseCodexLine(line, state).state
    expect(state.finalText).toBe('PROBE_OK')
    expect(state.sawTurnCompleted).toBe(true)
  })

  it('treats stream-reconnect error events as progress, not fatal', () => {
    const errorLine = fixture.find((l) => l.includes('"type":"error"'))!
    const r = parseCodexLine(errorLine, initialCodexState())
    expect(r.events).toEqual([{ type: 'progress', message: expect.stringContaining('Reconnecting') }])
  })

  it('skips malformed lines without throwing', () => {
    const r = parseCodexLine('not json{', initialCodexState())
    expect(r.events).toEqual([])
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd gateway && npx vitest run test/codex-parse.test.ts
```

预期：FAIL，模块不存在。

- [ ] **Step 3: 实现解析器**

`gateway/src/adapters/codex-parse.ts`:

```typescript
import type { TaskEvent } from './types.js'

export interface CodexParseState {
  threadId?: string
  finalText: string
  sawTurnCompleted: boolean
}

export function initialCodexState(): CodexParseState {
  return { finalText: '', sawTurnCompleted: false }
}

interface CodexEvent {
  type: string
  thread_id?: string
  message?: string
  item?: { id?: string; type?: string; text?: string }
  usage?: Record<string, unknown>
}

export function parseCodexLine(
  line: string,
  state: CodexParseState,
): { events: TaskEvent[]; state: CodexParseState } {
  let e: CodexEvent
  try {
    e = JSON.parse(line) as CodexEvent
  } catch {
    return { events: [], state }
  }
  const next = { ...state }
  const events: TaskEvent[] = []

  if (e.type === 'thread.started' && e.thread_id) {
    next.threadId = e.thread_id
  } else if (e.type === 'item.completed' && e.item?.type === 'agent_message' && e.item.text) {
    // 同一 turn 可能出现多条 agent_message，后者覆盖（最终回复以最后一条为准）
    next.finalText = e.item.text
    events.push({ type: 'text', text: e.item.text })
  } else if (e.type === 'turn.completed') {
    next.sawTurnCompleted = true
  } else if (e.type === 'error' && e.message) {
    events.push({ type: 'progress', message: e.message })
  }

  return { events, state: next }
}
```

- [ ] **Step 4: 跑测试确认通过**

```bash
cd gateway && npx vitest run test/codex-parse.test.ts
```

预期：4 passed。

- [ ] **Step 5: Commit（需用户确认）**

```bash
git add gateway/src/adapters/codex-parse.ts gateway/test/codex-parse.test.ts
git commit -m "feat(gateway): codex JSONL event parser"
```

---

### Task 5: Codex adapter（spawn 集成）

**Files:**
- Create: `gateway/src/adapters/codex.ts`
- Create: `gateway/scripts/verify-codex.ts`（手动验证脚本，不进单测）

- [ ] **Step 1: 实现 adapter**

`gateway/src/adapters/codex.ts`:

```typescript
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
    const args = input.nativeSessionId
      ? ['exec', 'resume', input.nativeSessionId, '--json', '-s', this.sandbox, input.prompt]
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
```

- [ ] **Step 2: typecheck**

```bash
cd gateway && npm run typecheck
```

预期：无错误。

- [ ] **Step 3: 写手动验证脚本**

`gateway/scripts/verify-codex.ts`:

```typescript
import { CodexAdapter } from '../src/adapters/codex.js'

const workspace = process.argv[2]
if (!workspace) {
  console.error('usage: tsx scripts/verify-codex.ts <workspace>')
  process.exit(1)
}

const adapter = new CodexAdapter({ sandbox: 'read-only' })

const t1 = await adapter.startTask({ prompt: 'Reply with exactly: ADAPTER_OK', workspace })
for await (const e of t1.events) console.log('[event]', e)
const r1 = await t1.done
console.log('[result]', r1)
if (!r1.ok || r1.finalText.trim() !== 'ADAPTER_OK') throw new Error('first task failed')
if (!r1.nativeSessionId) throw new Error('no thread id captured')

const t2 = await adapter.startTask({
  prompt: 'What text did I ask you to reply with? Answer with just that text.',
  workspace,
  nativeSessionId: r1.nativeSessionId,
})
const r2 = await t2.done
console.log('[result]', r2)
if (!r2.ok) throw new Error('resume task failed')
console.log('CODEX_ADAPTER_VERIFY_OK')
```

- [ ] **Step 4: 跑手动验证（真实调用 codex，确认 resume 续接）**

```bash
cd gateway && npx tsx scripts/verify-codex.ts /var/folders/8s/g643l4f126gdm3zn1s7hywkr0000gn/T/zhanlu/adapter-probe
```

预期：输出含 `CODEX_ADAPTER_VERIFY_OK`；第二次任务结果中模型能复述 `ADAPTER_OK`（验证 native session 续接）。若 `codex exec resume` 不接受 `--json` 或续接失败，先手动跑 `codex exec resume --help` 确认参数形式再修正 adapter。

- [ ] **Step 5: Commit（需用户确认）**

```bash
git add gateway/src/adapters/codex.ts gateway/scripts/verify-codex.ts
git commit -m "feat(gateway): codex exec adapter with resume support"
```

---

### Task 6: ZL 事件解析器（fixture TDD）

**Files:**
- Create: `gateway/src/adapters/zl-parse.ts`
- Test: `gateway/test/zl-parse.test.ts`

- [ ] **Step 1: 写失败测试**

`gateway/test/zl-parse.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { parseZlLine, initialZlState } from '../src/adapters/zl-parse.js'

const fixture = readFileSync(path.join(__dirname, 'fixtures/zl-events.jsonl'), 'utf8')
  .trim().split('\n')

describe('parseZlLine', () => {
  it('captures sessionID from any event', () => {
    const r = parseZlLine(fixture[0]!, initialZlState())
    expect(r.state.sessionId).toBe('ses_f5fac9fe7ffehhTrNzgpUFqxYk')
  })

  it('collects text parts and detects completion', () => {
    let state = initialZlState()
    for (const line of fixture) state = parseZlLine(line, state).state
    expect(state.text).toBe('PROBE_OK')
    expect(state.sawStepFinish).toBe(true)
  })

  it('skips malformed lines without throwing', () => {
    expect(parseZlLine('{broken', initialZlState()).events).toEqual([])
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd gateway && npx vitest run test/zl-parse.test.ts
```

预期：FAIL，模块不存在。

- [ ] **Step 3: 实现解析器**

`gateway/src/adapters/zl-parse.ts`:

```typescript
import type { TaskEvent } from './types.js'

export interface ZlParseState {
  sessionId?: string
  text: string
  sawStepFinish: boolean
}

export function initialZlState(): ZlParseState {
  return { text: '', sawStepFinish: false }
}

interface ZlEvent {
  type: string
  sessionID?: string
  part?: { type?: string; text?: string; reason?: string }
}

export function parseZlLine(
  line: string,
  state: ZlParseState,
): { events: TaskEvent[]; state: ZlParseState } {
  let e: ZlEvent
  try {
    e = JSON.parse(line) as ZlEvent
  } catch {
    return { events: [], state }
  }
  const next = { ...state }
  const events: TaskEvent[] = []

  if (e.sessionID && !next.sessionId) next.sessionId = e.sessionID
  if (e.type === 'text' && e.part?.text) {
    next.text += e.part.text
    events.push({ type: 'text', text: e.part.text })
  } else if (e.type === 'step_finish') {
    next.sawStepFinish = true
  }

  return { events, state: next }
}
```

- [ ] **Step 4: 跑测试确认通过**

```bash
cd gateway && npx vitest run test/zl-parse.test.ts
```

预期：3 passed。

- [ ] **Step 5: Commit（需用户确认）**

```bash
git add gateway/src/adapters/zl-parse.ts gateway/test/zl-parse.test.ts
git commit -m "feat(gateway): zl JSON event parser"
```

---

### Task 7: ZL adapter（serve 生命周期 + attach）

**Files:**
- Create: `gateway/src/adapters/zl.ts`
- Create: `gateway/scripts/verify-zl.ts`

- [ ] **Step 1: 实现 adapter（含 ZlServerManager）**

`gateway/src/adapters/zl.ts`:

```typescript
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
```

- [ ] **Step 2: typecheck**

```bash
cd gateway && npm run typecheck
```

预期：无错误。

- [ ] **Step 3: 写手动验证脚本**

`gateway/scripts/verify-zl.ts`:

```typescript
import { ZlAdapter, ZlServerManager } from '../src/adapters/zl.js'

const workspace = process.argv[2]
if (!workspace) {
  console.error('usage: tsx scripts/verify-zl.ts <workspace>')
  process.exit(1)
}

const mgr = new ZlServerManager(workspace)
const adapter = new ZlAdapter(mgr)
try {
  const t1 = await adapter.startTask({ prompt: 'Reply with exactly: ADAPTER_OK', workspace })
  for await (const e of t1.events) console.log('[event]', e)
  const r1 = await t1.done
  console.log('[result]', r1)
  if (!r1.ok || r1.finalText.trim() !== 'ADAPTER_OK') throw new Error('first task failed')
  if (!r1.nativeSessionId) throw new Error('no sessionID captured')

  const t2 = await adapter.startTask({
    prompt: 'What text did I ask you to reply with? Answer with just that text.',
    workspace,
    nativeSessionId: r1.nativeSessionId,
  })
  const r2 = await t2.done
  console.log('[result]', r2)
  if (!r2.ok) throw new Error('resume task failed')
  console.log('ZL_ADAPTER_VERIFY_OK')
} finally {
  await mgr.stop()
}
```

- [ ] **Step 4: 跑手动验证**

```bash
cd gateway && npx tsx scripts/verify-zl.ts /var/folders/8s/g643l4f126gdm3zn1s7hywkr0000gn/T/zhanlu/adapter-probe
```

预期：输出含 `ZL_ADAPTER_VERIFY_OK`；第二次任务模型能复述 `ADAPTER_OK`（验证 `--session` 续接）。

- [ ] **Step 5: Commit（需用户确认）**

```bash
git add gateway/src/adapters/zl.ts gateway/scripts/verify-zl.ts
git commit -m "feat(gateway): zl adapter with serve lifecycle and session resume"
```

---

### Task 8: TaskManager（生命周期 + 取消 + 节流）

**Files:**
- Create: `gateway/src/tasks/manager.ts`
- Test: `gateway/test/task-manager.test.ts`

Phase 1 节流策略：任务开始时发"已开始"提示，完成/失败时发最终结果，中间事件不进微信。

- [ ] **Step 1: 写失败测试**

`gateway/test/task-manager.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { TaskManager } from '../src/tasks/manager.js'
import type { BackendAdapter, RunningTask, TaskEvent } from '../src/adapters/types.js'

function fakeTask(events: TaskEvent[], result: { ok: boolean; finalText: string; nativeSessionId?: string }): RunningTask {
  return {
    id: 'task-1',
    events: (async function* () { for (const e of events) yield e })(),
    done: Promise.resolve(result),
    cancel: async () => {},
  }
}

function fakeAdapter(overrides: Partial<BackendAdapter> = {}): BackendAdapter {
  return {
    name: 'fake',
    listModels: async () => ['m1'],
    defaultModel: () => 'm1',
    startTask: async () => fakeTask(
      [{ type: 'text', text: 'hello' }],
      { ok: true, finalText: 'hello', nativeSessionId: 'native-1' },
    ),
    ...overrides,
  }
}

describe('TaskManager', () => {
  it('runs a task to completion and reports final text', async () => {
    const mgr = new TaskManager()
    const run = await mgr.start('peer1', fakeAdapter(), { prompt: 'hi', workspace: '/tmp' })
    const result = await run.done
    expect(result.ok).toBe(true)
    expect(result.finalText).toBe('hello')
    expect(mgr.activeOf('peer1')).toBeUndefined()
  })

  it('exposes native session id after completion', async () => {
    const mgr = new TaskManager()
    const run = await mgr.start('peer1', fakeAdapter(), { prompt: 'hi', workspace: '/tmp' })
    const result = await run.done
    expect(result.nativeSessionId).toBe('native-1')
  })

  it('cancels the active task', async () => {
    let cancelled = false
    const adapter = fakeAdapter({
      startTask: async () => ({
        id: 'task-x',
        events: (async function* () {})(),
        done: new Promise(() => {}), // never resolves
        cancel: async () => { cancelled = true },
      }),
    })
    const mgr = new TaskManager()
    await mgr.start('peer1', adapter, { prompt: 'hi', workspace: '/tmp' })
    expect(mgr.activeOf('peer1')).toBeDefined()
    await mgr.cancel('peer1')
    expect(cancelled).toBe(true)
    expect(mgr.activeOf('peer1')).toBeUndefined()
  })

  it('rejects a second task while one is active', async () => {
    const adapter = fakeAdapter({
      startTask: async () => ({
        id: 'task-y',
        events: (async function* () {})(),
        done: new Promise(() => {}),
        cancel: async () => {},
      }),
    })
    const mgr = new TaskManager()
    await mgr.start('peer1', adapter, { prompt: 'hi', workspace: '/tmp' })
    await expect(mgr.start('peer1', adapter, { prompt: 'again', workspace: '/tmp' }))
      .rejects.toThrow('任务进行中')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd gateway && npx vitest run test/task-manager.test.ts
```

预期：FAIL，模块不存在。

- [ ] **Step 3: 实现 TaskManager**

`gateway/src/tasks/manager.ts`:

```typescript
import type { BackendAdapter, RunningTask, StartTaskInput, TaskResult } from '../adapters/types.js'

/** 每个 wechat peer 同时最多一个活动任务（Phase 1 无队列）。 */
export class TaskManager {
  private readonly active = new Map<string, RunningTask>()

  activeOf(peer: string): RunningTask | undefined {
    return this.active.get(peer)
  }

  async start(peer: string, adapter: BackendAdapter, input: StartTaskInput): Promise<{ done: Promise<TaskResult> }> {
    if (this.active.has(peer)) throw new Error('任务进行中，请先 /cancel')
    const task = await adapter.startTask(input)
    this.active.set(peer, task)
    const done = task.done.finally(() => {
      if (this.active.get(peer) === task) this.active.delete(peer)
    })
    return { done }
  }

  async cancel(peer: string): Promise<boolean> {
    const task = this.active.get(peer)
    if (!task) return false
    await task.cancel()
    this.active.delete(peer)
    return true
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

```bash
cd gateway && npx vitest run test/task-manager.test.ts
```

预期：4 passed。

- [ ] **Step 5: Commit（需用户确认）**

```bash
git add gateway/src/tasks/manager.ts gateway/test/task-manager.test.ts
git commit -m "feat(gateway): task manager with per-peer exclusive tasks"
```

---

### Task 9: 命令层 TS 化（斜杠命名空间 + 菜单 + fallback）

**Files:**
- Create: `gateway/src/commands/router.ts`
- Test: `gateway/test/command-router.test.ts`

逻辑从 `gateway/echo-bot.mjs` 迁移并 TS 化；model 列表改由 adapter 提供；命令层不直接依赖 wechatbot，输出纯文本回复列表，由 gateway.ts 负责发送。

- [ ] **Step 1: 写失败测试**

`gateway/test/command-router.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { CommandRouter, type CommandContext } from '../src/commands/router.js'

function ctx(overrides: Partial<CommandContext> = {}): CommandContext {
  return {
    backend: 'codex',
    model: 'gpt-5.2',
    backends: ['codex', 'zl'],
    modelsOf: (b: string) => (b === 'codex' ? ['gpt-5.2', 'gpt-5.2-codex'] : ['zhanlu/qwen3.7-max']),
    taskActive: false,
    ...overrides,
  }
}

describe('CommandRouter', () => {
  it('/help lists commands', () => {
    const r = new CommandRouter()
    const out = r.handle('/help', ctx())
    expect(out.replies[0]).toContain('/backend')
    expect(out.replies[0]).toContain('/cancel')
  })

  it('/status shows backend and model', () => {
    const out = new CommandRouter().handle('/status', ctx())
    expect(out.replies[0]).toContain('codex')
    expect(out.replies[0]).toContain('gpt-5.2')
  })

  it('/backend without args opens a numbered menu', () => {
    const r = new CommandRouter()
    const out = r.handle('/backend', ctx())
    expect(out.replies[0]).toContain('/1 codex')
    expect(out.replies[0]).toContain('/2 zl')
    expect(out.menu).toBeDefined()
  })

  it('menu choice via /2 switches backend', () => {
    const r = new CommandRouter()
    r.handle('/backend', ctx())
    const out = r.handle('/2', ctx())
    expect(out.replies[0]).toContain('已切换到 zl')
    expect(out.set?.backend).toBe('zl')
  })

  it('/backend zl switches directly without menu', () => {
    const out = new CommandRouter().handle('/backend zl', ctx())
    expect(out.replies[0]).toContain('已切换到 zl')
    expect(out.set?.backend).toBe('zl')
  })

  it('out-of-range choice cancels the menu', () => {
    const r = new CommandRouter()
    r.handle('/backend', ctx())
    const out = r.handle('/9', ctx())
    expect(out.replies[0]).toContain('无效选项')
    expect(out.menu).toBeUndefined()
  })

  it('unrelated slash command discards the menu', () => {
    const r = new CommandRouter()
    r.handle('/backend', ctx())
    const out = r.handle('/status', ctx())
    expect(out.replies[0]).toContain('codex')
    expect(out.menu).toBeUndefined()
  })

  it('switching backend while task active is refused', () => {
    const r = new CommandRouter()
    const out = r.handle('/backend zl', ctx({ taskActive: true }))
    expect(out.replies[0]).toContain('任务进行中')
    expect(out.set).toBeUndefined()
  })

  it('/model lists models of current backend', () => {
    const out = new CommandRouter().handle('/model', ctx())
    expect(out.replies[0]).toContain('/1 gpt-5.2')
    expect(out.replies[0]).toContain('/2 gpt-5.2-codex')
  })

  it('unknown command gets a hint', () => {
    const out = new CommandRouter().handle('/xyz', ctx())
    expect(out.replies[0]).toContain('未知命令')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd gateway && npx vitest run test/command-router.test.ts
```

预期：FAIL，模块不存在。

- [ ] **Step 3: 实现命令路由**

`gateway/src/commands/router.ts`:

```typescript
export interface CommandContext {
  backend: string
  model?: string
  backends: string[]
  modelsOf: (backend: string) => string[]
  taskActive: boolean
}

export interface CommandOutput {
  replies: string[]
  /** 会话状态变更请求（由 gateway 应用到 session store） */
  set?: { backend?: string; model?: string }
  /** 输出的待选菜单（gateway 保存到会话） */
  menu?: { items: MenuItem[] }
}

export interface MenuItem {
  label: string
  /** 选择后的效果描述为 set 请求 */
  set: { backend?: string; model?: string }
  /** 受任务互斥保护 */
  guardedByTask?: boolean
}

const HELP = `可用命令：
/help — 显示本帮助
/status — 查看当前 backend、model、任务状态
/backend [名称] — 切换 backend
/model [名称] — 切换 model
/cancel — 取消当前任务
菜单选择：回复 /1、/2…选择，/0 取消`

export class CommandRouter {
  handle(input: string, ctx: CommandContext): CommandOutput {
    const [cmd, ...args] = input.trim().split(/\s+/)

    const num = /^\/(\d+)$/.exec(cmd ?? '')
    if (num) return { replies: ['当前没有待选择的菜单。/help 查看命令'] } // 由 gateway 在有菜单时先行处理

    switch (cmd) {
      case '/help':
        return { replies: [HELP] }
      case '/status':
        return {
          replies: [
            `当前状态\nbackend: ${ctx.backend}\nmodel: ${ctx.model ?? '(默认)'}\n任务: ${ctx.taskActive ? '运行中' : '无'}`,
          ],
        }
      case '/backend':
        if (args[0]) return this.applyBackend(args[0], ctx)
        return {
          replies: [
            menuText('切换 backend', ctx.backends.map((b) => b + (b === ctx.backend ? '（当前）' : ''))),
          ],
          menu: {
            items: ctx.backends.map((b) => ({
              label: b,
              set: { backend: b },
              guardedByTask: true,
            })),
          },
        }
      case '/model':
        if (args[0]) return this.applyModel(args[0], ctx)
        return {
          replies: [
            menuText(`切换 model（${ctx.backend}）`, ctx.modelsOf(ctx.backend)),
          ],
          menu: {
            items: ctx.modelsOf(ctx.backend).map((m) => ({ label: m, set: { model: m } })),
          },
        }
      case '/cancel':
        return { replies: [ctx.taskActive ? '任务已取消' : '当前没有运行中的任务'] }
      default:
        return { replies: [`未知命令: ${cmd}\n/help 查看可用命令`] }
    }
  }

  /** 菜单数字选择（gateway 在持有菜单时调用）。 */
  resolveMenu(choice: number, menu: { items: MenuItem[] }, ctx: CommandContext): CommandOutput {
    if (choice === 0) return { replies: ['已取消'] }
    const item = menu.items[choice - 1]
    if (!item) return { replies: ['无效选项，菜单已取消'] }
    if (item.guardedByTask && ctx.taskActive) return { replies: ['任务进行中，请先 /cancel'] }
    const desc = item.set.backend ?? item.set.model ?? ''
    return { replies: [`已切换到 ${desc}`], set: item.set }
  }

  private applyBackend(name: string, ctx: CommandContext): CommandOutput {
    if (!ctx.backends.includes(name)) {
      return { replies: [`未知 backend: ${name}（可选：${ctx.backends.join(' / ')}）`] }
    }
    if (ctx.taskActive) return { replies: ['任务进行中，请先 /cancel 再切换 backend'] }
    if (name === ctx.backend) return { replies: [`已在使用 ${name}`] }
    return { replies: [`已切换到 ${name}`], set: { backend: name } }
  }

  private applyModel(name: string, ctx: CommandContext): CommandOutput {
    const models = ctx.modelsOf(ctx.backend)
    if (!models.includes(name)) {
      return { replies: [`未知 model: ${name}\n当前 backend（${ctx.backend}）可选：\n${models.join('\n')}`] }
    }
    return { replies: [`model 已切换为 ${name}`], set: { model: name } }
  }
}

function menuText(title: string, labels: string[]): string {
  const lines = labels.map((label, i) => `/${i + 1} ${label}`)
  return `${title}\n${lines.join('\n')}\n/0 取消`
}
```

- [ ] **Step 4: 跑测试确认通过**

```bash
cd gateway && npx vitest run test/command-router.test.ts && npm run typecheck
```

预期：10 passed；typecheck 无错误。

注意：测试 `menu choice via /2 switches backend` 通过 `resolveMenu` 验证——gateway 层在收到 `/数字` 且会话持有菜单时调用 `resolveMenu`，否则走 `handle` 得到"当前没有待选择的菜单"。菜单的 fallback（非斜杠消息/其他命令使菜单作废）由 gateway 在 Task 10 组装时实现。

- [ ] **Step 5: Commit（需用户确认）**

```bash
git add gateway/src/commands/router.ts gateway/test/command-router.test.ts
git commit -m "feat(gateway): slash command router with menu protocol"
```

---

### Task 10: Gateway 组装与入口

**Files:**
- Create: `gateway/src/gateway.ts`
- Create: `gateway/src/config.ts`
- Modify: `gateway/src/index.ts`

- [ ] **Step 1: 写配置模块**

`gateway/src/config.ts`:

```typescript
import path from 'node:path'

export interface GatewayConfig {
  /** iLink 凭证与 gateway 状态存储目录 */
  storageDir: string
  /** 唯一允许的 workspace 白名单目录 */
  workspace: string
  defaultBackend: string
  logLevel: 'debug' | 'info' | 'warn' | 'error' | 'silent'
}

export function loadConfig(): GatewayConfig {
  return {
    storageDir: process.env.GATEWAY_STORAGE_DIR ?? path.join(process.cwd(), '.storage'),
    workspace: process.env.GATEWAY_WORKSPACE ?? process.cwd(),
    defaultBackend: process.env.GATEWAY_BACKEND ?? 'codex',
    logLevel: (process.env.LOG_LEVEL as GatewayConfig['logLevel']) ?? 'info',
  }
}
```

- [ ] **Step 2: 写 Gateway 类**

`gateway/src/gateway.ts`:

```typescript
import type { WeChatBot, IncomingMessage } from '@wechatbot/wechatbot'
import { CommandRouter, type MenuItem } from './commands/router.js'
import type { SessionStore, GatewaySession } from './sessions/types.js'
import { TaskManager } from './tasks/manager.js'
import type { BackendAdapter } from './adapters/types.js'

export interface GatewayDeps {
  bot: WeChatBot
  store: SessionStore
  adapters: Record<string, BackendAdapter>
  workspace: string
  defaultBackend: string
}

interface PeerState {
  menu?: { items: MenuItem[] }
}

export class Gateway {
  private readonly router = new CommandRouter()
  private readonly tasks = new TaskManager()
  private readonly peers = new Map<string, PeerState>()

  constructor(private readonly deps: GatewayDeps) {}

  async handleMessage(msg: IncomingMessage): Promise<void> {
    if (msg.type !== 'text') {
      await this.deps.bot.reply(msg, `暂不支持 ${msg.type} 消息（Phase 1 仅文本）`)
      return
    }
    const peer = msg.userId
    const session = await this.loadSession(peer)
    const state = this.peers.get(peer) ?? {}
    this.peers.set(peer, state)
    const text = msg.text.trim()

    if (text.startsWith('/')) {
      await this.handleCommand(msg, session, state, text)
      return
    }

    // 非斜杠消息：菜单静默作废，进入任务流程
    state.menu = undefined
    await this.runTask(msg, session)
  }

  private async handleCommand(
    msg: IncomingMessage,
    session: GatewaySession,
    state: PeerState,
    text: string,
  ): Promise<void> {
    const ctx = {
      backend: session.backend,
      model: session.model,
      backends: Object.keys(this.deps.adapters),
      modelsOf: (b: string) => this.deps.adapters[b]?.defaultModel()
        ? [this.deps.adapters[b]!.defaultModel()]
        : [],
      taskActive: this.tasks.activeOf(msg.userId) !== undefined,
    }

    // 数字选择：优先消费会话中的菜单
    const num = /^\/(\d+)$/.exec(text)
    if (num && state.menu) {
      const out = this.router.resolveMenu(Number(num[1]), state.menu, ctx)
      state.menu = undefined
      await this.applyOutput(msg, session, out)
      return
    }

    // 其他命令：旧菜单静默作废
    state.menu = undefined
    const out = this.router.handle(text, ctx)
    state.menu = out.menu
    await this.applyOutput(msg, session, out)
    return
  }

  private async applyOutput(
    msg: IncomingMessage,
    session: GatewaySession,
    out: { replies: string[]; set?: { backend?: string; model?: string } },
  ): Promise<void> {
    if (out.set?.backend && out.set.backend !== session.backend) {
      session.backend = out.set.backend
      session.model = this.deps.adapters[session.backend]?.defaultModel()
    }
    if (out.set?.model) session.model = out.set.model
    if (out.set) await this.deps.store.save(session)
    for (const reply of out.replies) await this.deps.bot.reply(msg, reply)
  }

  private async runTask(msg: IncomingMessage, session: GatewaySession): Promise<void> {
    const adapter = this.deps.adapters[session.backend]
    if (!adapter) {
      await this.deps.bot.reply(msg, `未知 backend: ${session.backend}`)
      return
    }
    if (this.tasks.activeOf(msg.userId)) {
      await this.deps.bot.reply(msg, '任务进行中，请先 /cancel')
      return
    }

    const run = await this.tasks.start(msg.userId, adapter, {
      prompt: msg.text,
      workspace: this.deps.workspace,
      model: session.model,
      nativeSessionId: session.nativeSessionIds[session.backend],
    })

    await this.deps.bot.reply(msg, `已开始（${session.backend}${session.model ? `/${session.model}` : ''}）`)

    const result = await run.done
    if (result.nativeSessionId) {
      session.nativeSessionIds[session.backend] = result.nativeSessionId
      await this.deps.store.save(session)
    }
    if (result.ok) {
      await this.deps.bot.send(msg.userId, result.finalText || '(任务完成，无文本输出)')
    } else {
      await this.deps.bot.send(msg.userId, `任务失败: ${result.error ?? '未知错误'}`)
    }
  }

  private async loadSession(peer: string): Promise<GatewaySession> {
    const existing = await this.deps.store.load(peer)
    if (existing) return existing
    const adapter = this.deps.adapters[this.deps.defaultBackend]!
    const session: GatewaySession = {
      wechatPeer: peer,
      backend: this.deps.defaultBackend,
      model: adapter.defaultModel(),
      nativeSessionIds: {},
      updatedAt: new Date().toISOString(),
    }
    await this.deps.store.save(session)
    return session
  }
}
```

- [ ] **Step 3: 写入口**

`gateway/src/index.ts`:

```typescript
import { WeChatBot } from '@wechatbot/wechatbot'
import path from 'node:path'
import { loadConfig } from './config.js'
import { FileSessionStore } from './sessions/file-store.js'
import { CodexAdapter } from './adapters/codex.js'
import { ZlAdapter, ZlServerManager } from './adapters/zl.js'
import { Gateway } from './gateway.js'

const config = loadConfig()

const bot = new WeChatBot({
  storage: 'file',
  storageDir: path.join(config.storageDir, 'ilink'),
  logLevel: config.logLevel,
  botAgent: 'wechat2agent-gateway/0.1',
})

const zlServer = new ZlServerManager(config.workspace)
const gateway = new Gateway({
  bot,
  store: new FileSessionStore(path.join(config.storageDir, 'sessions')),
  adapters: {
    codex: new CodexAdapter(),
    zl: new ZlAdapter(zlServer),
  },
  workspace: config.workspace,
  defaultBackend: config.defaultBackend,
})

bot.onMessage((msg) => {
  gateway.handleMessage(msg).catch((err) => {
    console.error('handleMessage failed:', err)
  })
})
bot.on('session:expired', () => console.error('iLink 会话过期，请重启并重新扫码'))
bot.on('error', (err) => console.error('bot error:', err))

process.on('SIGINT', async () => {
  await zlServer.stop()
  bot.stop()
  process.exit(0)
})

async function loginWithRetry(retries = 3) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await bot.login({
        callbacks: {
          onQrUrl: (url) => console.log(`\n请用微信扫码登录:\n${url}\n`),
          onScanned: () => console.log('已扫码，请在微信中确认…'),
        },
      })
    } catch (err) {
      if (attempt >= retries) throw err
      console.warn(`登录第 ${attempt} 次失败（${(err as Error).message}），重试…`)
    }
  }
}

const creds = await loginWithRetry()
console.log(`已登录: ${creds.accountId}`)
console.log(`workspace: ${config.workspace}`)
await bot.start()
console.log('gateway 运行中，/help 查看命令')
```

- [ ] **Step 4: typecheck + 全量单测**

```bash
cd gateway && npm run typecheck && npm test
```

预期：typecheck 无错误；18 个测试全部通过（4 file-store + 4 codex-parse + 3 zl-parse + 4 task-manager + 10 command-router = 25 个，以实际为准）。

- [ ] **Step 5: Commit（需用户确认）**

```bash
git add gateway/src/ gateway/test/
git commit -m "feat(gateway): wire gateway, config and entrypoint"
```

---

### Task 11: E2E 微信手动验证

**Files:** 无新代码；验证清单。

前置：`GATEWAY_STORAGE_DIR` 指向含已登录 iLink 凭证的目录（复用 `gateway/.storage/`，内含 Phase 0 的 ilink 凭证子目录结构——若复用 echo-bot 的 `.storage`，需把凭证移到 `.storage/ilink/` 下，或临时设置 `GATEWAY_STORAGE_DIR` 使 `ilink` 子目录指向现有凭证）。

- [ ] **Step 1: 启动 gateway**

```bash
cd gateway
GATEWAY_WORKSPACE=/var/folders/8s/g643l4f126gdm3zn1s7hywkr0000gn/T/zhanlu/adapter-probe npm start
```

预期：免扫码登录，输出 `gateway 运行中`。

- [ ] **Step 2: 微信端逐项验证**

| 输入 | 预期 |
|---|---|
| `/help` | 命令列表 |
| `/status` | `backend: codex`、model、任务无 |
| `你好，回复 PHASE1_OK` | 先收到"已开始（codex/…）"，随后收到 codex 的真实回复 |
| 任意文本（第二轮） | 回复内容与第一轮同 session（可问"我上一轮让你回复什么"验证续接） |
| `/backend zl` | `已切换到 zl` |
| `你好，回复 PHASE1_OK` | zl 的真实回复 |
| `/model` | zl 的 model 菜单 |
| `/status` | `backend: zl` |
| 长任务期间发 `/backend codex` | `任务进行中，请先 /cancel` |
| 长任务期间发 `/cancel` | `任务已取消` |
| 菜单后发普通消息 | 菜单静默作废，消息正常进入任务流程 |

- [ ] **Step 3: 记录结果**

把验证结果（通过项/问题）追加到 `docs/research.md` 2.4 小节末尾的「Phase 1 E2E」列表。

- [ ] **Step 4: Commit（需用户确认）**

```bash
git add docs/research.md
git commit -m "docs: phase 1 e2e verification results"
```

---

### Task 12: 收尾与文档同步

**Files:**
- Delete: `gateway/echo-bot.mjs`
- Modify: `docs/architecture.md`（Phase 1 清单标注完成状态）
- Modify: `docs/decisions.md`（记录 Phase 1 落地事实：`codex exec resume` 续接、zl serve+attach 为唯一可用形态、TaskManager 单活动任务）
- Modify: `README.md`（更新"当前状态"：Phase 1 完成）

- [ ] **Step 1: 删除原型**

```bash
rm gateway/echo-bot.mjs
```

- [ ] **Step 2: 更新 docs/architecture.md Phase 1 清单**

```markdown
### Phase 1：最小 Gateway

- 单一 iLink 账号。（已完成）
- 一个允许的 workspace。（已完成，GATEWAY_WORKSPACE 白名单）
- `/backend`、`/model`、`/status`、`/cancel`。（已完成，斜杠命名空间 + 菜单 fallback）
- Codex 和 ZL 的文字输入输出。（已完成，含同 backend 原生续接）
- 本地文件状态。（已完成，FileSessionStore）
```

- [ ] **Step 3: docs/decisions.md 追加**

```markdown
### 2026-09-XX：Phase 1 落地事实

- Codex adapter 采用 `codex exec --json`，同 backend 续接用 `codex exec resume <thread_id>`。
- ZL adapter 采用 `zl serve`（每 workspace 一个实例）+ `zl run --attach --format json`；直连 `zl run` 探测时挂起不可用，不作运行路径。
- 任务模型：每 peer 同时最多一个活动任务，无队列；事件节流为"开始提示 + 最终文本"。
```

- [ ] **Step 4: 更新 README.md 当前状态**

```markdown
## 当前状态

Phase 1 最小 Gateway 已完成：微信文本消息经斜杠命令协议路由，普通消息进入当前 backend（Codex/ZL）执行并回复最终文本，session 持久化到本地文件。运行方式见 `gateway/`。
```

- [ ] **Step 5: 全量验证 + Commit（需用户确认）**

```bash
cd gateway && npm run typecheck && npm test
git add -A
git commit -m "docs: mark phase 1 complete, drop echo prototype"
```

---

## Self-Review 结论

- **Spec 覆盖**：Phase 1 六项范围 → Task 1-3（骨架/存储/接口）、4-7（双 adapter）、8（任务）、9（命令）、10（组装）、11（E2E）、12（文档），逐项有归属。
- **占位符扫描**：无 TBD/TODO；所有代码块完整；探测脚本含失败分支处理。
- **类型一致性**：`TaskEvent`/`TaskResult`/`RunningTask`/`StartTaskInput`/`BackendAdapter`（Task 3 定义）在 Task 4-10 中同名引用；`resolveMenu` 与 `handle` 的分工在 Task 9/10 一致；`nativeSessionIds`（Task 2）在 Task 10 按 backend 存取一致。
- **已知风险**：`codex exec resume --json` 的参数形式未单独实测（Task 5 Step 4 含失败时的确认指引）；微信侧单账号单 poller，调试时避免与遗留 bot 进程并发轮询。
