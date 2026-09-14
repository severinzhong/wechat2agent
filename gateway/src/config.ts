import path from 'node:path'

export interface GatewayConfig {
  /** iLink 凭证与 gateway 状态存储目录 */
  storageDir: string
  /** 唯一允许的 workspace 白名单目录 */
  workspace: string
  defaultBackend: string
  logLevel: 'debug' | 'info' | 'warn' | 'error' | 'silent'
  /** 长任务进度心跳间隔（毫秒），默认 120s */
  heartbeatMs: number
}

export function loadConfig(): GatewayConfig {
  return {
    storageDir: process.env.GATEWAY_STORAGE_DIR ?? path.join(process.cwd(), '.storage'),
    workspace: process.env.GATEWAY_WORKSPACE ?? process.cwd(),
    defaultBackend: process.env.GATEWAY_BACKEND ?? 'codex',
    logLevel: (process.env.LOG_LEVEL as GatewayConfig['logLevel']) ?? 'info',
    heartbeatMs: Number(process.env.GATEWAY_HEARTBEAT_MS) || 120_000,
  }
}
