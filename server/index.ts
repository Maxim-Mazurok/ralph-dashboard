import express from 'express'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readdir, readFile, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { promisify } from 'node:util'

const app = express()
const port = Number(process.env.PORT || 4310)
const host = process.env.HOST || '0.0.0.0'
const projectRoot = path.resolve(process.env.RALPH_PROJECT_PATH || '/home/user/home-inventory')
const ralphRoot = path.join(projectRoot, '.ralph')
const runtimeRoot = path.join(ralphRoot, 'runtime')
const cyclePattern = /^cycle-(\d+)-(\d+)$/
const attemptPattern = /^(worker|reviewer|retrospective)-(\d+)\.(md|log)$/
const textExtensions = new Set(['.json', '.jsonl', '.log', '.md', '.txt'])
const liveLogLimit = 256 * 1024
const sessionStartToleranceMs = 10_000
const openCodeDatabase = process.env.OPENCODE_DB_PATH || path.join(os.homedir(), '.local/share/opencode/opencode.db')
const openCodeConfig = process.env.OPENCODE_CONFIG_PATH || path.join(os.homedir(), '.config/opencode/opencode.jsonc')
const execFileAsync = promisify(execFile)

type JsonObject = Record<string, unknown>
type TimeBreakdown = { inferenceMs: number; toolMs: number; delegatedMs: number; firstContentMs: number; reasoningMs: number; outputMs: number; toolOutputMs: number; otherInferenceMs: number }
type SessionSummary = TimeBreakdown & { model: string; maxContextTokens: number; contextLimit: number | null; reasoningTokens: number; reasoningCount: number }
type ReasoningPart = { text: string; startedAt: number | null; endedAt: number | null }
type SessionEvent = {
  id: string
  type: 'reasoning' | 'text' | 'tool'
  createdAt: number
  text?: string
  tool?: string
  status?: string
  title?: string
  input?: unknown
  output?: string
  diff?: string
}
type OpenCodeSession = SessionSummary & { id: string; parentId: string | null; title: string; createdAt: number; updatedAt: number; reasoning: ReasoningPart[]; events: SessionEvent[] }
type Interval = { start: number; end: number }

function mergedIntervals(intervals: Interval[]): Interval[] {
  const merged: Interval[] = []
  for (const interval of intervals.filter(({ start, end }) => start > 0 && end >= start).sort((a, b) => a.start - b.start)) {
    const last = merged.at(-1)
    if (last && interval.start <= last.end) last.end = Math.max(last.end, interval.end)
    else merged.push({ ...interval })
  }
  return merged
}

function intervalDuration(intervals: Interval[]): number {
  return intervals.reduce((total, { start, end }) => total + end - start, 0)
}

function overlap(interval: Interval, intervals: Interval[]): number {
  return intervals.reduce((total, item) => total + Math.max(0, Math.min(interval.end, item.end) - Math.max(interval.start, item.start)), 0)
}

function measuredDuration(intervals: Interval[], excluded: Interval[]): number {
  return intervals.reduce((total, interval) => total + interval.end - interval.start - overlap(interval, excluded), 0)
}
type SubagentTelemetry = { id: string; title: string; createdAt: number; updatedAt: number; session: SessionTelemetry }
type SessionTelemetry = SessionSummary & {
  reasoning: ReasoningPart[]
  events: Array<SessionEvent & { subagent?: SubagentTelemetry }>
  subagents: SubagentTelemetry[]
}
type Artifact = { name: string; size: number; modifiedAt: string; kind: string; compactionCount: number; session: SessionSummary | null }
type PhaseTiming = { durationMs: number | null; attempts: number }
type ActiveLog = { cycle: number; directory: string; file: string; phase: string; attempt: number }

type Cycle = {
  id: string
  cycle: number
  startedAt: string
  endedAt: string | null
  status: 'complete' | 'active' | 'incomplete'
  focus: string
  outcome: string | null
  decision: string | null
  summary: string
  commit: string | null
  durationMs: number | null
  retryCount: number
  compactionCount: number
  maxContextTokens: number | null
  contextLimit: number | null
  timeBreakdown: TimeBreakdown
  phases: Record<'worker' | 'reviewer' | 'retrospective', PhaseTiming>
  artifacts: Artifact[]
}

async function readJson(file: string): Promise<JsonObject | null> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as JsonObject
  } catch {
    return null
  }
}

function text(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

function quantile(values: number[], percentile: number): number | null {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor(percentile * sorted.length))]
}

function countCompactions(content: string): number {
  return content.match(/the conversation was compacted\b/gi)?.length || 0
}

