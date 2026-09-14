import { describe, it, expect } from 'vitest'
import { CodexAdapter } from '../src/adapters/codex.js'

// liveness 集成测试：用一个永远挂起、不产生任何输出的假 bin，
// 注入极小的 noEventMs，验证超时后产生 error 事件且任务以失败结束。
describe('adapter liveness', () => {
  it('emits error and fails when no events arrive within noEventMs', async () => {
    const adapter = new CodexAdapter({ bin: '/bin/sleep', sandbox: 'read-only', noEventMs: 1_500 })
    const task = await adapter.startTask({ prompt: 'x', workspace: '/tmp' })

    const events: string[] = []
    const consumer = (async () => {
      for await (const e of task.events) events.push(e.type)
    })()

    const result = await task.done
    await consumer

    expect(result.ok).toBe(false)
    expect(events).toContain('error')
  }, 30_000)
})
