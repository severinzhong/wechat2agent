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
