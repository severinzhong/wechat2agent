import type { BackendAdapter, RunningTask, StartTaskInput, TaskResult } from '../adapters/types.js'

/** 每个 wechat peer 同时最多一个活动任务（Phase 1 无队列）。 */
export class TaskManager {
  private readonly active = new Map<string, RunningTask>()

  activeOf(peer: string): RunningTask | undefined {
    return this.active.get(peer)
  }

  async start(peer: string, adapter: BackendAdapter, input: StartTaskInput): Promise<{ task: RunningTask; done: Promise<TaskResult> }> {
    if (this.active.has(peer)) throw new Error('任务进行中，请先 /cancel')
    const task = await adapter.startTask(input)
    this.active.set(peer, task)
    const done = task.done.finally(() => {
      if (this.active.get(peer) === task) this.active.delete(peer)
    })
    return { task, done }
  }

  async cancel(peer: string): Promise<boolean> {
    const task = this.active.get(peer)
    if (!task) return false
    await task.cancel()
    this.active.delete(peer)
    return true
  }
}
