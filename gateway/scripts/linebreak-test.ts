import { WeChatBot } from '@wechatbot/wechatbot'
import path from 'node:path'
import os from 'node:os'

// 只读凭证 + 发送，不启动 poller（避免与运行中的 gateway 冲突）
const bot = new WeChatBot({
  storage: 'file',
  storageDir: path.join(os.homedir(), '.wechat2agent', 'ilink'),
  logLevel: 'error',
})
await bot.login()
const creds = bot.getCredentials()
const userId = creds!.userId

// start() 才会加载 context store；这里不启动 poller，运行时手动触发加载
await (bot as any).contextStore.load()

await bot.send(userId, 'A4 CRLF\\r\\n测试\r\n第二行\r\n第三行')
await bot.send(userId, 'A5 换行+行首零宽字符测试\n​第二行\n​第三行')
console.log('sent 2 test messages to', userId)