function modelContextLimit(config: JsonObject | null, providerId: string, modelId: string): number | null {
  const providers = config?.provider as JsonObject | undefined
  const provider = providers?.[providerId] as JsonObject | undefined
  const exactModel = (provider?.models as JsonObject | undefined)?.[modelId] as JsonObject | undefined
  const exactLimit = Number((exactModel?.limit as JsonObject | undefined)?.context)
  if (exactLimit) return exactLimit

  const matchingLimits = new Set<number>()
  for (const candidateProvider of Object.values(providers || {})) {
    const models = (candidateProvider as JsonObject)?.models as JsonObject | undefined
    for (const [candidateId, candidateModel] of Object.entries(models || {})) {
      if (candidateId.toLowerCase() !== modelId.toLowerCase()) continue
      const limit = Number((((candidateModel as JsonObject)?.limit as JsonObject | undefined)?.context))
      if (limit) matchingLimits.add(limit)
    }
  }
  return matchingLimits.size === 1 ? [...matchingLimits][0] : null
}

async function loadOpenCodeSessions(summaryOnly = false): Promise<OpenCodeSession[]> {
  if (!existsSync(openCodeDatabase)) return []
  const config = await readJson(openCodeConfig)
  let database: DatabaseSync | null = null
  try {
    database = new DatabaseSync(openCodeDatabase, { readOnly: true })
    const sessionRows = database.prepare('SELECT id, parent_id, title, model, time_created, time_updated FROM session WHERE directory = ?').all(projectRoot) as Array<Record<string, unknown>>
    const sessions = new Map<string, OpenCodeSession>()
    for (const row of sessionRows) {
      const model = JSON.parse(text(row.model, '{}')) as JsonObject
      const providerId = text(model.providerID)
      const modelId = text(model.id)
      sessions.set(String(row.id), {
        id: String(row.id), parentId: row.parent_id ? String(row.parent_id) : null, title: text(row.title, 'Subagent'),
        createdAt: Number(row.time_created), updatedAt: Number(row.time_updated), model: modelId || 'unknown',
        maxContextTokens: 0, contextLimit: modelContextLimit(config, providerId, modelId), reasoningTokens: 0, reasoningCount: 0,
        inferenceMs: 0, toolMs: 0, delegatedMs: 0, firstContentMs: 0, reasoningMs: 0, outputMs: 0, toolOutputMs: 0, otherInferenceMs: 0, reasoning: [], events: [],
      })
    }
    // Read only timing fields for the dashboard. Message completion includes tool execution,
    // so subtract tool intervals before classifying model time.
    const messages = database.prepare(`
      SELECT m.id, m.session_id,
        json_extract(m.data, '$.tokens.total') AS total_tokens,
        json_extract(m.data, '$.tokens.reasoning') AS reasoning_tokens,
        json_extract(m.data, '$.time.created') AS started_at,
        json_extract(m.data, '$.time.completed') AS ended_at
      FROM message m JOIN session s ON s.id = m.session_id
      WHERE s.directory = ? AND json_extract(m.data, '$.role') = 'assistant'
    `).all(projectRoot) as Array<Record<string, unknown>>
    const partsByMessage = new Map<string, { reasoning: Interval[]; output: Interval[]; tools: Interval[]; tasks: Interval[] }>()
    const sessionByMessage = new Map(messages.map((message) => [String(message.id), String(message.session_id)]))
    const timingParts = database.prepare(`
      SELECT p.message_id,
        json_extract(p.data, '$.type') AS type,
        json_extract(p.data, '$.tool') AS tool,
        length(trim(COALESCE(json_extract(p.data, '$.text'), ''))) AS content_length,
        json_extract(p.data, '$.time.start') AS started_at,
        json_extract(p.data, '$.time.end') AS ended_at,
        json_extract(p.data, '$.state.time.start') AS tool_started_at,
        json_extract(p.data, '$.state.time.end') AS tool_ended_at
      FROM part p JOIN session s ON s.id = p.session_id JOIN message m ON m.id = p.message_id
      WHERE s.directory = ? AND json_extract(m.data, '$.role') = 'assistant'
        AND json_extract(p.data, '$.type') IN ('reasoning', 'text', 'tool')
    `).all(projectRoot) as Array<Record<string, unknown>>
    for (const row of timingParts) {
      const id = String(row.message_id)
      let group = partsByMessage.get(id)
      if (!group) {
        group = { reasoning: [], output: [], tools: [], tasks: [] }
        partsByMessage.set(id, group)
      }
      const type = String(row.type)
      const start = Number(type === 'tool' ? row.tool_started_at : row.started_at)
      const end = Number(type === 'tool' ? row.tool_ended_at : row.ended_at)
      if (type === 'reasoning' && Number(row.content_length) > 0) {
        const session = sessions.get(sessionByMessage.get(id) || '')
        if (session) session.reasoningCount++
      }
      if (!start || !Number.isFinite(end) || end < start) continue
      if (type === 'reasoning' && Number(row.content_length) > 0) group.reasoning.push({ start, end })
      if (type === 'text' && Number(row.content_length) > 0) group.output.push({ start, end })
      if (type === 'tool') group[row.tool === 'task' ? 'tasks' : 'tools'].push({ start, end })
    }
    for (const row of messages) {
      const session = sessions.get(String(row.session_id))
      if (!session) continue
      session.maxContextTokens = Math.max(session.maxContextTokens, Number(row.total_tokens) || 0)
      session.reasoningTokens += Number(row.reasoning_tokens) || 0
      const group = partsByMessage.get(String(row.id)) || { reasoning: [], output: [], tools: [], tasks: [] }
      const tools = mergedIntervals(group.tools)
      const tasks = mergedIntervals(group.tasks)
      session.toolMs += intervalDuration(tools)
      session.delegatedMs += measuredDuration(tasks, tools)
      const start = Number(row.started_at)
      const end = Number(row.ended_at)
      if (!start || !Number.isFinite(end) || end < start) continue
      const excluded = mergedIntervals([...tools, ...tasks].map((item) => ({ start: Math.max(start, item.start), end: Math.min(end, item.end) })).filter((item) => item.end >= item.start))
      const inference = end - start - intervalDuration(excluded)
      session.inferenceMs += inference
      const timed = [...group.reasoning, ...group.output].filter((item) => item.start >= start && item.end <= end)
      const firstStart = timed.length ? Math.min(...timed.map((item) => item.start)) : null
      const lastEnd = timed.length ? Math.max(...timed.map((item) => item.end)) : null
      const firstContent = firstStart === null ? 0 : measuredDuration([{ start, end: firstStart }], excluded)
      const reasoningIntervals = mergedIntervals(group.reasoning.filter((item) => item.start >= start && item.end <= end))
      const reasoning = measuredDuration(reasoningIntervals, excluded)
      const output = measuredDuration(mergedIntervals(group.output.filter((item) => item.start >= start && item.end <= end)), mergedIntervals([...excluded, ...reasoningIntervals]))
      const firstTool = [...tools, ...tasks].filter((item) => item.start >= start && item.start <= end).sort((a, b) => a.start - b.start)[0]?.start ?? null
      const toolOutput = lastEnd !== null && firstTool !== null && firstTool > lastEnd
        ? measuredDuration([{ start: lastEnd, end: Math.min(end, firstTool) }], excluded) : 0
      session.firstContentMs += firstContent
      session.reasoningMs += reasoning
      session.outputMs += output
      session.toolOutputMs += toolOutput
      session.otherInferenceMs += Math.max(0, inference - firstContent - reasoning - output - toolOutput)
    }
    if (summaryOnly) return [...sessions.values()]
    const parts = database.prepare("SELECT p.id, p.session_id, p.time_created, p.data, m.data AS message_data FROM part p JOIN session s ON s.id = p.session_id JOIN message m ON m.id = p.message_id WHERE s.directory = ? ORDER BY p.time_created, p.id").all(projectRoot) as Array<Record<string, unknown>>
    for (const row of parts) {
      const session = sessions.get(String(row.session_id))
      if (!session) continue
      const part = JSON.parse(text(row.data, '{}')) as JsonObject
      const message = JSON.parse(text(row.message_data, '{}')) as JsonObject
      if (message.role !== 'assistant') continue
      const partType = text(part.type)
      if (partType === 'tool') {
        const state = part.state as JsonObject | undefined
        const metadata = state?.metadata as JsonObject | undefined
        session.events.push({
          id: String(row.id), type: 'tool', createdAt: Number(row.time_created), tool: text(part.tool, 'tool'),
          status: text(state?.status, 'pending'), title: text(state?.title), input: state?.input,
          output: text(state?.output, text(state?.error)), diff: text(metadata?.diff),
        })
        continue
      }
      if (partType !== 'reasoning' && partType !== 'text') continue
      const partText = text(part.text).trim()
      if (!partText) continue
      const time = part.time as JsonObject | undefined
      session.events.push({ id: String(row.id), type: partType, createdAt: Number(row.time_created), text: partText })
      if (partType === 'reasoning') session.reasoning.push({ text: partText, startedAt: Number(time?.start) || null, endedAt: Number(time?.end) || null })
    }
    return [...sessions.values()]
  } catch (error) {
    console.warn(`Unable to read OpenCode telemetry: ${error instanceof Error ? error.message : error}`)
    return []
  } finally {
    database?.close()
  }
}

