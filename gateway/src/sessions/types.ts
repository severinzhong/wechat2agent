/** 过程反馈档位：none 仅最终结果；heartbeat 定期汇报；summary 每事件一行摘要（节流合并）；detail 每事件详情（截断+节流） */
export type VerboseLevel = 'none' | 'heartbeat' | 'summary' | 'detail'

export interface GatewaySession {
  wechatPeer: string
  backend: string
  model?: string
  /** 推理强度（codex → model_reasoning_effort，zl → --variant）；undefined 用 backend 默认 */
  variant?: string
  /** 过程反馈档位，默认 heartbeat */
  verbose?: VerboseLevel
  /** 覆盖 gateway 默认 workspace 的目录（绝对路径） */
  workspace?: string
  /** 最近使用过的 workdir（新→旧，最多 5 个） */
  recentWorkdirs?: string[]
  /** backend name -> native session id（同 backend 续接用；跨 backend 不迁移） */
  nativeSessionIds: Record<string, string>
  updatedAt: string
}

export interface SessionStore {
  load(peer: string): Promise<GatewaySession | undefined>
  save(session: GatewaySession): Promise<void>
}
