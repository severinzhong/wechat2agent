export interface CommandContext {
  backend: string
  model?: string
  variant?: string
  verbose?: string
  /** 当前生效的 workdir */
  workdir: string
  /** 最近使用的 workdir（新→旧） */
  recentWorkdirs: string[]
  backends: string[]
  modelsOf: (backend: string) => string[]
  effortsOf: (backend: string, model?: string) => string[]
  /** 模型列表的附加说明（如缓存过期提示） */
  modelListNote?: string
  taskActive: boolean
}

export interface CommandOutput {
  replies: string[]
  /** 会话状态变更请求（由 gateway 应用到 session store） */
  set?: {
    backend?: string
    model?: string
    variant?: string
    verbose?: string
    /** 切换 workdir（gateway 负责 ~ 展开与存在性校验） */
    workspace?: string
    /** 恢复指定 native session（/resume 菜单选择） */
    nativeSessionId?: string
    /** 清除当前 backend 的 native session（/new） */
    resetNativeSession?: boolean
  }
  /** 输出的待选菜单（gateway 保存到会话） */
  menu?: { items: MenuItem[] }
}

export interface MenuItem {
  label: string
  /** 选择后的效果描述为 set 请求 */
  set: {
    backend?: string
    model?: string
    variant?: string
    verbose?: string
    workspace?: string
    nativeSessionId?: string
    resetNativeSession?: boolean
  }
  /** 受任务互斥保护 */
  guardedByTask?: boolean
}

export const VERBOSE_LEVELS = ['none', 'heartbeat', 'summary', 'detail'] as const

const VERBOSE_LABELS: Record<string, string> = {
  none: '仅结果',
  heartbeat: '心跳',
  summary: '摘要',
  detail: '详情',
}

const HELP = `🔀 /backend [名] 切换后端

🧠 /model [名] 模型 · ⚡ /effort [级] 推理强度

📂 /workdir [路径] 工作目录 · 🔁 /new 新会话 · /resume 恢复

📜 /history [N] 最近 N 轮 · 📢 /verbose 过程反馈

✋ /cancel 取消任务

菜单 /1 /2…选择 · /0 取消`

export class CommandRouter {
  handle(input: string, ctx: CommandContext): CommandOutput {
    const [cmd, ...args] = input.trim().split(/\s+/)

    const num = /^\/(\d+)$/.exec(cmd ?? '')
    if (num) return { replies: ['❓ 没有待选择的菜单 · /help 查看命令'] } // 由 gateway 在有菜单时先行处理

    switch (cmd) {
      case '/help':
        return { replies: [HELP] }
      case '/status':
        return {
          replies: [
            `📊 ${ctx.backend}${ctx.model ? ` · ${ctx.model}` : ''}${ctx.variant ? ` · ${ctx.variant}` : ''}\n\n📂 ${ctx.workdir}\n\n📢 ${ctx.verbose ?? 'heartbeat'} · ${ctx.taskActive ? '⏳ 任务运行中' : '💤 空闲'}`,
          ],
        }
      case '/backend':
        if (args[0]) return this.applyBackend(args[0], ctx)
        return {
          replies: [
            menuText('🔀 backend', ctx.backends.map((b) => b + (b === ctx.backend ? ' ←' : ''))),
          ],
          menu: {
            items: ctx.backends.map((b) => ({
              label: b,
              set: { backend: b },
              guardedByTask: true,
            })),
          },
        }
      case '/model': {
        if (args[0]) return this.applyModel(args[0], ctx)
        const models = ctx.modelsOf(ctx.backend)
        if (models.length === 0) {
          return {
            replies: [`🧠 ${ctx.backend} 模型不可枚举\n\n当前: ${ctx.model ?? '默认'}\n\n直写 /model <名称>`],
          }
        }
        return {
          replies: [menuText(`切换 model（${ctx.backend}）${ctx.modelListNote ? `\n${ctx.modelListNote}` : ''}`, models)],
          menu: {
            items: models.map((m) => ({ label: m, set: { model: m } })),
          },
        }
      }
      case '/effort': {
        if (args[0]) return this.applyEffort(args[0], ctx)
        const efforts = ctx.effortsOf(ctx.backend, ctx.model)
        if (efforts.length === 0) {
          return {
            replies: [`⚡ ${ctx.backend} 推理强度不可枚举\n\n当前: ${ctx.variant ?? '默认'}\n\n直写 /effort <等级>`],
          }
        }
        return {
          replies: [menuText(`⚡ effort（${ctx.backend}）`, efforts)],
          menu: {
            items: efforts.map((e) => ({ label: e, set: { variant: e } })),
          },
        }
      }
      case '/verbose': {
        const current = ctx.verbose ?? 'heartbeat'
        if (args[0]) {
          if (!(VERBOSE_LEVELS as readonly string[]).includes(args[0])) {
            return { replies: [`❓ 未知档位 ${args[0]}（${VERBOSE_LEVELS.join(' / ')}）`] }
          }
          return { replies: [`✅ verbose → ${args[0]}`], set: { verbose: args[0] } }
        }
        return {
          replies: [menuText('📢 verbose', VERBOSE_LEVELS.map((v) => `${v} ${VERBOSE_LABELS[v]}${v === current ? ' ←' : ''}`))],
          menu: {
            items: VERBOSE_LEVELS.map((v) => ({ label: v, set: { verbose: v } })),
          },
        }
      }
      case '/workdir': {
        if (ctx.taskActive) return { replies: ['⏳ 任务运行中，先 /cancel'] }
        if (args[0]) {
          return { replies: [`📂 workdir → ${args[0]}`], set: { workspace: args[0] } }
        }
        const recent = ctx.recentWorkdirs
        if (recent.length === 0) {
          return { replies: [`📂 当前：${ctx.workdir}\n\n无历史目录，直写 /workdir <路径>（支持 ~）`] }
        }
        return {
          replies: [
            menuText(
              `📂 workdir（当前：${ctx.workdir}）`,
              recent.map((d) => d + (d === ctx.workdir ? ' ←' : '')),
            ),
          ],
          menu: {
            items: recent.map((d) => ({ label: d, set: { workspace: d }, guardedByTask: true })),
          },
        }
      }
      case '/new': {
        if (ctx.taskActive) return { replies: ['⏳ 任务运行中，先 /cancel'] }
        return {
          replies: [`🔁 新会话（${ctx.backend} 上下文已清空）`],
          set: { resetNativeSession: true },
        }
      }
      case '/cancel':
        return { replies: [ctx.taskActive ? '✋ 任务已取消' : '💤 没有运行中的任务'] }
      default:
        return { replies: [`❓ 未知命令 ${cmd} · /help`] }
    }
  }

