import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { parseCodexLine, initialCodexState } from '../src/adapters/codex-parse.js'

const fixture = readFileSync(path.join(__dirname, 'fixtures/codex-events.jsonl'), 'utf8')
  .trim().split('\n')

describe('parseCodexLine', () => {
  it('extracts thread_id from thread.started', () => {
    const r = parseCodexLine(fixture[0]!, initialCodexState())
    expect(r.state.threadId).toBe('01a0a046-2ce0-7fe3-a6ab-46335b175523')
  })

  it('collects agent_message text from item.completed', () => {
    let state = initialCodexState()
    for (const line of fixture) state = parseCodexLine(line, state).state
    expect(state.finalText).toBe('PROBE_OK')
    expect(state.sawTurnCompleted).toBe(true)
  })

  it('treats stream-reconnect error events as progress, not fatal', () => {
    const errorLine = fixture.find((l) => l.startsWith('{"type":"error"'))!
    const r = parseCodexLine(errorLine, initialCodexState())
    expect(r.events).toEqual([{ type: 'progress', message: expect.stringContaining('Reconnecting') }])
  })

  it('skips malformed lines without throwing', () => {
    const r = parseCodexLine('not json{', initialCodexState())
    expect(r.events).toEqual([])
  })
})
