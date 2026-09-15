import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { writeFile, rm } from 'node:fs/promises'
import path from 'node:path'

export interface GatewayStatus {
  ok: boolean
  accountId?: string
  uptimeSec: number
  peers: {
    peer: string
    backend: string
    model?: string
    variant?: string
    workdir?: string
    taskActive: boolean
  }[]
}

/**
 * loopback 状态端点（127.0.0.1，随机端口）。
 * 端口写入 <storageDir>/gateway.port 供菜单栏面板读取。
 * 无认证：仅监听 loopback，且只暴露只读状态。
 */
export class StatusServer {
  private server?: Server

  constructor(
    private readonly storageDir: string,
    private readonly getStatus: () => Promise<GatewayStatus>,
  ) {}

  async start(): Promise<number> {
    this.server = createServer((req, res) => {
      if (req.url === '/status' && req.method === 'GET') {
        this.getStatus()
          .then((status) => {
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify(status))
          })
          .catch((err) => {
            res.writeHead(500, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ ok: false, error: String(err) }))
          })
        return
      }
      res.writeHead(404)
      res.end()
    })
    await new Promise<void>((resolve, reject) => {
      this.server!.listen(0, '127.0.0.1', resolve)
      this.server!.on('error', reject)
    })
    const { port } = this.server.address() as AddressInfo
    await writeFile(path.join(this.storageDir, 'gateway.port'), String(port), { mode: 0o600 })
    return port
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.server?.close(() => resolve()))
    await rm(path.join(this.storageDir, 'gateway.port'), { force: true })
  }
}