  /** 菜单数字选择（gateway 在持有菜单时调用）。 */
  resolveMenu(choice: number, menu: { items: MenuItem[] }, ctx: CommandContext): CommandOutput {
    if (choice === 0) return { replies: ['✋ 已取消'] }
    const item = menu.items[choice - 1]
    if (!item) return { replies: ['❓ 无效选项，菜单已取消'] }
    if (item.guardedByTask && ctx.taskActive) return { replies: ['⏳ 任务运行中，先 /cancel'] }
    if (item.set.nativeSessionId) {
      return { replies: [`🔁 已恢复：${item.label}`], set: item.set }
    }
    if (item.set.workspace) {
      return { replies: [`📂 workdir → ${item.set.workspace}`], set: item.set }
    }
    const desc = item.set.backend ?? item.set.model ?? item.set.variant ?? item.set.verbose ?? ''
    return { replies: [`✅ → ${desc}`], set: item.set }
  }

  private applyEffort(name: string, ctx: CommandContext): CommandOutput {
    const efforts = ctx.effortsOf(ctx.backend, ctx.model)
    if (efforts.length > 0 && !efforts.includes(name)) {
      return { replies: [`❓ 未知 effort ${name}\n\n可选：\n\n${efforts.join('\n\n')}`] }
    }
    return { replies: [`✅ effort → ${name}`], set: { variant: name } }
  }

  private applyBackend(name: string, ctx: CommandContext): CommandOutput {
    if (!ctx.backends.includes(name)) {
      return { replies: [`❓ 未知 backend ${name}（${ctx.backends.join(' / ')}）`] }
    }
    if (ctx.taskActive) return { replies: ['⏳ 任务运行中，先 /cancel'] }
    if (name === ctx.backend) return { replies: [`✔️ 已在 ${name}`] }
    return { replies: [`✅ backend → ${name}`], set: { backend: name } }
  }

  private applyModel(name: string, ctx: CommandContext): CommandOutput {
    const models = ctx.modelsOf(ctx.backend)
    if (models.length > 0 && !models.includes(name)) {
      // 枚举列表可能过期（如 codex models_cache.json），列表外模型软警告后允许直写
      return {
        replies: [`⚠️ ${name} 不在枚举（缓存可能过期）\n\n✅ model → ${name}`],
        set: { model: name },
      }
    }
    return { replies: [`✅ model → ${name}`], set: { model: name } }
  }
}

function menuText(title: string, labels: string[]): string {
  const lines = labels.map((label, i) => `/${i + 1} ${label}`)
  return `${title}\n\n${lines.join('\n\n')}\n\n/0 ✋ 取消`
}