function matchingSession(prompt: Artifact | undefined, sessions: OpenCodeSession[]): OpenCodeSession | null {
  if (!prompt) return null
  const promptTime = Date.parse(prompt.modifiedAt)
  const candidates = sessions
    .filter((session) => session.parentId === null)
    .map((session) => ({ session, distance: Math.abs(session.createdAt - promptTime) }))
    .filter(({ distance }) => distance <= sessionStartToleranceMs)
    .sort((left, right) => left.distance - right.distance)
  if (candidates.length !== 1) return null
  return candidates[0].session
}

function sessionSummary(session: OpenCodeSession): SessionSummary {
  const { model, maxContextTokens, contextLimit, reasoningTokens, reasoningCount, inferenceMs, toolMs, delegatedMs, firstContentMs, reasoningMs, outputMs, toolOutputMs, otherInferenceMs } = session
  return { model, maxContextTokens, contextLimit, reasoningTokens, reasoningCount, inferenceMs, toolMs, delegatedMs, firstContentMs, reasoningMs, outputMs, toolOutputMs, otherInferenceMs }
}

function sessionTelemetry(session: OpenCodeSession, sessions: OpenCodeSession[]): SessionTelemetry {
  const children = sessions
    .filter((candidate) => candidate.parentId === session.id)
    .sort((left, right) => left.createdAt - right.createdAt)
  const attached = new Set<string>()
  const serialize = (child: OpenCodeSession): SubagentTelemetry => ({
      id: child.id,
      title: child.title,
      createdAt: child.createdAt,
      updatedAt: child.updatedAt,
      session: sessionTelemetry(child, sessions),
    })
  const events = session.events.map((event) => {
    if (event.type !== 'tool' || event.tool !== 'task') return event
    const taskId = event.output?.match(/<task\s+id="([^"]+)"/)?.[1]
    const child = children.find((candidate) => candidate.id === taskId)
      || children.find((candidate) => !attached.has(candidate.id)
        && candidate.createdAt >= event.createdAt
        && candidate.title.toLowerCase().startsWith((event.title || '').toLowerCase()))
    if (!child) return event
    attached.add(child.id)
    return { ...event, subagent: serialize(child) }
  })
  return {
    ...sessionSummary(session),
    reasoning: session.reasoning,
    events,
    subagents: children.filter((child) => !attached.has(child.id)).map(serialize),
  }
}

