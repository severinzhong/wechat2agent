import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { GatewaySession, SessionStore } from './types.js'

export class FileSessionStore implements SessionStore {
  constructor(private readonly dir: string) {}

  private fileOf(peer: string): string {
    const safe = peer.replace(/[^a-zA-Z0-9@._-]/g, '_')
    return path.join(this.dir, `${safe}.json`)
  }

  async load(peer: string): Promise<GatewaySession | undefined> {
    try {
      const raw = await readFile(this.fileOf(peer), 'utf8')
      return JSON.parse(raw) as GatewaySession
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw err
    }
  }

  async save(session: GatewaySession): Promise<void> {
    await mkdir(this.dir, { recursive: true })
    session.updatedAt = new Date().toISOString()
    await writeFile(this.fileOf(session.wechatPeer), JSON.stringify(session, null, 2), {
      encoding: 'utf8',
      mode: 0o600,
    })
  }
}
