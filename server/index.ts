import express from 'express'
import { existsSync } from 'node:fs'
import { readdir, readFile, stat } from 'node:fs/promises'
import path from 'node:path'

const app = express()
const port = Number(process.env.PORT || 4310)
const projectRoot = path.resolve(process.env.RALPH_PROJECT_PATH || '/home/user/home-inventory')
const ralphRoot = path.join(projectRoot, '.ralph')
const runtimeRoot = path.join(ralphRoot, 'runtime')
const cyclePattern = /^cycle-(\d+)-(\d+)$/
const attemptPattern = /^(worker|reviewer|retrospective)-(\d+)\.(md|log)$/
const textExtensions = new Set(['.json', '.jsonl', '.log', '.md', '.txt'])

type JsonObject = Record<string, unknown>
type Artifact = { name: string; size: number; modifiedAt: string; kind: string }
type PhaseTiming = { durationMs: number | null; attempts: number }

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

async function loadCycle(entryName: string, activeDirectory: string | null): Promise<Cycle | null> {
  const match = cyclePattern.exec(entryName)
  if (!match) return null

  const directory = path.join(runtimeRoot, entryName)
  const entries = await readdir(directory, { withFileTypes: true })
  const files = entries.filter((entry) => entry.isFile())
  const artifacts = await Promise.all(files.map(async (entry): Promise<Artifact> => {
    const details = await stat(path.join(directory, entry.name))
    return {
      name: entry.name,
      size: details.size,
      modifiedAt: details.mtime.toISOString(),
      kind: path.extname(entry.name).slice(1) || 'file',
    }
  }))
  artifacts.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))

  const context = await readJson(path.join(directory, 'context.json'))
  const result = await readJson(path.join(directory, 'result.json'))
  const review = await readJson(path.join(directory, 'review.json'))
  const accepted = await readJson(path.join(directory, 'accepted.json'))
  const retrospective = await readJson(path.join(directory, 'retrospective.json'))
  const cycleNumber = Number(match[1])
  const startedMs = Number(match[2])
  const isActive = activeDirectory === directory
  const isComplete = Boolean(accepted || retrospective)

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
    commit: text(accepted?.commit) || null,
    durationMs: endedMs ? Math.max(0, endedMs - startedMs) : null,
    retryCount,
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
    return { name, size: details.size, modifiedAt: details.mtime.toISOString(), kind: 'jsonl' }
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
  const state = await readJson(path.join(runtimeRoot, 'state.json'))
  const active = state?.active as JsonObject | undefined
  const activeDirectory = active ? text(active.directory) : null
  const directoryEntries = await readdir(runtimeRoot, { withFileTypes: true })
  const cycleDirectories = (await Promise.all(directoryEntries
    .filter((entry) => entry.isDirectory() && cyclePattern.test(entry.name))
    .map((entry) => loadCycle(entry.name, activeDirectory))))
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
    generatedAt: new Date().toISOString(),
    active: active ? { phase: text(active.phase), attempt: Number(active.attempt || 1), cycle: Number(active.cycle || cycles.at(-1)?.cycle || 0) } : null,
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

app.get('/api/stream', async (request, response, next) => {
  try {
    const file = path.basename(String(request.query.file || ''))
    if (!(file === 'history.jsonl' || /^events-[\d-]+\.jsonl$/.test(file))) return response.status(400).json({ error: 'Invalid stream' })
    response.type('text/plain').send(await readFile(path.join(ralphRoot, file), 'utf8'))
  } catch (error) { next(error) }
})

app.use(express.static(path.join(import.meta.dirname, '..', 'dist')))
app.get('/{*path}', (_request, response) => response.sendFile(path.join(import.meta.dirname, '..', 'dist', 'index.html')))
app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
  console.error(error)
  response.status(500).json({ error: error instanceof Error ? error.message : 'Unexpected error' })
})

app.listen(port, () => {
  console.log(`Ralph dashboard: http://localhost:${port}`)
  console.log(`Reading: ${ralphRoot}`)
})