async function findActiveLog(state: JsonObject | null): Promise<ActiveLog | null> {
  const active = state?.active as JsonObject | undefined
  const pending = state?.pendingRetrospective as JsonObject | undefined
  const directory = text(active?.directory, text(pending?.directory))
  if (!directory || path.dirname(directory) !== runtimeRoot || !cyclePattern.test(path.basename(directory))) return null

  const preferredPhase = text(active?.phase, pending ? 'retrospective' : '')
  const preferredAttempt = Number(active?.attempt ?? pending?.attempt ?? 0)
  const files = await readdir(directory, { withFileTypes: true })
  const logs = await Promise.all(files.flatMap((entry) => {
    const match = entry.isFile() ? attemptPattern.exec(entry.name) : null
    if (!match || match[3] !== 'log') return []
    return [stat(path.join(directory, entry.name)).then((details) => ({
      file: entry.name,
      phase: match[1],
      attempt: Number(match[2]),
      modifiedMs: details.mtimeMs,
    }))]
  }))
  if (!logs.length) return null
  const preferred = logs.find((log) => log.phase === preferredPhase && log.attempt === preferredAttempt)
  const selected = preferred || logs.sort((left, right) => right.modifiedMs - left.modifiedMs)[0]
  const directoryMatch = cyclePattern.exec(path.basename(directory))
  return {
    cycle: Number((active?.cycle ?? pending?.cycle) || directoryMatch?.[1] || 0),
    directory,
    file: selected.file,
    phase: selected.phase,
    attempt: selected.attempt,
  }
}

