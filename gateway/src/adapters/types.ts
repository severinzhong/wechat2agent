/** 规范化任务事件。adapter 把 backend 原生事件流映射为该模型，网关不感知 backend 内部结构。 */
export type TaskEvent =
  | { type: 'text'; text: string }        // agent 产出的文本片段
  | { type: 'progress'; message: string } // 非致命进度信息（如流重连）
  | { type: 'error'; message: string }    // 致命错误

export interface TaskResult {
  ok: boolean
  /** 汇总的最终回复文本（用于微信回复） */
  finalText: string
  /** backend 原生 session id（续接用） */
  nativeSessionId?: string
  error?: string
}

export interface RunningTask {
  /** gateway 侧任务 id */
  readonly id: string
  readonly events: AsyncIterable<TaskEvent>
  readonly done: Promise<TaskResult>
  cancel(): Promise<void>
}

export interface StartTaskInput {
  prompt: string
  workspace: string
  model?: string
  /** 同 backend 原生续接；跨 backend 不迁移 */
  nativeSessionId?: string
}

export interface BackendAdapter {
  readonly name: string
  startTask(input: StartTaskInput): Promise<RunningTask>
  listModels(): Promise<string[]>
  defaultModel(): string
}
