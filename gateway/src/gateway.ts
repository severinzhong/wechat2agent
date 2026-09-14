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
    const modelMap: Record<string, string[]> = {}
    for (const [name, adapter] of Object.entries(this.deps.adapters)) {
      modelMap[name] = await adapter.listModels()
    }
    const ctx = {
      backend: session.backend,
      model: session.model,
      backends: Object.keys(this.deps.adapters),
      modelsOf: (b: string) => modelMap[b] ?? [],
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