async function loadCycle(entryName: string, activeDirectory: string | null, sessions: OpenCodeSession[], completedRecord: JsonObject | undefined): Promise<Cycle | null> {
  const match = cyclePattern.exec(entryName)
  if (!match) return null

  const directory = path.join(runtimeRoot, entryName)
  const entries = await readdir(directory, { withFileTypes: true })
  const files = entries.filter((entry) => entry.isFile())
  const artifacts = await Promise.all(files.map(async (entry): Promise<Artifact> => {
    const filename = path.join(directory, entry.name)
    const details = await stat(filename)
    return {
      name: entry.name,
      size: details.size,
      modifiedAt: details.mtime.toISOString(),
      kind: path.extname(entry.name).slice(1) || 'file',
      compactionCount: entry.name.endsWith('.log') ? countCompactions(await readFile(filename, 'utf8')) : 0,
      session: null,
    }
  }))
  artifacts.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
  const matchedSessions = new Map<string, OpenCodeSession>()
  for (const artifact of artifacts.filter((item) => item.name.endsWith('.log'))) {
    const prompt = artifacts.find((item) => item.name === artifact.name.replace(/\.log$/, '.md'))
    const session = matchingSession(prompt, sessions)
    artifact.session = session ? sessionSummary(session) : null
    if (session) matchedSessions.set(session.id, session)
  }

  const context = await readJson(path.join(directory, 'context.json'))
  const result = await readJson(path.join(directory, 'result.json'))
  const review = await readJson(path.join(directory, 'review.json'))
  const accepted = await readJson(path.join(directory, 'accepted.json'))
  const retrospective = await readJson(path.join(directory, 'retrospective.json'))
  const cycleNumber = Number(match[1])
  const startedMs = Number(match[2])
  const isActive = activeDirectory === directory
  // Before accepted.json existed, the coordinator recorded finished cycles in
  // state.history and copied those records into the next cycle's context.
  const legacyComplete = Boolean(!accepted && !retrospective && result && review?.decision === 'accept' && completedRecord)
  const isComplete = Boolean(accepted || retrospective || legacyComplete)

  const phaseTimings = {} as Cycle['phases']
  for (const role of ['worker', 'reviewer', 'retrospective'] as const) {
    const prompts = artifacts.filter((artifact) => artifact.name.match(attemptPattern)?.[1] === role && artifact.name.endsWith('.md'))
    let durationMs = 0
    let measured = 0
    for (const prompt of prompts) {
      const attempt = prompt.name.match(attemptPattern)?.[2]
      const log = artifacts.find((artifact) => artifact.name === `${role}-${attempt}.log`)
      if (log) {
        durationMs += Math.max(0, Date.parse(log.modifiedAt) - Date.parse(prompt.modifiedAt))
        measured += 1
      }
    }
    phaseTimings[role] = { durationMs: measured ? durationMs : null, attempts: prompts.length }
  }

  const endCandidates = artifacts
    .filter((artifact) => /^(accepted|retrospective)\.json$/.test(artifact.name) || /-(\d+)\.log$/.test(artifact.name))
    .map((artifact) => Date.parse(artifact.modifiedAt))
  const endedMs = isComplete && endCandidates.length ? Math.max(...endCandidates) : null
  const retryCount = Object.values(phaseTimings).reduce((total, phase) => total + Math.max(0, phase.attempts - 1), 0)
    + artifacts.filter((artifact) => artifact.name.includes('feedback')).length
  const peakSession = artifacts.reduce<SessionSummary | null>((peak, artifact) => artifact.session && (!peak || artifact.session.maxContextTokens > peak.maxContextTokens) ? artifact.session : peak, null)
  const timeBreakdown = [...matchedSessions.values()].reduce<TimeBreakdown>((total, session) => ({
    inferenceMs: total.inferenceMs + session.inferenceMs,
    toolMs: total.toolMs + session.toolMs,
    delegatedMs: total.delegatedMs + session.delegatedMs,
    firstContentMs: total.firstContentMs + session.firstContentMs,
    reasoningMs: total.reasoningMs + session.reasoningMs,
    outputMs: total.outputMs + session.outputMs,
    toolOutputMs: total.toolOutputMs + session.toolOutputMs,
    otherInferenceMs: total.otherInferenceMs + session.otherInferenceMs,
  }), { inferenceMs: 0, toolMs: 0, delegatedMs: 0, firstContentMs: 0, reasoningMs: 0, outputMs: 0, toolOutputMs: 0, otherInferenceMs: 0 })

  return {
    id: entryName,
    cycle: Number(context?.cycle ?? accepted?.cycle ?? cycleNumber),
    startedAt: new Date(startedMs).toISOString(),
    endedAt: endedMs ? new Date(endedMs).toISOString() : null,
    status: isActive ? 'active' : isComplete ? 'complete' : 'incomplete',
    focus: text(context?.focus, text(accepted?.focus, 'unknown')),
    outcome: text(result?.outcome, text(accepted?.outcome)) || null,
    decision: text(review?.decision) || null,
    summary: text(result?.summary, text(accepted?.summary, 'No result recorded yet.')),
    commit: text(accepted?.commit, legacyComplete ? text(completedRecord?.commit) : '') || null,
    durationMs: endedMs ? Math.max(0, endedMs - startedMs) : null,
    retryCount,
    compactionCount: artifacts.reduce((total, artifact) => total + artifact.compactionCount, 0),
    maxContextTokens: peakSession?.maxContextTokens ?? null,
    contextLimit: peakSession?.contextLimit ?? null,
    timeBreakdown,
    phases: phaseTimings,
    artifacts,
  }
}

