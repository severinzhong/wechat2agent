import { ZlAdapter, ZlServerManager } from '../src/adapters/zl.js'
import { CodexAdapter } from '../src/adapters/codex.js'

const zl = new ZlAdapter(new ZlServerManager('/tmp'))
const codex = new CodexAdapter()

const zlModels = await zl.listModels()
console.log('zl models:', zlModels.slice(0, 5), `... 共 ${zlModels.length}`)
console.log('zl efforts:', await zl.listEfforts())
console.log('codex models:', await codex.listModels())
console.log('codex efforts(gpt-5.5):', await codex.listEfforts('gpt-5.5'))
console.log('codex defaultModel:', codex.defaultModel())
