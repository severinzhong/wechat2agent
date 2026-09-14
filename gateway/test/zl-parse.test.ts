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
})
