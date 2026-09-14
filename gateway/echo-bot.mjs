import { WeChatBot } from '@wechatbot/wechatbot'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.dirname(fileURLToPath(import.meta.url))
const STORAGE_DIR = process.env.GATEWAY_STORAGE_DIR ?? path.join(ROOT, '.storage')

// ── 模拟的 backend/model 注册表（真实 adapter 接入后替换） ─────────────
const BACKENDS = {
  codex: ['gpt-5.2', 'gpt-5.2-codex'],
  zl: ['zhanlu/qwen3.7-max', 'zhanlu/glm-5.2'],
}
const DEFAULT_BACKEND = 'codex'

// ── 会话状态（per wechat peer，内存实现；后续迁移 session store） ──────
// { backend, model, task: { startedAt, timer } | null, menu: { kind, items } | null }
const sessions = new Map()

function getSession(userId) {
  if (!sessions.has(userId)) {
    sessions.set(userId, {
      backend: DEFAULT_BACKEND,
      model: BACKENDS[DEFAULT_BACKEND][0],
      task: null,
      menu: null,
    })
  }
  return sessions.get(userId)
}

// ── 命令实现 ────────────────────────────────────────────────────────────

const HELP_TEXT = `可用命令：
/help — 显示本帮助
/status — 查看当前 backend、model、任务状态
/backend [名称] — 切换 backend（codex / zl）
/model [名称] — 切换 model
/demo — 启动 30s 模拟任务（演示任务互斥与主动通知）
/cancel — 取消当前任务
菜单选择：回复 /1、/2…选择，/0 取消`

function formatStatus(session) {
  const taskDesc = session.task
    ? `运行中（${Math.round((Date.now() - session.task.startedAt) / 1000)}s）`
    : '无'
  return `当前状态
backend: ${session.backend}
model: ${session.model}
任务: ${taskDesc}`
}

function menuText(title, items) {
  const lines = items.map((item, i) => `/${i + 1} ${item.label}`)
  return `${title}\n${lines.join('\n')}\n/0 取消`
}

async function handleBackendCommand(bot, msg, session, args) {
  const names = Object.keys(BACKENDS)
  if (args[0]) {
    return applyBackend(bot, msg, session, args[0])
  }
  const items = names.map((name) => ({
    label: name + (name === session.backend ? '（当前）' : ''),
    action: () => applyBackend(bot, msg, session, name),
  }))
  session.menu = { kind: 'backend', items }
  await bot.reply(msg, menuText('切换 backend', items))
}

async function applyBackend(bot, msg, session, name) {
  if (!BACKENDS[name]) {
    await bot.reply(msg, `未知 backend: ${name}（可选：${Object.keys(BACKENDS).join(' / ')}）`)
    return
  }
  if (session.task) {
    await bot.reply(msg, `任务进行中，请先 /cancel 再切换 backend`)
    return
  }
  if (name === session.backend) {
    await bot.reply(msg, `已在使用 ${name}`)
    return
  }
  session.backend = name
  session.model = BACKENDS[name][0]
  await bot.reply(msg, `已切换到 ${name}（model 重置为 ${session.model}）`)
}

async function handleModelCommand(bot, msg, session, args) {
  const models = BACKENDS[session.backend]
  if (args[0]) {
    return applyModel(bot, msg, session, args[0])
  }
  const items = models.map((m) => ({
    label: m + (m === session.model ? '（当前）' : ''),
    action: () => applyModel(bot, msg, session, m),
  }))
  session.menu = { kind: 'model', items }
  await bot.reply(msg, menuText(`切换 model（${session.backend}）`, items))
}

async function applyModel(bot, msg, session, name) {
  const models = BACKENDS[session.backend]
  if (!models.includes(name)) {
    await bot.reply(msg, `未知 model: ${name}\n当前 backend（${session.backend}）可选：\n${models.join('\n')}`)
    return
  }
  if (name === session.model) {
    await bot.reply(msg, `已在使用 ${name}`)
    return
  }
  session.model = name
  await bot.reply(msg, `model 已切换为 ${name}`)
}

