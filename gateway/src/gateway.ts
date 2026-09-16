import type { WeChatBot, IncomingMessage } from '@wechatbot/wechatbot'
import os from 'node:os'
import { stat } from 'node:fs/promises'
import { CommandRouter, type MenuItem } from './commands/router.js'
import type { SessionStore, GatewaySession, VerboseLevel } from './sessions/types.js'
import { TaskManager } from './tasks/manager.js'
import type { BackendAdapter } from './adapters/types.js'

export interface GatewayDeps {
  bot: WeChatBot
  store: SessionStore
  adapters: Record<string, BackendAdapter>
  /** 默认 workspace（可选；session.workspace 优先） */
  workspace?: string
  defaultBackend: string
  /** 长任务进度心跳间隔（毫秒） */
  heartbeatMs: number
}

interface PeerState {
  menu?: { items: MenuItem[] }
}

function expandHome(p: string): string {
  // 兼容 ASCII ~ 与全角 ～（U+FF5E，手机输入法常见）
  const normalized = p.replace(/^～/, '~')
  if (normalized === '~') return os.homedir()
  if (normalized.startsWith('~/')) return os.homedir() + normalized.slice(1)
  return normalized
}

function truncate(s: string, max: number): string {
  const t = s.replace(/\s+$/g, '')
  return t.length > max ? t.slice(0, max) + '…' : t
}

export class Gateway {
  private readonly router = new CommandRouter()
  private readonly tasks = new TaskManager()
  private readonly peers = new Map<string, PeerState>()

  constructor(private readonly deps: GatewayDeps) {}

