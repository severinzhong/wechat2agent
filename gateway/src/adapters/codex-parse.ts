import type { TaskEvent } from './types.js'

export interface CodexParseState {
  threadId?: string
  finalText: string
  sawTurnCompleted: boolean
  /** turn.failed 的错误信息（用于失败时透传给用户） */
  lastError?: string
}

export function initialCodexState(): CodexParseState {
  return { finalText: '', sawTurnCompleted: false }
}

interface CodexEvent {
  type: string
  thread_id?: string
  message?: string
  item?: { id?: string; type?: string; text?: string }
  error?: { message?: string }
  usage?: Record<string, unknown>
}

export function parseCodexLine(
  line: string,
  state: CodexParseState,
): { events: TaskEvent[]; state: CodexParseState } {
  let e: CodexEvent
  try {
    e = JSON.parse(line) as CodexEvent
  } catch {
    return { events: [], state }
  }
  const next = { ...state }
  const events: TaskEvent[] = []

  if (e.type === 'thread.started' && e.thread_id) {
    next.threadId = e.thread_id
  } else if (e.type === 'item.completed' && e.item?.type === 'agent_message' && e.item.text) {
    // 同一 turn 可能出现多条 agent_message，后者覆盖（最终回复以最后一条为准）
    next.finalText = e.item.text
    events.push({ type: 'text', text: e.item.text })
  } else if (e.type === 'turn.completed') {
    next.sawTurnCompleted = true
  } else if (e.type === 'turn.failed') {
    next.sawTurnCompleted = true
    next.lastError = e.error?.message ?? e.message ?? 'turn failed'
    events.push({ type: 'error', message: next.lastError })
  } else if (e.type === 'error' && e.message) {
    events.push({ type: 'progress', message: e.message })
  }

  return { events, state: next }
}
