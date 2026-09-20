import { startTransition, useDeferredValue, useEffect, useRef, useState } from 'react'
import Convert from 'ansi-to-html'
import ReactMarkdown from 'react-markdown'
import ReactDiffViewer, { DiffMethod } from 'react-diff-viewer-continued'
import remarkGfm from 'remark-gfm'
import {
  Activity, AlertTriangle, Archive, BarChart3, CheckCircle2, Clock3,
  BrainCircuit, FileText, FolderOpen, Pause, Play, Radio, RefreshCw, Search, TimerReset, X,
} from 'lucide-react'
import {
  Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, Legend, Line,
  LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts'
import type { Artifact, Cycle, DashboardData, PhaseName, SessionSummary, SessionTelemetry } from './types'
import './App.css'

const phaseColors: Record<PhaseName, string> = {
  worker: '#d65a31',
  reviewer: '#287271',
  retrospective: '#daa520',
}
const outcomeColors: Record<string, string> = {
  change: '#287271', investigation: '#d19a32', no_change: '#87908d',
  incomplete: '#c6483d', active: '#3277a8',
}

function duration(value: number | null): string {
  if (value === null) return '—'
  const minutes = Math.round(value / 60000)
  return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}
function percent(value: number): string { return `${Math.round(value * 100)}%` }
function bytes(value: number): string {
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
  return `${(value / 1024 / 1024).toFixed(1)} MB`
}
function date(value: string): string {
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(value))
}
function tokens(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—'
  return new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(value)
}
function contextPercent(session: SessionSummary): string | null {
  return Number.isFinite(session.maxContextTokens) && session.contextLimit ? percent(session.maxContextTokens / session.contextLimit) : null
}
function peakSession(artifacts: Artifact[], role?: PhaseName): SessionSummary | null {
  return artifacts.reduce<SessionSummary | null>((peak, artifact) => {
    if (!artifact.session || (role && !artifact.name.startsWith(`${role}-`))) return peak
    return !peak || artifact.session.maxContextTokens > peak.maxContextTokens ? artifact.session : peak
  }, null)
}

function Metric({ label, value, note, icon: Icon }: { label: string; value: string; note: string; icon: typeof Clock3 }) {
  return <div className="metric"><div className="metric-label"><Icon size={15} />{label}</div><strong>{value}</strong><span>{note}</span></div>
}
function EmptyChart() { return <div className="empty-chart">Not enough measured data yet</div> }

const ansiConverter = new Convert({
  bg: '#101719',
  fg: '#d8e2df',
  newline: true,
  escapeXML: true,
})

function terminalHtml(content: string): string {
  return ansiConverter.toHtml(content.replace(/\r(?!\n)/g, '\n'))
}

function toolInput(input: unknown): string {
  if (input === undefined) return ''
  return typeof input === 'string' ? input : JSON.stringify(input, null, 2)
}

function fallbackEditDiff(input: unknown): string | null {
  if (!input || typeof input !== 'object') return null
  const values = input as Record<string, unknown>
  if (typeof values.oldString !== 'string' || typeof values.newString !== 'string') return null
  const filename = typeof values.filePath === 'string' ? values.filePath : 'file'
  const removed = values.oldString.split('\n').map((line) => `-${line}`)
  const added = values.newString.split('\n').map((line) => `+${line}`)
  return [`--- ${filename}`, `+++ ${filename}`, '@@ replacement @@', ...removed, ...added].join('\n')
}

function editValues(input: unknown): { oldValue: string; newValue: string } | null {
  if (!input || typeof input !== 'object') return null
  const values = input as Record<string, unknown>
  return typeof values.oldString === 'string' && typeof values.newString === 'string'
    ? { oldValue: values.oldString, newValue: values.newString }
    : null
}