  async handleMessage(msg: IncomingMessage): Promise<void> {
    if (msg.type !== 'text') {
      await this.deps.bot.reply(msg, `🤷 暂不支持 ${msg.type}（仅文本）`)
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
    const modelMap: Record<string, string[]> = {}
    const effortMap: Record<string, string[]> = {}
    for (const [name, adapter] of Object.entries(this.deps.adapters)) {
      modelMap[name] = await adapter.listModels()
      effortMap[name] = (await adapter.listEfforts?.()) ?? []
    }
    const ctx = {
      backend: session.backend,
      model: session.model,
      variant: session.variant,
      verbose: session.verbose,
      workdir: session.workspace ?? this.deps.workspace ?? '(未设置，用 /workdir 指定）',
      recentWorkdirs: session.recentWorkdirs ?? [],
      backends: Object.keys(this.deps.adapters),
      modelsOf: (b: string) => modelMap[b] ?? [],
      effortsOf: (b: string, _model?: string) => effortMap[b] ?? [],
      modelListNote: this.deps.adapters[session.backend]?.modelListNote?.(),
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

    // /resume 需要 adapter 的异步 session 列表，由 gateway 直接处理
    if (text === '/resume') {
      state.menu = undefined
      await this.handleResume(msg, session, state, ctx.taskActive)
      return
    }

    // /history [N] 需要 adapter 的异步历史读取，由 gateway 直接处理
    const historyMatch = /^\/history(?:\s+(\d+))?$/.exec(text)
    if (historyMatch) {
      state.menu = undefined
      await this.handleHistory(msg, session, historyMatch[1] ? Number(historyMatch[1]) : 1)
      return
    }

    // 其他命令：旧菜单静默作废
    state.menu = undefined
    const out = this.router.handle(text, ctx)
    state.menu = out.menu
    await this.applyOutput(msg, session, out)
  }

  private async handleResume(
    msg: IncomingMessage,
    session: GatewaySession,
    state: PeerState,
    taskActive: boolean,
  ): Promise<void> {
    if (taskActive) {
      await this.deps.bot.reply(msg, '⏳ 任务运行中，/cancel 取消')
      return
    }
    const adapter = this.deps.adapters[session.backend]
    if (!adapter?.listSessions) {
      await this.deps.bot.reply(msg, `${session.backend} 不支持 session 列表`)
      return
    }
    const workspace = session.workspace ?? this.deps.workspace
    if (!workspace) {
      await this.deps.bot.reply(msg, '📂 先 /workdir <路径> 设置目录（支持 ~）')
      return
    }
    let sessions
    try {
      sessions = await adapter.listSessions(workspace)
    } catch (err) {
      await this.deps.bot.reply(msg, `❌ 获取 session 列表失败：${(err as Error).message}`)
      return
    }
    if (sessions.length === 0) {
      await this.deps.bot.reply(msg, `📭 当前目录没有可恢复的 ${session.backend} session`)
      return
    }
    const current = session.nativeSessionIds[session.backend]
    const lines = sessions.map((s, i) => `/${i + 1} ${s.title}${s.id === current ? '（当前）' : ''}`)
    state.menu = {
      items: sessions.map((s) => ({
        label: s.title,
        set: { nativeSessionId: s.id },
      })),
    }
    await this.deps.bot.reply(msg, `🔁 恢复 ${session.backend} session：\n\n${lines.join('\n\n')}\n\n/0 ✋ 取消`)
  }

  private async handleHistory(msg: IncomingMessage, session: GatewaySession, turns: number): Promise<void> {
    const adapter = this.deps.adapters[session.backend]
    const nativeId = session.nativeSessionIds[session.backend]
    if (!nativeId) {
      await this.deps.bot.reply(msg, `📭 当前 ${session.backend} 还没有 session，先发一条消息`)
      return
    }
    if (!adapter?.listHistory) {
      await this.deps.bot.reply(msg, `❓ ${session.backend} 不支持历史`)
      return
    }
    const workspace = session.workspace ?? this.deps.workspace
    if (!workspace) {
      await this.deps.bot.reply(msg, '📂 先 /workdir 设置目录')
      return
    }
    const n = Math.min(Math.max(1, turns), 10)
    let pairs
    try {
      pairs = await adapter.listHistory(nativeId, workspace, n)
    } catch (err) {
      await this.deps.bot.reply(msg, `❌ 读取历史失败：${(err as Error).message}`)
      return
    }
    if (pairs.length === 0) {
      await this.deps.bot.reply(msg, '📭 当前 session 无记录')
      return
    }
    const body = pairs
      .map((p) => `Q: ${truncate(p.user, 300)}\n\nA: ${truncate(p.assistant, 800)}`)
      .join('\n\n———\n\n')
    await this.deps.bot.reply(msg, `📜 最近 ${pairs.length} 轮（${session.backend}）\n\n———\n\n${body}`)
  }

  private async applyOutput(
    msg: IncomingMessage,
    session: GatewaySession,
    out: {
      replies: string[]
      set?: {
        backend?: string
        model?: string
        variant?: string
        verbose?: string
        workspace?: string
        nativeSessionId?: string
        resetNativeSession?: boolean
      }
    },
  ): Promise<void> {
    if (out.set?.workspace) {
      // ~ 展开 + 存在性校验；切换目录时清空 native session（旧目录 session 在新目录恢复会跑错位置）
      const expanded = expandHome(out.set.workspace)
      const valid = await stat(expanded).then((s) => s.isDirectory()).catch(() => false)
      if (!valid) {
        await this.deps.bot.reply(msg, `❌ 目录不存在：${expanded}`)
        return
      }
      session.workspace = expanded
      session.nativeSessionIds = {}
      const recent = [expanded, ...(session.recentWorkdirs ?? []).filter((d) => d !== expanded)]
      session.recentWorkdirs = recent.slice(0, 5)
      out.replies = out.replies.map((r) => r.replace(out.set!.workspace!, expanded) + '\n\n（session 已清空，/resume 恢复该目录）')
    }
    if (out.set?.backend && out.set.backend !== session.backend) {
      session.backend = out.set.backend
      // 切换 backend 时重置 model/variant（不同 backend 的取值集合不同）
      session.model = this.deps.adapters[session.backend]?.defaultModel()
      session.variant = undefined
    }
    if (out.set?.model) session.model = out.set.model
    if (out.set?.variant) session.variant = out.set.variant
    if (out.set?.verbose) session.verbose = out.set.verbose as VerboseLevel
    if (out.set?.resetNativeSession) delete session.nativeSessionIds[session.backend]
    if (out.set?.nativeSessionId) session.nativeSessionIds[session.backend] = out.set.nativeSessionId
    if (out.set) await this.deps.store.save(session)
    for (const reply of out.replies) await this.deps.bot.reply(msg, reply)
  }

  private async runTask(msg: IncomingMessage, session: GatewaySession): Promise<void> {
    const adapter = this.deps.adapters[session.backend]
    if (!adapter) {
      await this.deps.bot.reply(msg, `❓ 未知 backend ${session.backend}`)
      return
    }
    if (this.tasks.activeOf(msg.userId)) {
      await this.deps.bot.reply(msg, '⏳ 任务运行中，/cancel 取消')
      return
    }

    const workspace = session.workspace ?? this.deps.workspace
    if (!workspace) {
      await this.deps.bot.reply(msg, '📂 先 /workdir <路径> 设置目录（支持 ~）')
      return
    }
    // 持久化"最后一次使用的 workspace"（重启恢复现场），并记入最近列表
    if (session.workspace !== workspace) {
      session.workspace = workspace
      session.recentWorkdirs = [workspace, ...(session.recentWorkdirs ?? []).filter((d) => d !== workspace)].slice(0, 5)
      await this.deps.store.save(session)
    }
    const run = await this.tasks.start(msg.userId, adapter, {
      prompt: msg.text,
      workspace,
      model: session.model,
      effort: session.variant,
      nativeSessionId: session.nativeSessionIds[session.backend],
    })

    await this.deps.bot.reply(msg, `🚀 ${session.backend}${session.model ? ` · ${session.model}` : ''}${session.variant ? ` · ${session.variant}` : ''}`)

    // 事件消费：进度按 verbose 档位分流；错误始终透传；summary/detail 以 500ms 窗口合并防止轰炸
    const userId = msg.userId
    const startedAt = Date.now()
    const verbose = session.verbose ?? 'heartbeat'
    let progressCount = 0
    let lastAction = ''

    let pendingLines: string[] = []
    let flushTimer: NodeJS.Timeout | undefined
    let lastFlushAt = 0
    const FLUSH_COALESCE_MS = 500
    const MIN_FLUSH_INTERVAL_MS = 30_000
    const MAX_FLUSH_LINES = 10
    const flush = async () => {
      flushTimer = undefined
      if (pendingLines.length === 0) return
      let lines = pendingLines
      pendingLines = []
      const omitted = lines.length - MAX_FLUSH_LINES
      if (omitted > 0) {
        lines = [...lines.slice(0, MAX_FLUSH_LINES), `…（本次合并省略 ${omitted} 条）`]
      }
      lastFlushAt = Date.now()
      await this.deps.bot.send(userId, lines.join('\n')).catch((err) => console.error('progress send failed:', err))
    }
    const enqueue = (line: string) => {
      pendingLines.push(line)
      if (flushTimer) return
      const wait = Math.max(FLUSH_COALESCE_MS, MIN_FLUSH_INTERVAL_MS - (Date.now() - lastFlushAt))
      flushTimer = setTimeout(() => void flush(), wait)
    }

    const consume = (async () => {
      for await (const e of run.task.events) {
        if (e.type === 'progress') {
          progressCount++
          lastAction = e.message
          if (verbose === 'summary') enqueue(`· ${e.message}`)
          else if (verbose === 'detail') enqueue(`[progress] ${e.message}`)
        } else if (e.type === 'error') {
          await this.deps.bot.send(userId, `⚠️ ${e.message}`).catch((err) => console.error('error notify failed:', err))
        } else if (e.type === 'text') {
          // 中间过程文本（模型逐步输出）：summary 档发一行摘要，detail 档发截断内容
          if (verbose === 'summary') {
            const brief = e.text.replace(/\s+/g, ' ').trim()
            enqueue(`✎ ${brief.slice(0, 120)}${brief.length > 120 ? '…' : ''}`)
          } else if (verbose === 'detail') {
            enqueue(`[text] ${e.text.slice(0, 500)}`)
          }
        }
      }
    })()

    const heartbeat =
      verbose === 'heartbeat'
        ? setInterval(() => {
            const mins = Math.max(1, Math.round((Date.now() - startedAt) / 60_000))
            const text = `⏳ ${mins} 分钟 · ${progressCount} 步\n\n🔧 ${lastAction || '等待模型输出'}\n\n✋ /cancel`
            this.deps.bot.send(userId, text).catch((err) => console.error('heartbeat send failed:', err))
          }, this.deps.heartbeatMs)
        : undefined

    const result = await run.done
    if (heartbeat) clearInterval(heartbeat)
    if (flushTimer) clearTimeout(flushTimer)
    await consume.catch(() => {})
    await flush()
    if (result.nativeSessionId) {
      session.nativeSessionIds[session.backend] = result.nativeSessionId
      await this.deps.store.save(session)
    }
    if (result.ok) {
      await this.deps.bot.send(msg.userId, result.finalText || '✅ 完成（无文本输出）')
    } else {
      await this.deps.bot.send(msg.userId, `❌ ${result.error ?? '未知错误'}`)
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

  /** 面板状态查询（StatusServer 数据源）。 */
  async getStatus(accountId: string | undefined, uptimeSec: number): Promise<{
    ok: boolean
    accountId?: string
    uptimeSec: number
    peers: {
      peer: string
      backend: string
      model?: string
      variant?: string
      workdir?: string
      taskActive: boolean
    }[]
  }> {
    const sessions = await this.deps.store.list()
    return {
      ok: true,
      accountId,
      uptimeSec: Math.round(uptimeSec),
      peers: sessions.map((s) => ({
        peer: s.wechatPeer,
        backend: s.backend,
        model: s.model,
        variant: s.variant,
        workdir: s.workspace ?? this.deps.workspace,
        taskActive: this.tasks.activeOf(s.wechatPeer) !== undefined,
      })),
    }
  }
}
