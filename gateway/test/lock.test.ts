import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { acquireInstanceLock } from '../src/lock.js'

describe('acquireInstanceLock', () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'w2a-lock-'))
  })
  afterEach(async () => rm(dir, { recursive: true, force: true }))

  it('acquires and releases the lock', async () => {
    const release = await acquireInstanceLock(dir)
    await release()
    // 释放后可再次获取
    const again = await acquireInstanceLock(dir)
    await again()
  })

  it('refuses when another live process holds the lock', async () => {
    // 用当前进程 PID 模拟"活锁"
    await writeFile(path.join(dir, 'gateway.lock'), String(process.pid))
    await expect(acquireInstanceLock(dir)).rejects.toThrow('已在运行')
  })

  it('takes over a stale lock (dead pid)', async () => {
    // 999999 几乎不可能是存活 PID
    await writeFile(path.join(dir, 'gateway.lock'), '999999')
    const release = await acquireInstanceLock(dir)
    await release()
  })
})
