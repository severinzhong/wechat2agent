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

  it('captures turn.failed error message for user-facing reporting', () => {
    const line = '{"type":"turn.failed","error":{"message":"unexpected status 503: upstream unavailable"}}'
    const r = parseCodexLine(line, initialCodexState())
    expect(r.state.sawTurnCompleted).toBe(true)
    expect(r.state.lastError).toContain('503')
    expect(r.events).toEqual([{ type: 'error', message: expect.stringContaining('503') }])
  })

  it('emits progress for command execution items', () => {
    const line = JSON.stringify({
      type: 'item.completed',
      item: { id: 'item_1', type: 'command_execution', command: 'curl https://example.com', status: 'completed' },
    })
    const r = parseCodexLine(line, initialCodexState())
    expect(r.events).toEqual([{ type: 'progress', message: expect.stringContaining('command_execution') }])
  })
})
