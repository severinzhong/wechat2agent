import { readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/**
 * 解析 CLI 的绝对路径。GUI/launchd 等环境下 PATH 不含用户工具目录
 *（~/.zhanlu/bin、nvm 版本目录等），spawn 会 ENOENT。
 * 解析顺序：当前 PATH → 常见安装位置 → nvm 最新版本目录。
 */
export async function resolveBin(name: string): Promise<string> {
  // 1. which（当前进程 PATH）
  const fromPath = await execFileAsync('/usr/bin/which', [name]).then((r) => r.stdout.trim()).catch(() => '')
  if (fromPath) return fromPath

  const home = os.homedir()
  const candidates = [
    path.join(home, '.zhanlu', 'bin', name),
    path.join('/opt/homebrew/bin', name),
    path.join('/usr/local/bin', name),
  ]
  for (const c of candidates) {
    if (await isExecutable(c)) return c
  }

  // 2. nvm：~/.nvm/versions/node/<vX>/bin/<name>，取最新版本目录
  const nvmRoot = path.join(home, '.nvm', 'versions', 'node')
  const versions = await readdir(nvmRoot).catch(() => [] as string[])
  const sorted = versions.filter((v) => v.startsWith('v')).sort().reverse()
  for (const v of sorted) {
    const c = path.join(nvmRoot, v, 'bin', name)
    if (await isExecutable(c)) return c
  }

  throw new Error(`找不到命令 ${name}（PATH 与常见位置都没有）`)
}

async function isExecutable(p: string): Promise<boolean> {
  const st = await stat(p).catch(() => undefined)
  return !!st && st.isFile() && (st.mode & 0o111) !== 0
}