async function listStreams(): Promise<Artifact[]> {
  const entries = await readdir(ralphRoot, { withFileTypes: true })
  const streamNames = entries
    .filter((entry) => entry.isFile() && (entry.name === 'history.jsonl' || entry.name.startsWith('events-')))
    .map((entry) => entry.name)
  return Promise.all(streamNames.map(async (name) => {
    const details = await stat(path.join(ralphRoot, name))
    return { name, size: details.size, modifiedAt: details.mtime.toISOString(), kind: 'jsonl', compactionCount: 0, session: null }
  }))
}

function canonicalCycles(cycles: Cycle[]): Cycle[] {
  const statusRank: Record<Cycle['status'], number> = { incomplete: 0, complete: 1, active: 2 }
  const canonical = new Map<number, Cycle>()
  for (const cycle of cycles) {
    const current = canonical.get(cycle.cycle)
    if (!current
      || statusRank[cycle.status] > statusRank[current.status]
      || (cycle.status === current.status && cycle.startedAt > current.startedAt)) {
      canonical.set(cycle.cycle, cycle)
    }
  }
  return [...canonical.values()]
}

async function loadDashboard() {
  const sessions = await loadOpenCodeSessions(true)
  const state = await readJson(path.join(runtimeRoot, 'state.json'))
  const active = state?.active as JsonObject | undefined
  const activeLog = await findActiveLog(state)
  const activeDirectory = active ? text(active.directory) : null
  const directoryEntries = await readdir(runtimeRoot, { withFileTypes: true })
  const cycleEntries = directoryEntries.filter((entry) => entry.isDirectory() && cyclePattern.test(entry.name))
  const completedRecords = new Map<string, JsonObject>()
  const rememberCompleted = (entry: unknown) => {
    if (!entry || typeof entry !== 'object') return
    const record = entry as JsonObject
    const directory = text(record.directory)
    if (path.dirname(directory) === runtimeRoot && cyclePattern.test(path.basename(directory))) {
      completedRecords.set(directory, record)
    }
  }
  for (const entry of Array.isArray(state?.history) ? state.history : []) rememberCompleted(entry)
  const contexts = await Promise.all(cycleEntries.map((entry) => readJson(path.join(runtimeRoot, entry.name, 'context.json'))))
  for (const context of contexts) {
    for (const entry of Array.isArray(context?.recent_outcomes) ? context.recent_outcomes : []) rememberCompleted(entry)
  }
  const cycleDirectories = (await Promise.all(cycleEntries
    .map((entry) => loadCycle(entry.name, activeDirectory, sessions, completedRecords.get(path.join(runtimeRoot, entry.name))))))
    .filter((cycle): cycle is Cycle => cycle !== null)
    .sort((a, b) => a.cycle - b.cycle || a.startedAt.localeCompare(b.startedAt))
  const cycles = canonicalCycles(cycleDirectories)

  const complete = cycles.filter((cycle) => cycle.status === 'complete')
  const durations = complete.flatMap((cycle) => cycle.durationMs === null ? [] : [cycle.durationMs])
  const phaseTotals = { worker: 0, reviewer: 0, retrospective: 0 }
  for (const cycle of cycles) {
    for (const role of Object.keys(phaseTotals) as Array<keyof typeof phaseTotals>) {
      phaseTotals[role] += cycle.phases[role].durationMs || 0
    }
  }
  const measuredPhaseTime = Object.values(phaseTotals).reduce((sum, value) => sum + value, 0)

  const changedCycles = complete.filter((cycle) => cycle.outcome === 'change').length

  return {
    project: { name: path.basename(projectRoot), path: projectRoot, ralphPath: ralphRoot },
    capabilities: { deleteActiveCycle: true, discardActiveStep: true },
    generatedAt: new Date().toISOString(),
    active: active ? {
      phase: text(active.phase, activeLog?.phase),
      attempt: Number(active.attempt || activeLog?.attempt || 1),
      cycle: Number(active.cycle || activeLog?.cycle || cycles.at(-1)?.cycle || 0),
      logFile: activeLog?.file || null,
    } : null,
    metrics: {
      totalCycles: cycles.length,
      completedCycles: complete.length,
      retryRate: cycles.length ? cycles.filter((cycle) => cycle.retryCount > 0).length / cycles.length : 0,
      changeRate: complete.length ? changedCycles / complete.length : 0,
      changedCycles,
      medianCycleMs: quantile(durations, 0.5),
      p90CycleMs: quantile(durations, 0.9),
      phaseShare: Object.fromEntries(Object.entries(phaseTotals).map(([role, value]) => [role, measuredPhaseTime ? value / measuredPhaseTime : 0])),
      outcomes: Object.fromEntries([...new Set(cycles.map((cycle) => cycle.outcome || cycle.status))].map((outcome) => [outcome, cycles.filter((cycle) => (cycle.outcome || cycle.status) === outcome).length])),
      focuses: Object.fromEntries([...new Set(cycles.map((cycle) => cycle.focus))].map((focus) => [focus, cycles.filter((cycle) => cycle.focus === focus).length])),
    },
    cycles,
    streams: await listStreams(),
  }
}

