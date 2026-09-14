export interface CommandContext {
  backend: string
  model?: string
  variant?: string
  verbose?: string
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
  set?: { backend?: string; model?: string; variant?: string; verbose?: string }
  /** 输出的待选菜单（gateway 保存到会话） */
  menu?: { items: MenuItem[] }
}

export interface MenuItem {
  label: string
  /** 选择后的效果描述为 set 请求 */
  set: { backend?: string; model?: string; variant?: string; verbose?: string }
  /** 受任务互斥保护 */
  guardedByTask?: boolean
}

export const VERBOSE_LEVELS = ['none', 'heartbeat', 'summary', 'detail'] as const

const VERBOSE_LABELS: Record<string, string> = {
  none: '无（仅最终结果）',
  heartbeat: '心跳（定期汇报进度）',
  summary: '摘要（每个事件一行，节流合并）',
  detail: '详情（每个事件内容，截断节流）',
}

const HELP = `可用命令：
/help — 显示本帮助
/status — 查看当前 backend、model、effort、verbose、任务状态
/backend [名称] — 切换 backend
/model [名称] — 切换 model
/effort [等级] — 切换推理强度（codex: reasoning effort，zl: variant）
/verbose [none|heartbeat|summary|detail] — 过程反馈档位
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
            `当前状态\nbackend: ${ctx.backend}\nmodel: ${ctx.model ?? '(默认)'}\neffort: ${ctx.variant ?? '(默认)'}\nverbose: ${ctx.verbose ?? 'heartbeat'}\n任务: ${ctx.taskActive ? '运行中' : '无'}`,
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
      case '/model': {
        if (args[0]) return this.applyModel(args[0], ctx)
        const models = ctx.modelsOf(ctx.backend)
        if (models.length === 0) {
          return {
            replies: [`${ctx.backend} 不提供模型枚举。\n当前: ${ctx.model ?? '(backend 默认)'}\n可直写 /model <名称> 指定`],
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
            replies: [`${ctx.backend} 不提供推理强度枚举。\n当前: ${ctx.variant ?? '(backend 默认)'}\n可直写 /effort <等级>`],
          }
        }
        return {
          replies: [menuText(`切换 effort（${ctx.backend}）`, efforts)],
          menu: {
            items: efforts.map((e) => ({ label: e, set: { variant: e } })),
          },
        }
      }
      case '/verbose': {
        const current = ctx.verbose ?? 'heartbeat'
        if (args[0]) {
          if (!(VERBOSE_LEVELS as readonly string[]).includes(args[0])) {
            return { replies: [`未知档位: ${args[0]}（可选：${VERBOSE_LEVELS.join(' / ')}）`] }
          }
          return { replies: [`过程反馈已切换为 ${args[0]}（${VERBOSE_LABELS[args[0]]}）`], set: { verbose: args[0] } }
        }
        return {
          replies: [menuText('过程反馈档位', VERBOSE_LEVELS.map((v) => `${v} ${VERBOSE_LABELS[v]}${v === current ? '（当前）' : ''}`))],
          menu: {
            items: VERBOSE_LEVELS.map((v) => ({ label: v, set: { verbose: v } })),
          },
        }
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
    const desc = item.set.backend ?? item.set.model ?? item.set.variant ?? item.set.verbose ?? ''
    return { replies: [`已切换到 ${desc}`], set: item.set }
  }

  private applyEffort(name: string, ctx: CommandContext): CommandOutput {
    const efforts = ctx.effortsOf(ctx.backend, ctx.model)
    if (efforts.length > 0 && !efforts.includes(name)) {
      return { replies: [`未知 effort: ${name}\n当前 backend（${ctx.backend}）可选：\n${efforts.join('\n')}`] }
    }
    return { replies: [`effort 已切换为 ${name}`], set: { variant: name } }
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
    if (models.length > 0 && !models.includes(name)) {
      // 枚举列表可能过期（如 codex models_cache.json），列表外模型软警告后允许直写
      return {
        replies: [`注意: ${name} 不在枚举列表中（缓存可能过期），将尝试使用\nmodel 已切换为 ${name}`],
        set: { model: name },
      }
    }
    return { replies: [`model 已切换为 ${name}`], set: { model: name } }
  }
}

function menuText(title: string, labels: string[]): string {
  const lines = labels.map((label, i) => `/${i + 1} ${label}`)
  return `${title}\n${lines.join('\n')}\n/0 取消`
}
