import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, stat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { DatabaseSync } from 'node:sqlite'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

test('deletes only the current unfinished cycle through the project reset command', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ralph-dashboard-reset-'))
  const cycle = path.join(root, '.ralph/runtime/cycle-5-1000')
  const script = path.join(root, 'scripts/continuous-improvement.cjs')
  await mkdir(cycle, { recursive: true })
  await mkdir(path.dirname(script), { recursive: true })
  await writeFile(path.join(cycle, 'worker-1.log'), 'discarded work\n')
  await writeFile(path.join(root, '.ralph/runtime/state.json'), JSON.stringify({
    completed: 4,
    history: [],
    active: { directory: cycle, base: 'test-base', focus: 'workflow', attempt: 1 },
  }))
  await writeFile(script, `
const fs = require('node:fs')
const path = require('node:path')
if (process.argv[2] !== '--reset-cycle') process.exit(2)
const statePath = path.join(process.cwd(), '.ralph/runtime/state.json')
const state = JSON.parse(fs.readFileSync(statePath, 'utf8'))
fs.rmSync(state.active.directory, { recursive: true })
delete state.active
fs.writeFileSync(statePath, JSON.stringify(state))
`)

  process.env.NODE_ENV = 'test'
  process.env.RALPH_PROJECT_PATH = root
  const { app } = await import(`./index.ts?reset=${Date.now()}`)
  const server = createServer(app)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert(address && typeof address !== 'string')

  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/api/cycles/cycle-5-1000`, { method: 'DELETE' })
    assert.equal(response.status, 200)
    const dashboard = await response.json() as { cycles: unknown[]; active: unknown }
    assert.deepEqual(dashboard.cycles, [])
    assert.equal(dashboard.active, null)
    await assert.rejects(stat(cycle), { code: 'ENOENT' })

    const repeated = await fetch(`http://127.0.0.1:${address.port}/api/cycles/cycle-5-1000`, { method: 'DELETE' })
    assert.equal(repeated.status, 409)
  } finally {
    server.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('discards only the active step and keeps its cycle and phase checkpoint', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ralph-dashboard-step-reset-'))
  const cycle = path.join(root, '.ralph/runtime/cycle-55-1000')
  const script = path.join(root, 'scripts/continuous-improvement.cjs')
  await mkdir(cycle, { recursive: true })
  await mkdir(path.dirname(script), { recursive: true })
  await writeFile(path.join(cycle, 'context.json'), JSON.stringify({ cycle: 55, focus: 'workflow' }))
  await writeFile(path.join(cycle, 'result.json'), JSON.stringify({ outcome: 'change', summary: 'Worker complete' }))
  await writeFile(path.join(cycle, 'reviewer-2.log'), 'incomplete review\n')
  await writeFile(path.join(root, '.ralph/runtime/state.json'), JSON.stringify({
    completed: 54,
    history: [],
    active: { directory: cycle, base: 'test-base', focus: 'workflow', phase: 'reviewer', attempt: 2 },
  }))
  await writeFile(script, `
const fs = require('node:fs')
const path = require('node:path')
if (process.argv[2] !== '--reset-step') process.exit(2)
const state = JSON.parse(fs.readFileSync(path.join(process.cwd(), '.ralph/runtime/state.json'), 'utf8'))
fs.rmSync(path.join(state.active.directory, 'reviewer-2.log'))
`)

  process.env.NODE_ENV = 'test'
  process.env.RALPH_PROJECT_PATH = root
  const { app } = await import(`./index.ts?step-reset=${Date.now()}`)
  const server = createServer(app)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert(address && typeof address !== 'string')

  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/api/cycles/cycle-55-1000/step`, { method: 'DELETE' })
    assert.equal(response.status, 200)
    const dashboard = await response.json() as { active: Record<string, unknown>; cycles: Array<{ id: string }> }
    assert.equal(dashboard.active.phase, 'reviewer')
    assert.equal(dashboard.active.attempt, 2)
    assert.equal(dashboard.cycles.at(-1)?.id, 'cycle-55-1000')
    await assert.rejects(stat(path.join(cycle, 'reviewer-2.log')), { code: 'ENOENT' })
    await stat(path.join(cycle, 'result.json'))
  } finally {
    server.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('streams the newest active role log when state has no phase', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ralph-dashboard-'))
  const cycle = path.join(root, '.ralph/runtime/cycle-7-1000')
  await mkdir(cycle, { recursive: true })
  await writeFile(path.join(root, '.ralph/runtime/state.json'), JSON.stringify({
    completed: 6,
    history: [],
    active: { directory: cycle, attempt: 1 },
  }))
  await writeFile(path.join(cycle, 'worker-1.log'), 'live worker output\n')

  process.env.NODE_ENV = 'test'
  process.env.RALPH_PROJECT_PATH = root
  const { app } = await import(`./index.ts?test=${Date.now()}`)
  const server = createServer(app)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert(address && typeof address !== 'string')

  try {
    const dashboard = await fetch(`http://127.0.0.1:${address.port}/api/dashboard`)
      .then((response) => response.json()) as { active: Record<string, unknown> }
    assert.deepEqual(dashboard.active, { cycle: 7, phase: 'worker', attempt: 1, logFile: 'worker-1.log' })

    const controller = new AbortController()
    const response = await fetch(`http://127.0.0.1:${address.port}/api/live-log`, { signal: controller.signal })
    const reader = response.body!.getReader()
    const frame = new TextDecoder().decode((await reader.read()).value)
    controller.abort()
    assert.match(frame, /^event: log/m)
    const payload = JSON.parse(frame.match(/^data: (.+)$/m)?.[1] || '{}')
    assert.equal(payload.file, 'worker-1.log')
    assert.equal(payload.phase, 'worker')
    assert.equal(payload.content, 'live worker output\n')
  } finally {
    server.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('streams OpenCode tool updates when the role log is unchanged', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ralph-dashboard-live-session-'))
  const cycle = path.join(root, '.ralph/runtime/cycle-8-1000')
  const databasePath = path.join(root, 'opencode.db')
  await mkdir(cycle, { recursive: true })
  await writeFile(path.join(root, '.ralph/runtime/state.json'), JSON.stringify({
    completed: 7,
    history: [],
    active: { directory: cycle, attempt: 1 },
  }))
  await writeFile(path.join(cycle, 'worker-1.md'), 'worker prompt')
  await writeFile(path.join(cycle, 'worker-1.log'), 'unchanged terminal output\n')
  const promptTime = (await stat(path.join(cycle, 'worker-1.md'))).mtimeMs

  const database = new DatabaseSync(databasePath)
  database.exec(`
    CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT, model TEXT, time_created INTEGER, time_updated INTEGER, parent_id TEXT, title TEXT);
    CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, data TEXT);
    CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, data TEXT, time_created INTEGER);
  `)
  const sessionTime = Math.round(promptTime + 5500)
  database.prepare('INSERT INTO session VALUES (?, ?, ?, ?, ?, ?, ?)').run('session-live', root, '{}', sessionTime, sessionTime, null, 'Worker')
  database.prepare('INSERT INTO message VALUES (?, ?, ?)').run('message-live', 'session-live', JSON.stringify({ role: 'assistant' }))
  database.prepare('INSERT INTO part VALUES (?, ?, ?, ?, ?)').run('part-live', 'message-live', 'session-live', JSON.stringify({ type: 'tool', tool: 'edit', state: { status: 'pending', input: {} } }), Math.round(promptTime + 1))

  process.env.NODE_ENV = 'test'
  process.env.RALPH_PROJECT_PATH = root
  process.env.OPENCODE_DB_PATH = databasePath
  const { app } = await import(`./index.ts?live-session=${Date.now()}`)
  const server = createServer(app)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert(address && typeof address !== 'string')
  const controller = new AbortController()

  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/api/live-log`, { signal: controller.signal })
    const reader = response.body!.getReader()
    const decoder = new TextDecoder()
    assert.match(decoder.decode((await reader.read()).value), /"status":"pending"/)

    database.prepare('UPDATE part SET data = ? WHERE id = ?').run(JSON.stringify({
      type: 'tool', tool: 'edit', state: { status: 'completed', input: { oldString: 'old', newString: 'new' }, output: 'Done' },
    }), 'part-live')
    database.prepare('UPDATE session SET time_updated = ? WHERE id = ?').run(sessionTime + 2, 'session-live')

    const nextFrame = await Promise.race([
      reader.read().then(({ value }) => decoder.decode(value)),
      new Promise<string>((_, reject) => setTimeout(() => reject(new Error('Timed out waiting for session update')), 2500)),
    ])
    assert.match(nextFrame, /"status":"completed"/)
  } finally {
    controller.abort()
    database.close()
    server.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('reports context compactions per role log and cycle', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ralph-dashboard-compactions-'))
  const cycle = path.join(root, '.ralph/runtime/cycle-3-1000')
  await mkdir(cycle, { recursive: true })
  await writeFile(path.join(root, '.ralph/runtime/state.json'), JSON.stringify({ completed: 3, history: [] }))
  await writeFile(path.join(cycle, 'context.json'), JSON.stringify({ cycle: 3, focus: 'workflow' }))
  await writeFile(path.join(cycle, 'accepted.json'), JSON.stringify({ cycle: 3, outcome: 'change' }))
  await writeFile(path.join(cycle, 'worker-1.log'), 'The conversation was compacted and work continued.\nThe conversation was compacted again.\n')
  await writeFile(path.join(cycle, 'reviewer-1.log'), 'No compaction here.\n')
  await writeFile(path.join(cycle, 'retrospective-1.log'), 'The conversation was compacted before completion.\n')

  process.env.NODE_ENV = 'test'
  process.env.RALPH_PROJECT_PATH = root
  const { app } = await import(`./index.ts?compactions=${Date.now()}`)
  const server = createServer(app)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert(address && typeof address !== 'string')

  try {
    const dashboard = await fetch(`http://127.0.0.1:${address.port}/api/dashboard`)
      .then((response) => response.json()) as { cycles: Array<{ compactionCount: number; artifacts: Array<{ name: string; compactionCount: number }> }> }
    assert.equal(dashboard.cycles[0].compactionCount, 3)
    assert.equal(dashboard.cycles[0].artifacts.find((artifact) => artifact.name === 'worker-1.log')?.compactionCount, 2)
    assert.equal(dashboard.cycles[0].artifacts.find((artifact) => artifact.name === 'reviewer-1.log')?.compactionCount, 0)
    assert.equal(dashboard.cycles[0].artifacts.find((artifact) => artifact.name === 'retrospective-1.log')?.compactionCount, 1)
  } finally {
    server.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('matches role logs to OpenCode sessions and reports peak context and reasoning', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ralph-dashboard-context-'))
  const cycle = path.join(root, '.ralph/runtime/cycle-4-1000')
  const databasePath = path.join(root, 'opencode.db')
  const configPath = path.join(root, 'opencode.json')
  await mkdir(cycle, { recursive: true })
  await writeFile(path.join(root, '.ralph/runtime/state.json'), JSON.stringify({ completed: 4, history: [] }))
  await writeFile(path.join(cycle, 'context.json'), JSON.stringify({ cycle: 4, focus: 'workflow' }))
  await writeFile(path.join(cycle, 'accepted.json'), JSON.stringify({ cycle: 4, outcome: 'change' }))
  await writeFile(path.join(cycle, 'worker-1.md'), 'worker prompt')
  await writeFile(path.join(cycle, 'worker-1.log'), 'worker output')
  const promptTime = (await stat(path.join(cycle, 'worker-1.md'))).mtimeMs
  const logTime = (await stat(path.join(cycle, 'worker-1.log'))).mtimeMs
  await writeFile(configPath, JSON.stringify({ provider: { test: { models: { model: { limit: { context: 100000 } } } } } }))

  const database = new DatabaseSync(databasePath)
  database.exec(`
    CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT, model TEXT, time_created INTEGER, time_updated INTEGER, parent_id TEXT, title TEXT);
    CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, data TEXT);
    CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, data TEXT, time_created INTEGER);
  `)
  database.prepare('INSERT INTO session VALUES (?, ?, ?, ?, ?, ?, ?)').run('session-1', root, JSON.stringify({ id: 'MODEL', providerID: 'historical-provider' }), Math.round(promptTime + 500), Math.round(logTime + 7_200_000), null, 'Worker')
  database.prepare('INSERT INTO session VALUES (?, ?, ?, ?, ?, ?, ?)').run('session-child', root, JSON.stringify({ id: 'MODEL', providerID: 'historical-provider' }), Math.round(promptTime + 900), Math.round(logTime + 7_200_000), 'session-1', 'Inspect API behavior (@explore subagent)')
  database.prepare('INSERT INTO session VALUES (?, ?, ?, ?, ?, ?, ?)').run('session-grandchild', root, JSON.stringify({ id: 'MODEL', providerID: 'historical-provider' }), Math.round(promptTime + 1100), Math.round(logTime + 7_200_000), 'session-child', 'Trace nested behavior (@explore subagent)')
  database.prepare('INSERT INTO message VALUES (?, ?, ?)').run('message-1', 'session-1', JSON.stringify({ role: 'assistant', tokens: { total: 64000, reasoning: 1200 }, time: { created: 10000, completed: 20000 } }))
  database.prepare('INSERT INTO part VALUES (?, ?, ?, ?, ?)').run('part-1', 'message-1', 'session-1', JSON.stringify({ type: 'reasoning', text: 'Structured model reasoning', time: { start: 11000, end: 15000 } }), Math.round(promptTime + 600))
  database.prepare('INSERT INTO part VALUES (?, ?, ?, ?, ?)').run('part-2', 'message-1', 'session-1', JSON.stringify({ type: 'tool', tool: 'edit', state: { status: 'completed', title: 'Edit file', input: { filePath: 'example.ts', oldString: 'old', newString: 'new' }, output: 'Done', time: { start: 21000, end: 24000 }, metadata: { diff: '@@ -1 +1 @@\n-old\n+new' } } }), Math.round(promptTime + 700))
  database.prepare('INSERT INTO part VALUES (?, ?, ?, ?, ?)').run('part-3', 'message-1', 'session-1', JSON.stringify({ type: 'text', text: 'Observed result', time: { start: 15000, end: 17000 } }), Math.round(promptTime + 800))
  database.prepare('INSERT INTO part VALUES (?, ?, ?, ?, ?)').run('part-task', 'message-1', 'session-1', JSON.stringify({ type: 'tool', tool: 'task', state: { status: 'completed', title: 'Inspect API behavior', input: { prompt: 'Inspect the API' }, output: '<task id="session-child" state="completed"><task_result>Child session finding</task_result></task>' } }), Math.round(promptTime + 850))
  database.prepare('INSERT INTO message VALUES (?, ?, ?)').run('message-child', 'session-child', JSON.stringify({ role: 'assistant' }))
  database.prepare('INSERT INTO part VALUES (?, ?, ?, ?, ?)').run('part-child', 'message-child', 'session-child', JSON.stringify({ type: 'text', text: 'Child session finding' }), Math.round(promptTime + 1000))
  database.prepare('INSERT INTO part VALUES (?, ?, ?, ?, ?)').run('part-child-task', 'message-child', 'session-child', JSON.stringify({ type: 'tool', tool: 'task', state: { status: 'completed', title: 'Trace nested behavior', input: { prompt: 'Trace nested behavior' }, output: '<task id="session-grandchild" state="completed"><task_result>Nested result</task_result></task>' } }), Math.round(promptTime + 1050))
  database.prepare('INSERT INTO message VALUES (?, ?, ?)').run('message-grandchild', 'session-grandchild', JSON.stringify({ role: 'assistant' }))
  database.prepare('INSERT INTO part VALUES (?, ?, ?, ?, ?)').run('part-grandchild-reasoning', 'message-grandchild', 'session-grandchild', JSON.stringify({ type: 'reasoning', text: 'Nested reasoning' }), Math.round(promptTime + 1200))
  database.prepare('INSERT INTO part VALUES (?, ?, ?, ?, ?)').run('part-grandchild-tool', 'message-grandchild', 'session-grandchild', JSON.stringify({ type: 'tool', tool: 'read', state: { status: 'completed', title: 'Read nested file', input: { filePath: 'nested.ts' }, output: 'nested output' } }), Math.round(promptTime + 1300))
  database.close()

  process.env.NODE_ENV = 'test'
  process.env.RALPH_PROJECT_PATH = root
  process.env.OPENCODE_DB_PATH = databasePath
  process.env.OPENCODE_CONFIG_PATH = configPath
  const { app } = await import(`./index.ts?context=${Date.now()}`)
  const server = createServer(app)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert(address && typeof address !== 'string')

  try {
    const dashboard = await fetch(`http://127.0.0.1:${address.port}/api/dashboard`)
      .then((response) => response.json()) as { cycles: Array<{ maxContextTokens: number; contextLimit: number; timeBreakdown: Record<string, number>; artifacts: Array<{ name: string; session: Record<string, unknown> | null }> }> }
    assert.equal(dashboard.cycles[0].maxContextTokens, 64000)
    assert.equal(dashboard.cycles[0].contextLimit, 100000)
    assert.deepEqual(dashboard.cycles[0].artifacts.find((artifact) => artifact.name === 'worker-1.log')?.session, {
      model: 'MODEL', maxContextTokens: 64000, contextLimit: 100000, reasoningTokens: 1200, reasoningCount: 1,
      inferenceMs: 10000, toolMs: 3000, reasoningMs: 4000, outputMs: 2000, otherInferenceMs: 4000,
    })
    assert.deepEqual(dashboard.cycles[0].timeBreakdown, {
      inferenceMs: 10000, toolMs: 3000, reasoningMs: 4000, outputMs: 2000, otherInferenceMs: 4000,
    })

    const telemetry = await fetch(`http://127.0.0.1:${address.port}/api/artifact-telemetry?cycle=cycle-4-1000&file=worker-1.log`)
      .then((response) => response.json()) as { reasoning: unknown[]; events: Array<Record<string, unknown> & { subagent?: { title: string; session: { events: Array<Record<string, unknown> & { subagent?: { title: string; session: { events: Array<Record<string, unknown>> } } }> } } }>; subagents: unknown[] }
    assert.deepEqual(telemetry.reasoning, [{ text: 'Structured model reasoning', startedAt: 11000, endedAt: 15000 }])
    assert.deepEqual(telemetry.events.map((event) => event.type), ['reasoning', 'tool', 'text', 'tool'])
    assert.deepEqual(telemetry.events[1], {
      id: 'part-2', type: 'tool', createdAt: Math.round(promptTime + 700), tool: 'edit', status: 'completed',
      title: 'Edit file', input: { filePath: 'example.ts', oldString: 'old', newString: 'new' }, output: 'Done', diff: '@@ -1 +1 @@\n-old\n+new',
    })
    assert.equal(telemetry.subagents.length, 0)
    const child = telemetry.events[3].subagent
    assert.equal(child?.title, 'Inspect API behavior (@explore subagent)')
    assert.equal(child?.session.events[0].text, 'Child session finding')
    const grandchild = child?.session.events[1].subagent
    assert.equal(grandchild?.title, 'Trace nested behavior (@explore subagent)')
    assert.deepEqual(grandchild?.session.events.map((event) => event.type), ['reasoning', 'tool'])
  } finally {
    server.close()
    await rm(root, { recursive: true, force: true })
  }
})