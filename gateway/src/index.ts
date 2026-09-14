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
  heartbeatMs: config.heartbeatMs,
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
