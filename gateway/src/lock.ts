import { mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import path from 'node:path'

/**
 * 单实例锁（~/.wechat2agent/gateway.lock，内容为 PID）。
 * iLink 单账号只允许一个活跃 poller；session 文件无并发锁——重复启动会破坏状态。
 * 陈旧锁（进程已死）自动接管。
 */
export async function acquireInstanceLock(storageDir: string): Promise<() => Promise<void>> {
  await mkdir(storageDir, { recursive: true })
  const lockFile = path.join(storageDir, 'gateway.lock')

  const existing = await readFile(lockFile, 'utf8').then((s) => Number(s.trim())).catch(() => NaN)
  if (Number.isInteger(existing) && existing > 0) {
    if (isAlive(existing)) {
      throw new Error(`gateway 已在运行（PID ${existing}）。如需重启，请先停止该进程`)
    }
    // 进程已死：陈旧锁，接管
  }

  await writeFile(lockFile, String(process.pid), { encoding: 'utf8', mode: 0o600 })

  return async () => {
    // 只释放自己的锁（避免误删新实例的锁）
    const current = await readFile(lockFile, 'utf8').then((s) => Number(s.trim())).catch(() => NaN)
    if (current === process.pid) await rm(lockFile, { force: true })
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
