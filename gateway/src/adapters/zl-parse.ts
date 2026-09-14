import type { TaskEvent } from './types.js'

export interface ZlParseState {
  sessionId?: string
  text: string
  sawStepFinish: boolean
}

export function initialZlState(): ZlParseState {
  return { text: '', sawStepFinish: false }
}

interface ZlEvent {
  type: string
  sessionID?: string
  part?: { type?: string; text?: string; reason?: string }
}

export function parseZlLine(
  line: string,
  state: ZlParseState,
): { events: TaskEvent[]; state: ZlParseState } {
  let e: ZlEvent
  try {
    e = JSON.parse(line) as ZlEvent
  } catch {
    return { events: [], state }
  }
  const next = { ...state }
  const events: TaskEvent[] = []

  if (e.sessionID && !next.sessionId) next.sessionId = e.sessionID
  if (e.type === 'text' && e.part?.text) {
    next.text += e.part.text
    events.push({ type: 'text', text: e.part.text })
  } else if (e.type === 'step_finish') {
    next.sawStepFinish = true
  }

  return { events, state: next }
}
