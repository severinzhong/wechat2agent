import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { FileSessionStore } from '../src/sessions/file-store.js'

describe('FileSessionStore', () => {
  let dir: string
  let store: FileSessionStore

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'w2a-sessions-'))
    store = new FileSessionStore(dir)
  })
  afterEach(async () => rm(dir, { recursive: true, force: true }))

  it('returns undefined for unknown peer', async () => {
    expect(await store.load('nobody@im.wechat')).toBeUndefined()
  })

  it('saves and loads a session', async () => {
    await store.save({
      wechatPeer: 'u1@im.wechat',
      backend: 'codex',
      model: 'gpt-5.2',
      nativeSessionIds: {},
      updatedAt: new Date().toISOString(),
    })
    const loaded = await store.load('u1@im.wechat')
    expect(loaded?.backend).toBe('codex')
    expect(loaded?.model).toBe('gpt-5.2')
  })

  it('persists native session ids per backend', async () => {
    const s = {
      wechatPeer: 'u1@im.wechat',
      backend: 'zl',
      nativeSessionIds: { codex: '01a0a046-2ce0-7fe3-a6ab-46335b175523', zl: 'ses_abc' },
      updatedAt: new Date().toISOString(),
    }
    await store.save(s)
    const loaded = await store.load('u1@im.wechat')
    expect(loaded?.nativeSessionIds.zl).toBe('ses_abc')
    expect(loaded?.nativeSessionIds.codex).toBe('01a0a046-2ce0-7fe3-a6ab-46335b175523')
  })

  it('survives a new store instance (persistence)', async () => {
    await store.save({
      wechatPeer: 'u2@im.wechat',
      backend: 'zl',
      nativeSessionIds: {},
      updatedAt: new Date().toISOString(),
    })
    const fresh = new FileSessionStore(dir)
    expect((await fresh.load('u2@im.wechat'))?.backend).toBe('zl')
  })
})
