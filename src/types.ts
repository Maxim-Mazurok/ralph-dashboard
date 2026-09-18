export type PhaseName = 'worker' | 'reviewer' | 'retrospective'

export type Artifact = {
  name: string
  size: number
  modifiedAt: string
  kind: string
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
  phases: Record<PhaseName, { durationMs: number | null; attempts: number }>
  artifacts: Artifact[]
}

export type DashboardData = {
  project: { name: string; path: string; ralphPath: string }
  generatedAt: string
  active: { phase: string; attempt: number; cycle: number } | null
  metrics: {
    totalCycles: number
    completedCycles: number
    retryRate: number
    loopFailureRate: number
    loopRuns: number
    failedLoops: number
    medianCycleMs: number | null
    p90CycleMs: number | null
    phaseShare: Record<PhaseName, number>
    outcomes: Record<string, number>
    focuses: Record<string, number>
  }
  cycles: Cycle[]
  streams: Artifact[]
}
