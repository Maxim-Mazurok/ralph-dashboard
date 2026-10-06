export type TimeBreakdown = {
  inferenceMs: number
  toolMs: number
  delegatedMs: number
  firstContentMs: number
  reasoningMs: number
  outputMs: number
  toolOutputMs: number
  otherInferenceMs: number
}

export type SessionSummary = TimeBreakdown & {
  model: string
  activeMs: number
  maxContextTokens: number
  contextLimit: number | null
  reasoningTokens: number
  reasoningCount: number
  compactionCount: number
}

export type ReasoningPart = { text: string; startedAt: number | null; endedAt: number | null }
export type SessionEvent = {
  id: string
  type: 'reasoning' | 'text' | 'tool' | 'compaction'
  createdAt: number
  text?: string
  tool?: string
  status?: string
  title?: string
  input?: unknown
  output?: string
  diff?: string
}
export type OpenCodeSession = SessionSummary & {
  id: string
  parentId: string | null
  title: string
  createdAt: number
  updatedAt: number
  reasoning: ReasoningPart[]
  events: SessionEvent[]
}

type JsonObject = Record<string, unknown>
type Interval = { start: number; end: number }

function object(value: unknown): JsonObject {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : {}
}

function string(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

function number(value: unknown): number | null {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null
}

function mergedIntervals(intervals: Interval[]): Interval[] {
  const merged: Interval[] = []
  for (const interval of intervals.filter(({ start, end }) => start > 0 && end >= start).sort((a, b) => a.start - b.start)) {
    const previous = merged.at(-1)
    if (previous && interval.start <= previous.end) previous.end = Math.max(previous.end, interval.end)
    else merged.push({ ...interval })
  }
  return merged
}

function duration(intervals: Interval[]): number {
  return mergedIntervals(intervals).reduce((total, interval) => total + interval.end - interval.start, 0)
}

function modelName(metadata: JsonObject): string {
  const selected = string(metadata.selected_model)
  return selected.includes('/') ? selected.slice(selected.indexOf('/') + 1) : selected || 'unknown'
}

export function parseOpenCodeEvents(
  content: string,
  metadata: JsonObject = {},
  title = 'OpenCode session',
  contextLimit: number | null = null,
): OpenCodeSession | null {
  const records: JsonObject[] = []
  const seen = new Set<string>()
  for (const [index, line] of content.split(/\r?\n/).entries()) {
    if (!line.trim()) continue
    try {
      const record = object(JSON.parse(line))
      const part = object(record.part)
      const key = `${string(record.type)}:${string(part.id, `${number(record.timestamp) || 0}:${index}`)}`
      if (seen.has(key)) continue
      seen.add(key)
      records.push(record)
    } catch {
      // Interrupted attempts can leave a partial final record. Earlier valid records remain useful.
    }
  }

  const sessionId = string(metadata.session_id)
    || records.map((record) => string(record.sessionID)).find((value) => /^ses_[A-Za-z0-9_-]+$/.test(value))
  if (!sessionId) return null

  const timestamps = records.flatMap((record) => {
    const part = object(record.part)
    const time = object(part.time)
    const stateTime = object(object(part.state).time)
    return [number(record.timestamp), number(time.start), number(time.end), number(stateTime.start), number(stateTime.end)]
      .filter((value): value is number => value !== null)
  })
  const startedAt = number(metadata.started_at) || (timestamps.length ? Math.min(...timestamps) : Date.now())
  const session: OpenCodeSession = {
    id: sessionId,
    parentId: null,
    title,
    createdAt: startedAt,
    updatedAt: timestamps.length ? Math.max(...timestamps) : startedAt,
    model: modelName(metadata),
    activeMs: 0,
    maxContextTokens: 0,
    contextLimit,
    reasoningTokens: 0,
    reasoningCount: 0,
    compactionCount: 0,
    inferenceMs: 0,
    toolMs: 0,
    delegatedMs: 0,
    firstContentMs: 0,
    reasoningMs: 0,
    outputMs: 0,
    toolOutputMs: 0,
    otherInferenceMs: 0,
    reasoning: [],
    events: [],
  }

  const tools: Interval[] = []
  const delegated: Interval[] = []
  const steps: Interval[] = []
  let stepStart: number | null = null
  let stepLastActivity: number | null = null
  let firstContentSeen = false
  let lastContentEnd: number | null = null
  let firstToolStart: number | null = null

  for (const record of records) {
    const type = string(record.type)
    const timestamp = number(record.timestamp) || session.createdAt
    const part = object(record.part)
    const partType = string(part.type)
    const partTime = object(part.time)
    const start = number(partTime.start)
    const end = number(partTime.end)
    const eventId = string(part.id, `${type}-${timestamp}`)
    const recordStateTime = object(object(part.state).time)
    const activityAt = Math.max(timestamp, start || 0, end || 0, number(recordStateTime.start) || 0, number(recordStateTime.end) || 0)

    if (type === 'step_start') {
      if (stepStart !== null && stepLastActivity !== null && stepLastActivity >= stepStart) {
        steps.push({ start: stepStart, end: stepLastActivity })
      }
      stepStart = timestamp
      stepLastActivity = timestamp
      firstContentSeen = false
      lastContentEnd = null
      firstToolStart = null
      continue
    }
    if (stepStart !== null) stepLastActivity = Math.max(stepLastActivity || stepStart, activityAt)
    if (type === 'step_finish') {
      const tokens = object(part.tokens)
      session.maxContextTokens = Math.max(session.maxContextTokens, Number(tokens.total) || 0)
      session.reasoningTokens += Number(tokens.reasoning) || 0
      if (lastContentEnd !== null && firstToolStart !== null && firstToolStart > lastContentEnd) {
        session.toolOutputMs += firstToolStart - lastContentEnd
      }
      if (stepStart !== null && timestamp >= stepStart) steps.push({ start: stepStart, end: timestamp })
      stepStart = null
      stepLastActivity = null
      continue
    }
    if (type === 'compaction' || partType === 'compaction') {
      session.compactionCount++
      session.events.push({ id: eventId, type: 'compaction', createdAt: timestamp, text: string(part.text) })
      continue
    }
    if (type === 'reasoning' || type === 'text') {
      const value = string(part.text).trim()
      if (!value) continue
      const eventType = type as 'reasoning' | 'text'
      session.events.push({ id: eventId, type: eventType, createdAt: timestamp, text: value })
      if (!firstContentSeen && stepStart !== null) {
        session.firstContentMs += Math.max(0, (start || timestamp) - stepStart)
        firstContentSeen = true
      }
      if (start !== null && end !== null && end >= start) {
        if (eventType === 'reasoning') session.reasoningMs += end - start
        else session.outputMs += end - start
        lastContentEnd = Math.max(lastContentEnd || 0, end)
      }
      if (eventType === 'reasoning') {
        session.reasoningCount++
        session.reasoning.push({ text: value, startedAt: start, endedAt: end })
      }
      continue
    }
    if (type !== 'tool_use' && partType !== 'tool') continue

    const state = object(part.state)
    const stateTime = object(state.time)
    const toolStart = number(stateTime.start)
    const toolEnd = number(stateTime.end)
    const tool = string(part.tool, 'tool')
    if (toolStart !== null && toolEnd !== null && toolEnd >= toolStart) {
      const interval = { start: toolStart, end: toolEnd }
      firstToolStart = firstToolStart === null ? toolStart : Math.min(firstToolStart, toolStart)
      if (tool === 'task') delegated.push(interval)
      else tools.push(interval)
    }
    const metadataValue = object(state.metadata)
    session.events.push({
      id: eventId,
      type: 'tool',
      createdAt: timestamp,
      tool,
      status: string(state.status, 'completed'),
      title: string(state.title),
      input: state.input,
      output: string(state.output, string(state.error)),
      diff: string(metadataValue.diff),
    })
  }

  if (stepStart !== null && stepLastActivity !== null && stepLastActivity >= stepStart) {
    steps.push({ start: stepStart, end: stepLastActivity })
  }
  session.activeMs = duration(steps)
  session.toolMs = duration(tools)
  session.delegatedMs = duration(delegated)
  session.inferenceMs = Math.max(0, duration(steps) - duration([...tools, ...delegated]))
  session.otherInferenceMs = Math.max(
    0,
    session.inferenceMs - session.firstContentMs - session.reasoningMs - session.outputMs - session.toolOutputMs,
  )
  return session
}
