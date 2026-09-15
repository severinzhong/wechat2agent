import { WeChatBot, createLogger } from '@wechatbot/wechatbot'
import path from 'node:path'
import { loadConfig } from './config.js'
import { acquireInstanceLock } from './lock.js'
import { GatewayLog, TeeTransport } from './log.js'
import { StatusServer } from './status-server.js'
import { FileSessionStore } from './sessions/file-store.js'
import { CodexAdapter } from './adapters/codex.js'
import { ZlAdapter, ZlServerManager } from './adapters/zl.js'
import { Gateway } from './gateway.js'

const config = loadConfig()

const gwLog = new GatewayLog(config.storageDir)
await gwLog.rotate()
gwLog.say('info', 'gateway 启动')

const releaseLock = await acquireInstanceLock(config.storageDir).catch((err: Error) => {
  gwLog.say('error', err.message)
  process.exit(1)
})

const bot = new WeChatBot({
  storage: 'file',
  storageDir: path.join(config.storageDir, 'ilink'),
  logger: createLogger({ level: config.logLevel, transport: new TeeTransport(gwLog) }),
  botAgent: 'wechat2agent-gateway/0.1',
})

const zlServer = new ZlServerManager()
const gateway = new Gateway({
  bot,
  store: new FileSessionStore(path.join(config.storageDir, 'sessions')),
  adapters: {
    codex: new CodexAdapter(),
    zl: new ZlAdapter(zlServer),
  },
  workspace: config.workspace,
  defaultBackend: config.defaultBackend,
  heartbeatMs: config.heartbeatMs,
})

bot.onMessage((msg) => {
  gateway.handleMessage(msg).catch((err) => {
    gwLog.say('error', `handleMessage failed: ${err}`)
  })
})
bot.on('session:expired', () => gwLog.say('error', 'iLink 会话过期，请重启并重新扫码'))
bot.on('error', (err) => gwLog.say('error', `bot error: ${err}`))

process.on('SIGINT', async () => {
  await zlServer.stop()
  bot.stop()
  await statusServer.stop()
  await releaseLock()
  process.exit(0)
})

process.on('SIGTERM', async () => {
  await zlServer.stop()
  bot.stop()
  await statusServer.stop()
  await releaseLock()
  process.exit(0)
})

async function loginWithRetry(retries = 3) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await bot.login({
        callbacks: {
          onQrUrl: (url) => gwLog.say('info', `请用微信扫码登录: ${url}`),
          onScanned: () => gwLog.say('info', '已扫码，请在微信中确认…'),
        },
      })
    } catch (err) {
      if (attempt >= retries) throw err
      gwLog.say('warn', `登录第 ${attempt} 次失败（${(err as Error).message}），重试…`)
    }
  }
}

const creds = await loginWithRetry()
gwLog.say('info', `已登录: ${creds.accountId}`)
gwLog.say('info', `默认 workspace: ${config.workspace ?? '(未设置)'}；日志: ${gwLog.file}`)

const startedAt = Date.now()
const statusServer = new StatusServer(config.storageDir, () =>
  gateway.getStatus(creds.accountId, (Date.now() - startedAt) / 1000),
)
await statusServer.start().then((port) => gwLog.say('info', `状态端点: http://127.0.0.1:${port}/status`))
await bot.start()
gwLog.say('info', 'gateway 运行中，/help 查看命令')
