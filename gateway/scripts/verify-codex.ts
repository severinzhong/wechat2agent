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
