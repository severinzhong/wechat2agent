import { describe, it, expect } from 'vitest'
import { CommandRouter, type CommandContext } from '../src/commands/router.js'

function ctx(overrides: Partial<CommandContext> = {}): CommandContext {
  return {
    backend: 'codex',
    model: 'gpt-5.5',
    backends: ['codex', 'zl'],
    modelsOf: (b: string) => (b === 'codex' ? ['gpt-5.5', 'gpt-5.4-mini'] : ['zhanlu/zhanlu/qwen3.7-max']),
    effortsOf: (b: string) => (b === 'codex' ? ['low', 'medium', 'high', 'xhigh'] : ['minimal', 'low', 'medium', 'high', 'max']),
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
    expect(out.replies[0]).toContain('gpt-5.5')
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
    expect(out.replies[0]).toContain('/1 gpt-5.5')
    expect(out.replies[0]).toContain('/2 gpt-5.4-mini')
  })

  it('/model without enumeratable models falls back to direct input hint', () => {
    const out = new CommandRouter().handle('/model', ctx({ modelsOf: () => [] }))
    expect(out.replies[0]).toContain('不提供模型枚举')
    expect(out.menu).toBeUndefined()
  })

  it('/model accepts unlisted model with soft warning (cache may be stale)', () => {
    const out = new CommandRouter().handle('/model gpt-5.6-sol', ctx())
    expect(out.replies[0]).toContain('不在枚举列表中')
    expect(out.set?.model).toBe('gpt-5.6-sol')
  })

  it('/model menu shows list note when provided', () => {
    const out = new CommandRouter().handle('/model', ctx({ modelListNote: '列表缓存于 2026-06-04，可能过期' }))
    expect(out.replies[0]).toContain('缓存于 2026-06-04')
  })

  it('/effort lists efforts of current backend', () => {
    const out = new CommandRouter().handle('/effort', ctx())
    expect(out.replies[0]).toContain('/1 low')
    expect(out.replies[0]).toContain('/4 xhigh')
  })

  it('/effort high sets variant directly', () => {
    const out = new CommandRouter().handle('/effort high', ctx())
    expect(out.replies[0]).toContain('effort 已切换为 high')
    expect(out.set?.variant).toBe('high')
  })

  it('/effort rejects unknown level when enumerable', () => {
    const out = new CommandRouter().handle('/effort banana', ctx())
    expect(out.replies[0]).toContain('未知 effort')
    expect(out.set).toBeUndefined()
  })

  it('/verbose opens a 4-level menu with current marked', () => {
    const out = new CommandRouter().handle('/verbose', ctx({ verbose: 'summary' }))
    expect(out.replies[0]).toContain('/1 none')
    expect(out.replies[0]).toContain('/2 heartbeat')
    expect(out.replies[0]).toContain('/3 summary')
    expect(out.replies[0]).toContain('/4 detail')
    expect(out.replies[0]).toContain('summary 摘要（每个事件一行，节流合并）（当前）')
  })

  it('/verbose detail sets level directly', () => {
    const out = new CommandRouter().handle('/verbose detail', ctx())
    expect(out.replies[0]).toContain('detail')
    expect(out.set?.verbose).toBe('detail')
  })

  it('/verbose rejects unknown level', () => {
    const out = new CommandRouter().handle('/verbose loud', ctx())
    expect(out.replies[0]).toContain('未知档位')
    expect(out.set).toBeUndefined()
  })

  it('unknown command gets a hint', () => {
    const out = new CommandRouter().handle('/xyz', ctx())
    expect(out.replies[0]).toContain('未知命令')
  })
})
