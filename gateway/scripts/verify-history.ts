import { CodexAdapter } from '../src/adapters/codex.js'

const [sessionId, workspace] = process.argv.slice(2)
if (!sessionId || !workspace) {
  console.error('usage: tsx scripts/verify-history.ts <sessionId> <workspace>')
  process.exit(1)
}

const adapter = new CodexAdapter()
const turns = await adapter.listHistory(sessionId, workspace, 3)
console.log(`turns: ${turns.length}`)
for (const t of turns) {
  console.log('Q:', t.user.slice(0, 80))
  console.log('A:', t.assistant.slice(0, 80))
  console.log('---')
}