function DiffOutput({ content }: { content: string }) {
  return <div className="diff-output">{content.split('\n').map((line, index) => {
    const className = line.startsWith('@@') ? 'hunk'
      : /^(?:diff --git|Index:|={3,}|--- |\+\+\+ )/.test(line) ? 'header'
        : line.startsWith('+') ? 'added'
          : line.startsWith('-') ? 'removed' : 'context'
    return <div className={className} key={index}>{line || '\u00a0'}</div>
  })}</div>
}

const splitDiffStyles = {
  variables: { dark: {
    diffViewerBackground: '#101719', diffViewerTitleBackground: '#172225', diffViewerColor: '#829496',
    diffViewerTitleColor: '#d8e2df', diffViewerTitleBorderColor: '#2d3b3e',
    addedBackground: '#153128', addedColor: '#9bc9b4', removedBackground: '#351e1d', removedColor: '#d2a29b',
    wordAddedBackground: '#17613f', wordRemovedBackground: '#7a302b',
    addedGutterBackground: '#1d4939', removedGutterBackground: '#532825', gutterBackground: '#172225',
    gutterBackgroundDark: '#131d1f', codeFoldGutterBackground: '#172225', codeFoldBackground: '#172225',
    emptyLineBackground: '#131d1f', gutterColor: '#718183', addedGutterColor: '#bcebd3',
    removedGutterColor: '#f0bbb2', codeFoldContentColor: '#829496',
  } },
  diffContainer: { fontFamily: "'DM Mono', monospace", fontSize: '10px', lineHeight: 1.55 },
  lineContent: { minWidth: 0, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' },
  contentText: { padding: '0 8px', whiteSpace: 'pre-wrap' },
  wordAdded: { color: '#dcffe8' },
  wordRemoved: { color: '#ffe0dc' },
} as const

function EditDiff({ input, fallback }: { input: unknown; fallback: string }) {
  const values = editValues(input)
  if (!values) return <DiffOutput content={fallback} />
  return <div className="split-diff"><ReactDiffViewer
    oldValue={values.oldValue}
    newValue={values.newValue}
    splitView
    compareMethod={DiffMethod.CHARS}
    showDiffOnly
    extraLinesSurroundingDiff={3}
    leftTitle="Before"
    rightTitle="After"
    useDarkTheme
    styles={splitDiffStyles}
  /></div>
}

function firstLine(value: string | undefined): string {
  return value?.split('\n').find((line) => line.trim())?.trim() || ''
}

function eventTime(value: number): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).format(new Date(value))
}

function liveTail(content: string): string {
  return content.slice(-12 * 1024).split('\n').slice(-40).join('\n')
}

function hasToolInput(input: unknown): boolean {
  return input !== undefined && (typeof input !== 'object' || input === null || Object.keys(input).length > 0)
}

function TerminalOutput({ content, session, outputRef, live = false }: { content: string; session: SessionTelemetry | null; outputRef?: React.RefObject<HTMLDivElement | null>; live?: boolean }) {
  const events = session?.events || []
  const hasPendingTool = events.some((event) => event.type === 'tool' && !['completed', 'error'].includes(event.status || 'pending'))
  return <div className="terminal-output" ref={outputRef}>
    {events.length ? <div className="session-timeline">{events.map((event) => {
      if (event.type === 'reasoning') {
        return <div className="timeline-row" key={event.id}><time dateTime={new Date(event.createdAt).toISOString()}>{eventTime(event.createdAt)}</time><details className="reasoning-block"><summary><BrainCircuit size={13} /><span className="summary-label">Thinking</span><span className="summary-preview">{firstLine(event.text)}</span></summary><pre>{event.text}</pre></details></div>
      }
      if (event.type === 'text') return <div className="timeline-row" key={event.id}><time dateTime={new Date(event.createdAt).toISOString()}>{eventTime(event.createdAt)}</time><pre className="assistant-output">{event.text}</pre></div>
      const editDiff = event.tool === 'edit' ? event.diff || fallbackEditDiff(event.input) : null
      return <div className="timeline-row" key={event.id}><time dateTime={new Date(event.createdAt).toISOString()}>{eventTime(event.createdAt)}</time><details className={`tool-event ${event.status || 'pending'}`}>
        <summary><span className="tool-name">{event.tool || 'tool'}</span><span className="summary-preview">{event.title || event.status || 'pending'}</span></summary>
        <div className="tool-detail">
          {editDiff ? <><strong>Changes</strong><EditDiff input={event.input} fallback={editDiff} />{hasToolInput(event.input) && <details className="raw-input"><summary>Original edit input</summary><pre>{toolInput(event.input)}</pre></details>}</> : hasToolInput(event.input) && <><strong>Input</strong><pre>{toolInput(event.input)}</pre></>}
          {event.output && <><strong>{event.status === 'error' ? 'Error' : 'Output'}</strong><pre dangerouslySetInnerHTML={{ __html: terminalHtml(event.output) }} /></>}
        </div>
      </details></div>
    })}{live && hasPendingTool && <div className="live-pending-output"><strong>Streaming</strong><pre dangerouslySetInnerHTML={{ __html: terminalHtml(liveTail(content)) }} /></div>}</div> : <pre dangerouslySetInnerHTML={{ __html: terminalHtml(content) }} />}
  </div>
}

