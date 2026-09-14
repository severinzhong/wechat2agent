import type { TaskEvent } from './types.js'

export interface ZlParseState {
  sessionId?: string
  /** 当前 message 的累积文本（新 messageID 出现时重置——中间过程文本不属于最终回复） */
  text: string
  /** 当前累积文本所属的 messageID */
  currentMessageId?: string
  sawStepFinish: boolean
  /** 已完成的 step 数（step_finish 事件计数） */
  steps: number
  /** 最后一个事件的时间戳（liveness 检测用） */
  lastEventAt: number
}

export function initialZlState(): ZlParseState {
  return { text: '', sawStepFinish: false, steps: 0, lastEventAt: Date.now() }
}

interface ZlEvent {
  type: string
  sessionID?: string
  part?: {
    id?: string
    messageID?: string
    type?: string
    text?: string
    reason?: string
    tool?: string
    state?: { status?: string; input?: { command?: string; description?: string } }
  }
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
  const next = { ...state, lastEventAt: Date.now() }
  const events: TaskEvent[] = []

  if (e.sessionID && !next.sessionId) next.sessionId = e.sessionID
  if (e.type === 'text' && e.part?.text) {
    const msgId = e.part.messageID
    if (msgId && msgId !== next.currentMessageId) {
      // 新的 assistant message：之前的文本属于中间过程，最终回复以最后一条 message 为准
      next.currentMessageId = msgId
      next.text = e.part.text
    } else {
      next.text += e.part.text
    }
    events.push({ type: 'text', text: e.part.text })
  } else if (e.type === 'step_finish') {
    next.sawStepFinish = true
    next.steps += 1
  } else if ((e.type === 'tool' || e.part?.type === 'tool') && e.part?.tool) {
    const status = e.part.state?.status
    const hint = e.part.state?.input?.description ?? e.part.state?.input?.command?.slice(0, 60) ?? ''
    events.push({
      type: 'progress',
      message: `工具 ${e.part.tool}${status ? ` ${status}` : ''}${hint ? `：${hint}` : ''}`,
    })
  }

  return { events, state: next }
}
