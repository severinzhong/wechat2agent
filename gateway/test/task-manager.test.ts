import { describe, it, expect } from 'vitest'
import { TaskManager } from '../src/tasks/manager.js'
import type { BackendAdapter, RunningTask, TaskEvent } from '../src/adapters/types.js'

function fakeTask(events: TaskEvent[], result: { ok: boolean; finalText: string; nativeSessionId?: string }): RunningTask {
  return {
    id: 'task-1',
    events: (async function* () { for (const e of events) yield e })(),
    done: Promise.resolve(result),
    cancel: async () => {},
  }
}

function fakeAdapter(overrides: Partial<BackendAdapter> = {}): BackendAdapter {
  return {
    name: 'fake',
    listModels: async () => ['m1'],
    defaultModel: () => 'm1',
    startTask: async () => fakeTask(
      [{ type: 'text', text: 'hello' }],
      { ok: true, finalText: 'hello', nativeSessionId: 'native-1' },
    ),
    ...overrides,
  }
}

describe('TaskManager', () => {
  it('runs a task to completion and reports final text', async () => {
    const mgr = new TaskManager()
    const run = await mgr.start('peer1', fakeAdapter(), { prompt: 'hi', workspace: '/tmp' })
    const result = await run.done
    expect(result.ok).toBe(true)
    expect(result.finalText).toBe('hello')
    expect(mgr.activeOf('peer1')).toBeUndefined()
  })

  it('exposes native session id after completion', async () => {
    const mgr = new TaskManager()
    const run = await mgr.start('peer1', fakeAdapter(), { prompt: 'hi', workspace: '/tmp' })
    const result = await run.done
    expect(result.nativeSessionId).toBe('native-1')
  })

  it('cancels the active task', async () => {
    let cancelled = false
    const adapter = fakeAdapter({
      startTask: async () => ({
        id: 'task-x',
        events: (async function* () {})(),
        done: new Promise(() => {}), // never resolves
        cancel: async () => { cancelled = true },
      }),
    })
    const mgr = new TaskManager()
    await mgr.start('peer1', adapter, { prompt: 'hi', workspace: '/tmp' })
    expect(mgr.activeOf('peer1')).toBeDefined()
    await mgr.cancel('peer1')
    expect(cancelled).toBe(true)
    expect(mgr.activeOf('peer1')).toBeUndefined()
  })

  it('rejects a second task while one is active', async () => {
    const adapter = fakeAdapter({
      startTask: async () => ({
        id: 'task-y',
        events: (async function* () {})(),
        done: new Promise(() => {}),
        cancel: async () => {},
      }),
    })
    const mgr = new TaskManager()
    await mgr.start('peer1', adapter, { prompt: 'hi', workspace: '/tmp' })
    await expect(mgr.start('peer1', adapter, { prompt: 'again', workspace: '/tmp' }))
      .rejects.toThrow('任务进行中')
  })
})
