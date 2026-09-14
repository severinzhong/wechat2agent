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
  /** 推理强度：codex 映射为 model_reasoning_effort，zl 映射为 --variant */
  effort?: string
  /** 同 backend 原生续接；跨 backend 不迁移 */
  nativeSessionId?: string
}

export interface BackendAdapter {
  readonly name: string
  startTask(input: StartTaskInput): Promise<RunningTask>
  listModels(): Promise<string[]>
  /** undefined 表示不显式传模型参数，使用 backend 自身默认 */
  defaultModel(): string | undefined
  /** 当前（或指定）模型支持的推理强度列表；不支持枚举时返回空数组 */
  listEfforts?(model?: string): Promise<string[]>
  /** 模型列表的附加说明（如缓存日期），展示在 /model 菜单中 */
  modelListNote?(): string | undefined
}

/** adapter 可选的生命周期钩子（网关注入，用于基础设施异常通知） */
export interface AdapterHooks {
  /** 底层服务进程异常退出（如 zl serve 被杀） */
  onServeDead?(message: string): void
}

/** 任务的 liveness 兜底：连续无事件超过该毫秒数即报错（默认 5 分钟） */
export const NO_EVENT_TIMEOUT_MS = 300_000
