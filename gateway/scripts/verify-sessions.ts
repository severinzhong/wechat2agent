import { CodexAdapter } from '../src/adapters/codex.js'

const workspace = process.argv[2]!
const adapter = new CodexAdapter()
const sessions = await adapter.listSessions(workspace)
console.log(`workspace: ${workspace}`)
console.log(`found ${sessions.length} sessions:`)
for (const s of sessions) console.log('-', s.id.slice(0, 8), '|', s.title)
