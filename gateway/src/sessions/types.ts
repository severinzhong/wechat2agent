export interface GatewaySession {
  wechatPeer: string
  backend: string
  model?: string
  /** 推理强度（codex → model_reasoning_effort，zl → --variant）；undefined 用 backend 默认 */
  variant?: string
  /** backend name -> native session id（同 backend 续接用；跨 backend 不迁移） */
  nativeSessionIds: Record<string, string>
  updatedAt: string
}

export interface SessionStore {
  load(peer: string): Promise<GatewaySession | undefined>
  save(session: GatewaySession): Promise<void>
}