type LiveLogUpdate = {
  active: boolean
  cycle: number
  phase: string
  attempt: number
  file: string
  content: string
  compactionCount: number
  session: SessionTelemetry | null
  size: number
  truncated: boolean
  updatedAt: string
}

function LiveLogDrawer({ onClose }: { onClose: () => void }) {
  const [update, setUpdate] = useState<LiveLogUpdate | null>(null)
  const [status, setStatus] = useState<'connecting' | 'live' | 'idle' | 'error'>('connecting')
  const [following, setFollowing] = useState(true)
  const outputRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const source = new EventSource('/api/live-log')
    source.addEventListener('log', (event) => {
      setUpdate(JSON.parse((event as MessageEvent<string>).data) as LiveLogUpdate)
      setStatus('live')
    })
    source.addEventListener('idle', () => setStatus('idle'))
    source.addEventListener('stream-error', () => setStatus('error'))
    source.onerror = () => setStatus('error')
    return () => source.close()
  }, [])

  useEffect(() => {
    if (following && outputRef.current) outputRef.current.scrollTop = outputRef.current.scrollHeight
  }, [following, update?.content])

  return <div className="drawer-backdrop" onMouseDown={onClose}>
    <aside className="drawer live-drawer" onMouseDown={(event) => event.stopPropagation()}>
      <header>
        <div><Radio size={18} /><strong>{update ? `Cycle ${update.cycle} · ${update.phase} ${update.attempt}` : 'Active cycle log'}</strong><span className={`live-state ${status}`}>{status}</span></div>
        <div className="drawer-actions">
          <button className="follow-button" title={following ? 'Pause auto-scroll' : 'Resume auto-scroll'} onClick={() => setFollowing((current) => !current)}>{following ? <Pause size={15} /> : <Play size={15} />}{following ? 'Following' : 'Paused'}</button>
          <button className="icon-button" title="Close live log" onClick={onClose}><X size={18} /></button>
        </div>
      </header>
      <div className="live-meta">
        <span>{update?.file || 'Waiting for an active role log…'}</span>
        {update && <span>{update.compactionCount} context compaction{update.compactionCount === 1 ? '' : 's'}{update.session ? ` · ${tokens(update.session.maxContextTokens)} / ${tokens(update.session.contextLimit)} context${contextPercent(update.session) ? ` (${contextPercent(update.session)})` : ''}` : ''} · {bytes(update.size)} · {date(update.updatedAt)}{update.truncated ? ' · latest 256 KB' : ''}</span>}
      </div>
      <TerminalOutput live outputRef={outputRef} session={update?.session || null} content={update?.content || (status === 'idle' ? 'No active cycle log.' : status === 'error' ? 'Connection interrupted. Reconnecting…' : 'Connecting to active cycle…')} />
    </aside>
  </div>
}

