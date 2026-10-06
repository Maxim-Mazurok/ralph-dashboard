import assert from 'node:assert/strict'
import test from 'node:test'
import { parseOpenCodeEvents } from './opencode-events.js'

const lines = (records: unknown[]) => records.map((record) => JSON.stringify(record)).join('\n')

test('parses the observed OpenCode v2 JSONL contract', () => {
  const session = parseOpenCodeEvents(lines([
    { type: 'step_start', timestamp: 1000, sessionID: 'ses_v2', part: { id: 'start', type: 'step-start' } },
    { type: 'reasoning', timestamp: 1200, sessionID: 'ses_v2', part: { id: 'reason', type: 'reasoning', text: 'Thinking', time: { start: 1100, end: 1200 } } },
    { type: 'text', timestamp: 1400, sessionID: 'ses_v2', part: { id: 'text', type: 'text', text: 'Done', time: { start: 1300, end: 1400 } } },
    { type: 'step_finish', timestamp: 1500, sessionID: 'ses_v2', part: { id: 'finish', type: 'step-finish', reason: 'stop', tokens: { total: 9289, reasoning: 7 } } },
  ]), { started_at: 900, selected_model: 'llamacpp/qwen3.8-flash-next-iq3_xxs' }, 'worker-1', 262144)

  assert(session)
  assert.equal(session.id, 'ses_v2')
  assert.equal(session.model, 'qwen3.8-flash-next-iq3_xxs')
  assert.equal(session.contextLimit, 262144)
  assert.equal(session.maxContextTokens, 9289)
  assert.equal(session.reasoningTokens, 7)
  assert.equal(session.reasoningCount, 1)
  assert.equal(session.activeMs, 500)
  assert.equal(session.inferenceMs, 500)
  assert.equal(session.reasoningMs, 100)
  assert.equal(session.outputMs, 100)
  assert.deepEqual(session.events.map((event) => [event.type, event.text]), [
    ['reasoning', 'Thinking'],
    ['text', 'Done'],
  ])
})

test('maps completed tools, delegated time, compactions, duplicates, and partial records', () => {
  const tool = {
    type: 'tool_use', timestamp: 1300, sessionID: 'ses_tools',
    part: {
      id: 'tool-1', type: 'tool', tool: 'bash',
      state: { status: 'completed', title: 'Test', input: { command: 'npm test' }, output: 'pass', time: { start: 1100, end: 1300 } },
    },
  }
  const session = parseOpenCodeEvents(`${lines([
    { type: 'step_start', timestamp: 1000, sessionID: 'ses_tools', part: { id: 'start', type: 'step-start' } },
    tool,
    tool,
    { type: 'tool_use', timestamp: 1450, sessionID: 'ses_tools', part: { id: 'task-1', type: 'tool', tool: 'task', state: { status: 'completed', time: { start: 1300, end: 1450 } } } },
    { type: 'compaction', timestamp: 1460, sessionID: 'ses_tools', part: { id: 'compact', type: 'compaction', text: 'summary' } },
    { type: 'step_finish', timestamp: 1500, sessionID: 'ses_tools', part: { id: 'finish', type: 'step-finish', tokens: { total: 20 } } },
  ])}\n{"type":"partial"`, {})

  assert(session)
  assert.equal(session.toolMs, 200)
  assert.equal(session.delegatedMs, 150)
  assert.equal(session.inferenceMs, 150)
  assert.equal(session.compactionCount, 1)
  assert.equal(session.events.filter((event) => event.type === 'tool').length, 2)
  assert.equal(session.events.find((event) => event.tool === 'bash')?.output, 'pass')
})

test('estimates untimed tool-call output before tool execution', () => {
  const session = parseOpenCodeEvents(lines([
    { type: 'step_start', timestamp: 1000, sessionID: 'ses_tool_output', part: { id: 'start', type: 'step-start' } },
    { type: 'reasoning', timestamp: 1200, sessionID: 'ses_tool_output', part: { id: 'reason', type: 'reasoning', text: 'Use a tool', time: { start: 1100, end: 1200 } } },
    { type: 'tool_use', timestamp: 1600, sessionID: 'ses_tool_output', part: { id: 'tool', type: 'tool', tool: 'read', state: { status: 'completed', time: { start: 1500, end: 1600 } } } },
    { type: 'step_finish', timestamp: 1700, sessionID: 'ses_tool_output', part: { id: 'finish', type: 'step-finish', tokens: { total: 20 } } },
  ]), {})

  assert(session)
  assert.equal(session.toolOutputMs, 300)
  assert.equal(session.otherInferenceMs, 100)
})

test('requires a valid session id from metadata or events', () => {
  assert.equal(parseOpenCodeEvents('{"type":"text","part":{"text":"orphan"}}'), null)
  assert.equal(parseOpenCodeEvents('', { session_id: 'ses_metadata' })?.id, 'ses_metadata')
})

test('excludes gaps between steps and measures an interrupted final step', () => {
  const session = parseOpenCodeEvents(lines([
    { type: 'step_start', timestamp: 1000, sessionID: 'ses_interrupted', part: { id: 'start-1' } },
    { type: 'reasoning', timestamp: 1100, sessionID: 'ses_interrupted', part: { id: 'reason', text: 'Working' } },
    { type: 'step_finish', timestamp: 1200, sessionID: 'ses_interrupted', part: { id: 'finish-1' } },
    { type: 'step_start', timestamp: 100_000, sessionID: 'ses_interrupted', part: { id: 'start-2' } },
    { type: 'text', timestamp: 100_100, sessionID: 'ses_interrupted', part: { id: 'partial', text: 'Interrupted' } },
  ]), {})

  assert(session)
  assert.equal(session.activeMs, 300)
})
