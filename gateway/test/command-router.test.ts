import { describe, it, expect } from 'vitest'
import { CommandRouter, type CommandContext } from '../src/commands/router.js'

function ctx(overrides: Partial<CommandContext> = {}): CommandContext {
  return {
    backend: 'codex',
    model: 'gpt-5.2',
    backends: ['codex', 'zl'],
    modelsOf: (b: string) => (b === 'codex' ? ['gpt-5.2', 'gpt-5.2-codex'] : ['zhanlu/qwen3.7-max']),
    taskActive: false,
    ...overrides,
  }
}

describe('CommandRouter', () => {
  it('/help lists commands', () => {
    const r = new CommandRouter()
    const out = r.handle('/help', ctx())
    expect(out.replies[0]).toContain('/backend')
    expect(out.replies[0]).toContain('/cancel')
  })

  it('/status shows backend and model', () => {
    const out = new CommandRouter().handle('/status', ctx())
    expect(out.replies[0]).toContain('codex')
    expect(out.replies[0]).toContain('gpt-5.2')
  })

  it('/backend without args opens a numbered menu', () => {
    const r = new CommandRouter()
    const out = r.handle('/backend', ctx())
    expect(out.replies[0]).toContain('/1 codex')
    expect(out.replies[0]).toContain('/2 zl')
    expect(out.menu).toBeDefined()
  })

  it('menu choice via /2 switches backend', () => {
    const r = new CommandRouter()
    const menuOut = r.handle('/backend', ctx())
    const out = r.resolveMenu(2, menuOut.menu!, ctx())
    expect(out.replies[0]).toContain('已切换到 zl')
    expect(out.set?.backend).toBe('zl')
  })

  it('/backend zl switches directly without menu', () => {
    const out = new CommandRouter().handle('/backend zl', ctx())
    expect(out.replies[0]).toContain('已切换到 zl')
    expect(out.set?.backend).toBe('zl')
  })

  it('out-of-range choice cancels the menu', () => {
    const r = new CommandRouter()
    const menuOut = r.handle('/backend', ctx())
    const out = r.resolveMenu(9, menuOut.menu!, ctx())
    expect(out.replies[0]).toContain('无效选项')
  })

  it('unrelated slash command discards the menu', () => {
    const r = new CommandRouter()
    r.handle('/backend', ctx())
    const out = r.handle('/status', ctx())
    expect(out.replies[0]).toContain('codex')
    expect(out.menu).toBeUndefined()
  })

  it('switching backend while task active is refused', () => {
    const r = new CommandRouter()
    const out = r.handle('/backend zl', ctx({ taskActive: true }))
    expect(out.replies[0]).toContain('任务进行中')
    expect(out.set).toBeUndefined()
  })

  it('/model lists models of current backend', () => {
    const out = new CommandRouter().handle('/model', ctx())
    expect(out.replies[0]).toContain('/1 gpt-5.2')
    expect(out.replies[0]).toContain('/2 gpt-5.2-codex')
  })

  it('unknown command gets a hint', () => {
    const out = new CommandRouter().handle('/xyz', ctx())
    expect(out.replies[0]).toContain('未知命令')
  })
})
