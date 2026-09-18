import { startTransition, useDeferredValue, useEffect, useState } from 'react'
import {
  Activity, AlertTriangle, Archive, BarChart3, CheckCircle2, Clock3,
  FileText, FolderOpen, RefreshCw, Search, TimerReset, X,
} from 'lucide-react'
import {
  Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, Legend, Line,
  LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts'
import type { Cycle, DashboardData, PhaseName } from './types'
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

function Metric({ label, value, note, icon: Icon }: { label: string; value: string; note: string; icon: typeof Clock3 }) {
  return <div className="metric"><div className="metric-label"><Icon size={15} />{label}</div><strong>{value}</strong><span>{note}</span></div>
}
function EmptyChart() { return <div className="empty-chart">Not enough measured data yet</div> }

function App() {
  const [data, setData] = useState<DashboardData | null>(null)
  const [error, setError] = useState('')
  const [refreshing, setRefreshing] = useState(false)
  const [range, setRange] = useState(12)
  const [query, setQuery] = useState('')
  const deferredQuery = useDeferredValue(query)
  const [selectedCycleId, setSelectedCycleId] = useState('')
  const [artifact, setArtifact] = useState<{ title: string; content: string } | null>(null)

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
    setArtifact({ title: name, content: 'Loading…' })
    const response = await fetch(`/api/artifact?cycle=${encodeURIComponent(cycle)}&file=${encodeURIComponent(name)}`)
    setArtifact({ title: name, content: response.ok ? await response.text() : `Unable to open artifact (${response.status})` })
  }
  async function openStream(name: string) {
    setArtifact({ title: name, content: 'Loading…' })
    const response = await fetch(`/api/stream?file=${encodeURIComponent(name)}`)
    setArtifact({ title: name, content: response.ok ? await response.text() : `Unable to open stream (${response.status})` })
  }

  if (!data && !error) return <main className="loading"><Activity className="spin" /> Reading Ralph evidence…</main>
  if (!data) return <main className="loading error"><AlertTriangle /> {error}<button onClick={() => void load()}>Retry</button></main>

  const visibleCycles = data.cycles.slice(range === 0 ? 0 : -range)
  const timingData = visibleCycles.map((cycle) => ({
    cycle: `#${cycle.cycle}`,
    total: cycle.durationMs ? Math.round(cycle.durationMs / 60000) : null,
  }))
  const phaseTrend = visibleCycles.map((cycle) => {
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
        <Metric icon={AlertTriangle} label="Loop failures" value={percent(data.metrics.loopFailureRate)} note="From loop completion history" />
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
          <div className="cycle-scroll">{filteredCycles.map((cycle) => <button key={cycle.id} onClick={() => setSelectedCycleId(cycle.id)} className={selected?.id === cycle.id ? 'cycle-row selected' : 'cycle-row'}><span className={`status-dot ${cycle.status}`} /><span><strong>Cycle {cycle.cycle}</strong><small>{date(cycle.startedAt)} · {cycle.focus}</small></span><span className={`outcome ${cycle.outcome || cycle.status}`}>{(cycle.outcome || cycle.status).replace('_', ' ')}</span></button>)}</div>
        </aside>

        <article className="cycle-detail">{selected ? <>
          <div className="detail-heading"><div><p className="eyebrow">CYCLE {selected.cycle} · {selected.focus.toUpperCase()}</p><h3>{selected.summary}</h3></div><span className={`outcome ${selected.outcome || selected.status}`}>{(selected.outcome || selected.status).replace('_', ' ')}</span></div>
          <div className="cycle-facts"><div><span>Elapsed</span><strong>{duration(selected.durationMs)}</strong></div><div><span>Retries</span><strong>{selected.retryCount}</strong></div><div><span>Review</span><strong>{selected.decision || '—'}</strong></div><div><span>Commit</span><strong className="mono">{selected.commit?.slice(0, 8) || '—'}</strong></div></div>
          <div className="artifact-heading"><h4><FolderOpen size={17} />Artifacts</h4><span>{selected.artifacts.length} files</span></div>
          <div className="artifact-grid">{selected.artifacts.map((file) => <button key={file.name} onClick={() => void openArtifact(selected.id, file.name)}><FileText size={17} /><span><strong>{file.name}</strong><small>{bytes(file.size)} · {date(file.modifiedAt)}</small></span></button>)}</div>
        </> : <div className="empty-chart">No cycles match this search</div>}</article>

        <aside className="streams"><h4><Archive size={17} />Loop streams</h4><p>Raw lifecycle and iteration JSONL.</p>{data.streams.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt)).map((stream) => <button key={stream.name} onClick={() => void openStream(stream.name)}><span>{stream.name}</span><small>{bytes(stream.size)}</small></button>)}</aside>
      </section>
    </main>

    <footer>Updated {date(data.generatedAt)} · Filesystem timings are approximate · Read-only access</footer>
    {artifact && <div className="drawer-backdrop" onMouseDown={() => setArtifact(null)}><aside className="drawer" onMouseDown={(event) => event.stopPropagation()}><header><div><FileText size={18} /><strong>{artifact.title}</strong></div><button className="icon-button" title="Close viewer" onClick={() => setArtifact(null)}><X size={18} /></button></header><pre>{artifact.content}</pre></aside></div>}
  </div>
}

export default App
