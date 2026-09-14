import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { parseZlLine, initialZlState } from '../src/adapters/zl-parse.js'

const fixture = readFileSync(path.join(__dirname, 'fixtures/zl-events.jsonl'), 'utf8')
  .trim().split('\n')

describe('parseZlLine', () => {
  it('captures sessionID from any event', () => {
    const r = parseZlLine(fixture[0]!, initialZlState())
    expect(r.state.sessionId).toBe('ses_f5fac9fe7ffehhTrNzgpUFqxYk')
  })

  it('collects text parts and detects completion', () => {
    let state = initialZlState()
    for (const line of fixture) state = parseZlLine(line, state).state
    expect(state.text).toBe('PROBE_OK')
    expect(state.sawStepFinish).toBe(true)
  })

  it('skips malformed lines without throwing', () => {
    expect(parseZlLine('{broken', initialZlState()).events).toEqual([])
  })

  it('emits progress for tool calls and counts steps', () => {
    const toolLine = JSON.stringify({
      type: 'tool',
      sessionID: 'ses_x',
      part: { type: 'tool', tool: 'bash', state: { status: 'running', input: { command: 'curl -sL https://example.com' } } },
    })
    let state = initialZlState()
    const r1 = parseZlLine(toolLine, state)
    state = r1.state
    expect(r1.events[0]?.type).toBe('progress')
    expect(r1.events[0]).toMatchObject({ message: expect.stringContaining('bash') })

    const finishLine = JSON.stringify({ type: 'step_finish', sessionID: 'ses_x', part: { type: 'step-finish', reason: 'tool-calls' } })
    const r2 = parseZlLine(finishLine, state)
    state = r2.state
    expect(state.steps).toBe(1)
    expect(state.sawStepFinish).toBe(true)
  })

  it('updates lastEventAt on each parsed line', () => {
    const before = Date.now()
    const r = parseZlLine(fixture[0]!, initialZlState())
    expect(r.state.lastEventAt).toBeGreaterThanOrEqual(before)
  })

  it('resets text on a new messageID (intermediate texts are process, final answer wins)', () => {
    const mk = (messageID: string, text: string, partId: string) => JSON.stringify({
      type: 'text',
      sessionID: 'ses_x',
      part: { id: partId, messageID, type: 'text', text },
    })
    let state = initialZlState()
    state = parseZlLine(mk('msg_A', '让我查一下攻略。', 'p1'), state).state
    state = parseZlLine(mk('msg_A', '继续查。', 'p2'), state).state
    // 同一 message 的分片应拼接
    expect(state.text).toBe('让我查一下攻略。继续查。')
    state = parseZlLine(mk('msg_B', '最终答案：共 30 层。', 'p3'), state).state
    // 新 message 出现：最终文本只保留最后一条 message
    expect(state.text).toBe('最终答案：共 30 层。')
  })
})