function safeFile(base: string, requested: string): string | null {
  const resolved = path.resolve(base, requested)
  return resolved.startsWith(`${base}${path.sep}`) ? resolved : null
}

app.get('/api/dashboard', async (_request, response, next) => {
  try { response.json(await loadDashboard()) } catch (error) { next(error) }
})

app.delete('/api/cycles/:cycle', async (request, response, next) => {
  try {
    const requestedCycle = request.params.cycle
    if (!cyclePattern.test(requestedCycle)) return response.status(400).json({ error: 'Invalid cycle' })

    const state = await readJson(path.join(runtimeRoot, 'state.json'))
    const active = state?.active as JsonObject | undefined
    const activeDirectory = path.resolve(text(active?.directory))
    if (!active || path.dirname(activeDirectory) !== runtimeRoot || path.basename(activeDirectory) !== requestedCycle) {
      return response.status(409).json({ error: 'Only the current unfinished cycle can be deleted' })
    }

    const entries = await readdir(runtimeRoot, { withFileTypes: true })
    const latestCycle = entries
      .filter((entry) => entry.isDirectory() && cyclePattern.test(entry.name))
      .map((entry) => ({ name: entry.name, parts: cyclePattern.exec(entry.name)! }))
      .sort((left, right) => Number(right.parts[1]) - Number(left.parts[1]) || Number(right.parts[2]) - Number(left.parts[2]))[0]
    if (latestCycle?.name !== requestedCycle) {
      return response.status(409).json({ error: 'Only the latest cycle can be deleted' })
    }

    const resetScript = path.join(projectRoot, 'scripts', 'continuous-improvement.cjs')
    if (!existsSync(resetScript)) return response.status(501).json({ error: 'This project does not provide a cycle reset command' })
    try {
      await execFileAsync(process.execPath, [resetScript, '--reset-cycle'], { cwd: projectRoot })
    } catch (error) {
      const details = error as Error & { stderr?: string }
      return response.status(409).json({ error: details.stderr?.trim() || details.message })
    }
    response.json(await loadDashboard())
  } catch (error) { next(error) }
})

app.delete('/api/cycles/:cycle/step', async (request, response, next) => {
  try {
    const requestedCycle = request.params.cycle
    if (!cyclePattern.test(requestedCycle)) return response.status(400).json({ error: 'Invalid cycle' })

    const state = await readJson(path.join(runtimeRoot, 'state.json'))
    const active = state?.active as JsonObject | undefined
    const activeDirectory = path.resolve(text(active?.directory))
    if (!active || path.dirname(activeDirectory) !== runtimeRoot || path.basename(activeDirectory) !== requestedCycle) {
      return response.status(409).json({ error: 'Only the current incomplete workflow step can be discarded' })
    }

    const resetScript = path.join(projectRoot, 'scripts', 'continuous-improvement.cjs')
    if (!existsSync(resetScript)) return response.status(501).json({ error: 'This project does not provide a step reset command' })
    try {
      await execFileAsync(process.execPath, [resetScript, '--reset-step'], { cwd: projectRoot })
    } catch (error) {
      const details = error as Error & { stderr?: string }
      return response.status(409).json({ error: details.stderr?.trim() || details.message })
    }
    response.json(await loadDashboard())
  } catch (error) { next(error) }
})

app.get('/api/artifact', async (request, response, next) => {
  try {
    const cycle = String(request.query.cycle || '')
    const file = String(request.query.file || '')
    if (!cyclePattern.test(cycle)) return response.status(400).json({ error: 'Invalid cycle' })
    const cycleRoot = path.join(runtimeRoot, cycle)
    const resolved = safeFile(cycleRoot, file)
    if (!resolved || !existsSync(resolved) || !textExtensions.has(path.extname(resolved))) {
      return response.status(404).json({ error: 'Artifact not found or not viewable' })
    }
    const details = await stat(resolved)
    if (!details.isFile() || details.size > 2 * 1024 * 1024) return response.status(413).json({ error: 'Artifact is too large' })
    response.type('text/plain').send(await readFile(resolved, 'utf8'))
  } catch (error) { next(error) }
})

