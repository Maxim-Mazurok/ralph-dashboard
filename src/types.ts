export type PhaseName = 'worker' | 'reviewer' | 'retrospective'

export type SessionSummary = {
  model: string
  maxContextTokens: number
  contextLimit: number | null
  reasoningTokens: number
  reasoningCount: number
  inferenceMs: number
  toolMs: number
  reasoningMs: number
  outputMs: number
  otherInferenceMs: number
}

export type SessionTelemetry = SessionSummary & {
  reasoning: Array<{ text: string; startedAt: number | null; endedAt: number | null }>
  events: Array<{
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
  }>
}

export type Artifact = {
  name: string
  size: number
  modifiedAt: string
  kind: string
  compactionCount: number
  session: SessionSummary | null
}

export type Cycle = {
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
  timeBreakdown: {
    inferenceMs: number
    toolMs: number
    reasoningMs: number
    outputMs: number
    otherInferenceMs: number
  }
  phases: Record<PhaseName, { durationMs: number | null; attempts: number }>
  artifacts: Artifact[]
}

export type DashboardData = {
  project: { name: string; path: string; ralphPath: string }
  capabilities?: { deleteActiveCycle: boolean }
  generatedAt: string
  active: { phase: string; attempt: number; cycle: number; logFile: string | null } | null
  metrics: {
    totalCycles: number
    completedCycles: number
    retryRate: number
    changeRate: number
    changedCycles: number
    medianCycleMs: number | null
    p90CycleMs: number | null
    phaseShare: Record<PhaseName, number>
    outcomes: Record<string, number>
    focuses: Record<string, number>
  }
  cycles: Cycle[]
  streams: Artifact[]
}