async function handleCancel(bot, msg, session) {
  if (!session.task) {
    await bot.reply(msg, '当前没有运行中的任务')
    return
  }
  clearTimeout(session.task.timer)
  session.task = null
  await bot.reply(msg, '任务已取消')
}

async function handleDemo(bot, msg, session) {
  if (session.task) {
    await bot.reply(msg, '已有任务进行中，请先 /cancel')
    return
  }
  const userId = msg.userId
  const timer = setTimeout(async () => {
    session.task = null
    try {
      await bot.send(userId, '模拟任务完成（主动推送验证）')
    } catch (err) {
      console.error('demo notify failed:', err)
    }
  }, 30_000)
  session.task = { startedAt: Date.now(), timer }
  await bot.reply(msg, '模拟任务已启动（30s）。期间可正常发消息；/backend 会被拒绝；/cancel 可取消')
}

// ── 命令路由 ────────────────────────────────────────────────────────────

async function handleCommand(bot, msg, session, text) {
  const [cmd, ...args] = text.split(/\s+/)

  // 数字选择：消费当前菜单
  if (/^\/\d+$/.test(cmd)) {
    const n = Number(cmd.slice(1))
    const menu = session.menu
    session.menu = null
    if (!menu) {
      await bot.reply(msg, '当前没有待选择的菜单。/help 查看命令')
      return
    }
    if (n === 0) {
      await bot.reply(msg, '已取消')
      return
    }
    if (n < 1 || n > menu.items.length) {
      await bot.reply(msg, '无效选项，菜单已取消')
      return
    }
    await menu.items[n - 1].action()
    return
  }

  // 其他命令：旧菜单静默作废
  session.menu = null
  switch (cmd) {
    case '/help':
      await bot.reply(msg, HELP_TEXT)
      break
    case '/status':
      await bot.reply(msg, formatStatus(session))
      break
    case '/backend':
      await handleBackendCommand(bot, msg, session, args)
      break
    case '/model':
      await handleModelCommand(bot, msg, session, args)
      break
    case '/cancel':
      await handleCancel(bot, msg, session)
      break
    case '/demo':
      await handleDemo(bot, msg, session)
      break
    default:
      await bot.reply(msg, `未知命令: ${cmd}\n/help 查看可用命令`)
  }
}

// ── 登录（含 QR 轮询超时缺陷的重试包装，见 docs/decisions.md） ─────────

async function loginWithRetry(bot, retries = 3) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await bot.login({
        callbacks: {
          onQrUrl: (url) => console.log(`\n请用微信扫码登录:\n${url}\n`),
          onScanned: () => console.log('已扫码，请在微信中确认…'),
          onExpired: () => console.log('二维码过期，重新获取…'),
        },
      })
    } catch (err) {
      if (attempt >= retries) throw err
      console.warn(`登录第 ${attempt} 次失败（${err.message}），重试…`)
    }
  }
}

// ── 主入口 ──────────────────────────────────────────────────────────────

const bot = new WeChatBot({
  storage: 'file',
  storageDir: STORAGE_DIR,
  logLevel: process.env.LOG_LEVEL ?? 'info',
  botAgent: 'wechat2agent-gateway/0.1 (echo-bot)',
})

bot.onMessage(async (msg) => {
  if (msg.type !== 'text') {
    await bot.reply(msg, `收到 ${msg.type} 消息，echo bot 目前只处理文本`)
    return
  }
  const session = getSession(msg.userId)
  const text = msg.text.trim()

  if (text.startsWith('/')) {
    await handleCommand(bot, msg, session, text)
    return
  }

  // 非斜杠消息：菜单静默作废，进入正常（echo）流程
  session.menu = null
  await bot.sendTyping(msg.userId)
  await bot.reply(msg, `[${session.backend}/${session.model}] Echo: ${msg.text}`)
})

bot.on('session:expired', () => console.warn('会话过期，请重启并重新扫码'))
bot.on('error', (err) => console.error('bot error:', err))

process.on('SIGINT', () => {
  bot.stop()
  process.exit(0)
})

const creds = await loginWithRetry(bot)
console.log(`已登录: ${creds.accountId}（存储目录: ${STORAGE_DIR}）`)
await bot.start()
console.log('echo bot 运行中，/help 查看命令')