app.get('/api/artifact-telemetry', async (request, response, next) => {
  try {
    const cycle = String(request.query.cycle || '')
    const file = String(request.query.file || '')
    if (!cyclePattern.test(cycle) || !attemptPattern.test(file) || !file.endsWith('.log')) return response.status(400).json({ error: 'Invalid role log' })
    const directory = path.join(runtimeRoot, cycle)
    await stat(path.join(directory, file))
    const promptName = file.replace(/\.log$/, '.md')
    const promptDetails = await stat(path.join(directory, promptName))
    const prompt: Artifact = { name: promptName, size: promptDetails.size, modifiedAt: promptDetails.mtime.toISOString(), kind: 'md', compactionCount: 0, session: null }
    const sessions = await loadOpenCodeSessions()
    const session = matchingSession(prompt, sessions)
    response.json(session ? sessionTelemetry(session, sessions) : null)
  } catch (error) { next(error) }
})

app.get('/api/stream', async (request, response, next) => {
  try {
    const file = path.basename(String(request.query.file || ''))
    if (!(file === 'history.jsonl' || /^events-[\d-]+\.jsonl$/.test(file))) return response.status(400).json({ error: 'Invalid stream' })
    response.type('text/plain').send(await readFile(path.join(ralphRoot, file), 'utf8'))
  } catch (error) { next(error) }
})

app.get('/api/live-log', async (request, response) => {
  response.set({
    'Cache-Control': 'no-cache, no-transform',
    'Content-Type': 'text/event-stream',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  })
  response.flushHeaders()

  let lastSignature = ''
  let reading = false
  const sendUpdate = async () => {
    if (reading || response.writableEnded) return
    reading = true
    try {
      const state = await readJson(path.join(runtimeRoot, 'state.json'))
      const activeLog = await findActiveLog(state)
      if (!activeLog) {
        if (lastSignature !== 'idle') {
          response.write(`event: idle\ndata: ${JSON.stringify({ active: false })}\n\n`)
          lastSignature = 'idle'
        }
        return
      }

      const filename = path.join(activeLog.directory, activeLog.file)
      const details = await stat(filename)
      const contents = await readFile(filename)
      const tail = contents.subarray(Math.max(0, contents.length - liveLogLimit)).toString('utf8')
      const promptName = activeLog.file.replace(/\.log$/, '.md')
      const promptFilename = path.join(activeLog.directory, promptName)
      const promptDetails = existsSync(promptFilename) ? await stat(promptFilename) : null
      const promptArtifact: Artifact | undefined = promptDetails
        ? { name: promptName, size: promptDetails.size, modifiedAt: promptDetails.mtime.toISOString(), kind: 'md', compactionCount: 0, session: null }
        : undefined
      const sessions = await loadOpenCodeSessions()
      const session = matchingSession(promptArtifact, sessions)
      const payload = JSON.stringify({
        active: true,
        cycle: activeLog.cycle,
        phase: activeLog.phase,
        attempt: activeLog.attempt,
        file: activeLog.file,
        content: tail,
        compactionCount: countCompactions(contents.toString('utf8')),
        session: session ? sessionTelemetry(session, sessions) : null,
        size: details.size,
        truncated: contents.length > liveLogLimit,
        updatedAt: details.mtime.toISOString(),
      })
      if (payload === lastSignature) return
      response.write(`event: log\ndata: ${payload}\n\n`)
      lastSignature = payload
    } catch (error) {
      response.write(`event: stream-error\ndata: ${JSON.stringify({ message: error instanceof Error ? error.message : 'Unable to read active log' })}\n\n`)
    } finally {
      reading = false
    }
  }

  await sendUpdate()
  const refresh = setInterval(() => void sendUpdate(), 1000)
  const heartbeat = setInterval(() => response.write(': keepalive\n\n'), 15000)
  request.on('close', () => {
    clearInterval(refresh)
    clearInterval(heartbeat)
  })
})

app.use(express.static(path.join(import.meta.dirname, '..', 'dist')))
app.get('/{*path}', (_request, response) => response.sendFile(path.join(import.meta.dirname, '..', 'dist', 'index.html')))
app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
  console.error(error)
  response.status(500).json({ error: error instanceof Error ? error.message : 'Unexpected error' })
})

if (process.env.NODE_ENV !== 'test') {
  app.listen(port, host, () => {
    console.log(`Ralph dashboard listening on http://${host}:${port}`)
    console.log(`Reading: ${ralphRoot}`)
  })
}

export { app }
