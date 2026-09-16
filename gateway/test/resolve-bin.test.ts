import { describe, it, expect } from 'vitest'
import { resolveBin } from '../src/resolve-bin.js'

describe('resolveBin', () => {
  it('resolves a system binary from PATH', async () => {
    expect(await resolveBin('ls')).toBe('/bin/ls')
  })

  it('resolves zl from ~/.zhanlu/bin even if PATH lacks it', async () => {
    const found = await resolveBin('zl')
    expect(found).toContain('zl')
  })

  it('resolves codex via nvm fallback', async () => {
    const found = await resolveBin('codex')
    expect(found).toContain('codex')
  })

  it('throws for unknown command', async () => {
    await expect(resolveBin('definitely-not-exists-cmd')).rejects.toThrow('找不到命令')
  })
})
