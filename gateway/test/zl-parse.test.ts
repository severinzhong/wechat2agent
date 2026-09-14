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
})
