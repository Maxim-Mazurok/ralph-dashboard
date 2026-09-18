import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

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