function App() {
  const [data, setData] = useState<DashboardData | null>(null)
  const [error, setError] = useState('')
  const [refreshing, setRefreshing] = useState(false)
  const [range, setRange] = useState(12)
  const [query, setQuery] = useState('')
  const deferredQuery = useDeferredValue(query)
  const [selectedCycleId, setSelectedCycleId] = useState('')
  const [artifact, setArtifact] = useState<{ title: string; content: string; terminal: boolean; markdown: boolean; session: SessionTelemetry | null } | null>(null)
  const [liveLogOpen, setLiveLogOpen] = useState(false)

  async function load(showRefreshing = true) {
    if (showRefreshing) setRefreshing(true)
    try {
      const response = await fetch('/api/dashboard')
      if (!response.ok) throw new Error(`API returned ${response.status}`)
      const next = await response.json() as DashboardData
      startTransition(() => {
        setData(next)
        setSelectedCycleId((current) => current || next.cycles.at(-1)?.id || '')
        setError('')
      })
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Unable to load Ralph data')
    } finally { if (showRefreshing) setRefreshing(false) }
  }
  useEffect(() => {
    let cancelled = false
    fetch('/api/dashboard')
      .then((response) => {
        if (!response.ok) throw new Error(`API returned ${response.status}`)
        return response.json() as Promise<DashboardData>
      })
      .then((next) => {
        if (cancelled) return
        startTransition(() => {
          setData(next)
          setSelectedCycleId(next.cycles.at(-1)?.id || '')
        })
      })
      .catch((caught: unknown) => {
        if (!cancelled) setError(caught instanceof Error ? caught.message : 'Unable to load Ralph data')
      })
    return () => { cancelled = true }
  }, [])

  async function openArtifact(cycle: string, name: string) {
    const terminal = name.endsWith('.log')
    const markdown = /\.md(?:own)?$/i.test(name)
    setArtifact({ title: name, content: 'Loading…', terminal, markdown, session: null })
    const [response, telemetryResponse] = await Promise.all([
      fetch(`/api/artifact?cycle=${encodeURIComponent(cycle)}&file=${encodeURIComponent(name)}`),
      terminal ? fetch(`/api/artifact-telemetry?cycle=${encodeURIComponent(cycle)}&file=${encodeURIComponent(name)}`) : null,
    ])
    const session = telemetryResponse?.ok ? await telemetryResponse.json() as SessionTelemetry | null : null
    setArtifact({ title: name, content: response.ok ? await response.text() : `Unable to open artifact (${response.status})`, terminal, markdown, session })
  }
  async function openStream(name: string) {
    setArtifact({ title: name, content: 'Loading…', terminal: false, markdown: false, session: null })
    const response = await fetch(`/api/stream?file=${encodeURIComponent(name)}`)
    setArtifact({ title: name, content: response.ok ? await response.text() : `Unable to open stream (${response.status})`, terminal: false, markdown: false, session: null })
  }

  if (!data && !error) return <main className="loading"><Activity className="spin" /> Reading Ralph evidence…</main>
  if (!data) return <main className="loading error"><AlertTriangle /> {error}<button onClick={() => void load()}>Retry</button></main>

  const visibleCycles = data.cycles.slice(range === 0 ? 0 : -range)
  const measuredCycles = visibleCycles.filter((cycle) => cycle.status === 'complete')
  const timingData = measuredCycles.map((cycle) => ({
    cycle: `#${cycle.cycle}`,
    total: cycle.durationMs ? Math.round(cycle.durationMs / 60000) : null,
  }))
  const phaseTrend = measuredCycles.map((cycle) => {
    const values = Object.fromEntries((Object.keys(phaseColors) as PhaseName[]).map((phase) => [phase, cycle.phases[phase].durationMs || 0])) as Record<PhaseName, number>
    const total = values.worker + values.reviewer + values.retrospective
    return { cycle: `#${cycle.cycle}`, ...Object.fromEntries((Object.keys(values) as PhaseName[]).map((phase) => [phase, total ? Math.round(values[phase] / total * 100) : 0])) }
  })
  const outcomeData = Object.entries(data.metrics.outcomes).map(([name, value]) => ({ name: name.replace('_', ' '), key: name, value }))
  const filteredCycles = [...data.cycles].reverse().filter((cycle: Cycle) => `${cycle.cycle} ${cycle.focus} ${cycle.outcome} ${cycle.summary}`.toLowerCase().includes(deferredQuery.toLowerCase()))
  const selected = data.cycles.find((cycle) => cycle.id === selectedCycleId) || filteredCycles[0]

  return <div className="app-shell">
    <header className="topbar">
      <div className="brand-mark"><BarChart3 size={20} /></div>
      <div className="brand"><strong>Ralph Observatory</strong><span>{data.project.name}</span></div>
      <div className="source"><span className={data.active ? 'pulse' : 'dot'} />{data.active ? `Cycle ${data.active.cycle} · ${data.active.phase}` : 'Loop idle'}</div>
      <button className="live-button" onClick={() => setLiveLogOpen(true)} disabled={!data.active}><Radio size={15} />Live log</button>
      <button className="icon-button" title="Refresh data" onClick={() => void load()} disabled={refreshing}><RefreshCw size={17} className={refreshing ? 'spin' : ''} /></button>
    </header>

    <main>
      <section className="page-heading">
        <div><p className="eyebrow">READ-ONLY LOOP TELEMETRY</p><h1>Cycle performance</h1><p>Outcomes, workflow time, and the evidence behind every run.</p></div>
        <div className="path-label" title={data.project.path}>{data.project.path}</div>
      </section>
      {error && <div className="inline-error"><AlertTriangle size={16} />Refresh failed: {error}</div>}

      <section className="metrics-grid">
        <Metric icon={CheckCircle2} label="Completed" value={`${data.metrics.completedCycles}`} note={`${data.metrics.totalCycles} cycle directories`} />
        <Metric icon={Clock3} label="Median cycle" value={duration(data.metrics.medianCycleMs)} note={`P90 ${duration(data.metrics.p90CycleMs)} · approx.`} />
        <Metric icon={TimerReset} label="Needed retry" value={percent(data.metrics.retryRate)} note="Retries or feedback artifacts" />
        <Metric icon={Activity} label="Change outcomes" value={percent(data.metrics.changeRate)} note={`${data.metrics.changedCycles} of ${data.metrics.completedCycles} completed cycles`} />
      </section>

      <div className="section-bar"><div><h2>Time & throughput</h2><p>Role timings use prompt and log filesystem timestamps.</p></div><div className="segmented" aria-label="Cycle range">
        {[8, 12, 0].map((value) => <button key={value} className={range === value ? 'active' : ''} onClick={() => setRange(value)}>{value || 'All'}</button>)}
      </div></div>

      <section className="chart-grid">
        <article className="chart-panel wide">
          <div className="panel-title"><div><h3>Cycle duration</h3><p>Total elapsed time, minutes</p></div><span className="approx">APPROX.</span></div>
          {timingData.some((point) => point.total !== null) ? <ResponsiveContainer width="100%" height={260}><LineChart data={timingData} margin={{ top: 12, right: 18, left: -16, bottom: 0 }}>
            <CartesianGrid stroke="#d8d9d2" vertical={false} strokeDasharray="2 4" /><XAxis dataKey="cycle" tickLine={false} axisLine={false} /><YAxis tickLine={false} axisLine={false} unit="m" />
            <Tooltip formatter={(value) => [`${value} min`, 'Duration']} /><Line type="monotone" dataKey="total" stroke="#1f4e5f" strokeWidth={2.5} dot={{ r: 3, fill: '#f5f3ec' }} connectNulls={false} />
          </LineChart></ResponsiveContainer> : <EmptyChart />}
        </article>

        <article className="chart-panel">
          <div className="panel-title"><div><h3>Outcome mix</h3><p>All observed cycle directories</p></div></div>
          <ResponsiveContainer width="100%" height={260}><BarChart data={outcomeData} layout="vertical" margin={{ top: 15, right: 22, left: 18, bottom: 0 }}>
            <CartesianGrid stroke="#d8d9d2" horizontal={false} strokeDasharray="2 4" /><XAxis type="number" allowDecimals={false} tickLine={false} axisLine={false} /><YAxis type="category" dataKey="name" width={86} tickLine={false} axisLine={false} /><Tooltip cursor={{ fill: '#efeee8' }} />
            <Bar dataKey="value" radius={[0, 3, 3, 0]} barSize={22}>{outcomeData.map((item) => <Cell key={item.key} fill={outcomeColors[item.key] || '#607176'} />)}</Bar>
          </BarChart></ResponsiveContainer>
        </article>

        <article className="chart-panel wide">
          <div className="panel-title"><div><h3>Workflow share over time</h3><p>Percent of measured role time per cycle</p></div></div>
          <ResponsiveContainer width="100%" height={260}><AreaChart data={phaseTrend} margin={{ top: 12, right: 18, left: -16, bottom: 0 }} stackOffset="expand">
            <CartesianGrid stroke="#d8d9d2" vertical={false} strokeDasharray="2 4" /><XAxis dataKey="cycle" tickLine={false} axisLine={false} /><YAxis tickFormatter={(value) => `${Math.round(value * 100)}%`} tickLine={false} axisLine={false} /><Tooltip formatter={(value) => [`${Number(value).toFixed(0)}%`]} /><Legend iconType="square" />
            {(Object.keys(phaseColors) as PhaseName[]).map((phase) => <Area key={phase} type="monotone" dataKey={phase} stackId="share" stroke={phaseColors[phase]} fill={phaseColors[phase]} fillOpacity={0.82} />)}
          </AreaChart></ResponsiveContainer>
        </article>

        <article className="chart-panel phase-summary">
          <div className="panel-title"><div><h3>Measured time split</h3><p>Across all available role logs</p></div></div>
          {(Object.keys(phaseColors) as PhaseName[]).map((phase) => <div className="phase-row" key={phase}><span className="swatch" style={{ background: phaseColors[phase] }} /><span>{phase}</span><strong>{percent(data.metrics.phaseShare[phase])}</strong><div className="phase-track"><span style={{ width: percent(data.metrics.phaseShare[phase]), background: phaseColors[phase] }} /></div></div>)}
          <p className="method-note">Time outside role logs is excluded. Values are directional, not billing-grade telemetry.</p>
        </article>
      </section>

      <div className="section-bar explorer-heading"><div><h2>Evidence explorer</h2><p>Inspect reports, prompts, logs, and loop event streams.</p></div></div>
      <section className="explorer">
        <aside className="cycle-list">
          <label className="search"><Search size={16} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search cycles" /></label>
          <div className="cycle-scroll">{filteredCycles.map((cycle) => <button key={cycle.id} onClick={() => setSelectedCycleId(cycle.id)} className={selected?.id === cycle.id ? 'cycle-row selected' : 'cycle-row'}><span className={`status-dot ${cycle.status}`} /><span><strong>Cycle {cycle.cycle}</strong><small>{date(cycle.startedAt)} · {cycle.focus}{cycle.compactionCount ? ` · ${cycle.compactionCount} compact` : ''}</small></span><span className={`outcome ${cycle.outcome || cycle.status}`}>{(cycle.outcome || cycle.status).replace('_', ' ')}</span></button>)}</div>
        </aside>

        <article className="cycle-detail">{selected ? <>
          <div className="detail-heading"><div><p className="eyebrow">CYCLE {selected.cycle} · {selected.focus.toUpperCase()}</p><h3>{selected.summary}</h3></div><span className={`outcome ${selected.outcome || selected.status}`}>{(selected.outcome || selected.status).replace('_', ' ')}</span></div>
          <div className="cycle-facts"><div><span>Elapsed</span><strong>{duration(selected.durationMs)}</strong></div><div><span>Retries</span><strong>{selected.retryCount}</strong></div><div><span>Compactions</span><strong>{selected.compactionCount}</strong><small>W {selected.artifacts.filter((file) => file.name.startsWith('worker-')).reduce((sum, file) => sum + file.compactionCount, 0)} · R {selected.artifacts.filter((file) => file.name.startsWith('reviewer-')).reduce((sum, file) => sum + file.compactionCount, 0)} · Retro {selected.artifacts.filter((file) => file.name.startsWith('retrospective-')).reduce((sum, file) => sum + file.compactionCount, 0)}</small></div><div><span>Peak context</span><strong>{tokens(selected.maxContextTokens)} / {tokens(selected.contextLimit)}</strong><small>{typeof selected.maxContextTokens === 'number' && selected.contextLimit ? percent(selected.maxContextTokens / selected.contextLimit) : 'Session unavailable'}</small></div><div><span>Review</span><strong>{selected.decision || '—'}</strong></div><div><span>Commit</span><strong className="mono">{selected.commit?.slice(0, 8) || '—'}</strong></div></div>
          <div className="role-context" aria-label="Peak context by role">{(Object.keys(phaseColors) as PhaseName[]).map((role) => { const session = peakSession(selected.artifacts, role); const usage = session && contextPercent(session); return <div key={role}><span className="swatch" style={{ background: phaseColors[role] }} /><strong>{role}</strong><span>{session ? `${tokens(session.maxContextTokens)} / ${tokens(session.contextLimit)}` : 'No matched session'}</span><div className="context-track"><span style={{ width: usage || '0%', background: phaseColors[role] }} /></div><small>{usage || '—'}</small></div> })}</div>
          <div className="artifact-heading"><h4><FolderOpen size={17} />Artifacts</h4><span>{selected.artifacts.length} files</span></div>
          <div className="artifact-grid">{selected.artifacts.map((file) => <button key={file.name} onClick={() => void openArtifact(selected.id, file.name)}><FileText size={17} /><span><strong>{file.name}</strong><small>{bytes(file.size)} · {date(file.modifiedAt)}{file.name.endsWith('.log') ? ` · ${file.compactionCount} compact${file.session ? ` · ${tokens(file.session.maxContextTokens)}/${tokens(file.session.contextLimit)} ctx` : ' · no session'}` : ''}</small></span></button>)}</div>
        </> : <div className="empty-chart">No cycles match this search</div>}</article>

        <aside className="streams"><h4><Archive size={17} />Loop streams</h4><p>Raw lifecycle and iteration JSONL.</p>{data.streams.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt)).map((stream) => <button key={stream.name} onClick={() => void openStream(stream.name)}><span>{stream.name}</span><small>{bytes(stream.size)}</small></button>)}</aside>
      </section>
    </main>

    <footer>Updated {date(data.generatedAt)} · Filesystem timings are approximate · Read-only access</footer>
    {liveLogOpen && <LiveLogDrawer onClose={() => setLiveLogOpen(false)} />}
    {artifact && <div className="drawer-backdrop" onMouseDown={() => setArtifact(null)}><aside className={artifact.terminal ? 'drawer terminal-drawer' : 'drawer'} onMouseDown={(event) => event.stopPropagation()}><header><div><FileText size={18} /><strong>{artifact.title}</strong>{artifact.session && <span className="drawer-context">{tokens(artifact.session.maxContextTokens)} / {tokens(artifact.session.contextLimit)} context</span>}</div><button className="icon-button" title="Close viewer" onClick={() => setArtifact(null)}><X size={18} /></button></header>{artifact.terminal ? <TerminalOutput content={artifact.content} session={artifact.session} /> : artifact.markdown ? <div className="markdown-content"><ReactMarkdown remarkPlugins={[remarkGfm]}>{artifact.content}</ReactMarkdown></div> : <pre>{artifact.content}</pre>}</aside></div>}
  </div>
}

export default App
