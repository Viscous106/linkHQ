import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Must set DATABASE_URL BEFORE anything imports lib/db.js (it opens at import
// time). So recordings.js is imported lazily inside before(), not statically.
const dir = mkdtempSync(join(tmpdir(), 'rec-'))
process.env.DATABASE_URL = join(dir, 'test.sqlite')

let server, base, applyHeartbeat

before(async () => {
  const express = (await import('express')).default
  const mod = await import('./recordings.js')
  applyHeartbeat = mod.applyHeartbeat
  const { createRecordingsRouter } = mod
  const app = express()
  app.use(express.json())
  app.use('/api/recordings', createRecordingsRouter())
  await new Promise((r) => {
    server = app.listen(0, () => {
      base = `http://127.0.0.1:${server.address().port}`
      r()
    })
  })
})

after(() => {
  server?.close()
  rmSync(dir, { recursive: true, force: true })
})

test('applyHeartbeat: seek-to-end does not inflate coverage', () => {
  const { percent } = applyHeartbeat([[0, 5]], 90, 100, 100)
  assert.equal(percent, 0.15) // 5s + 10s of 100s
})

function beat(meetingId, user, from, to, duration) {
  return fetch(`${base}/api/recordings/${meetingId}/heartbeat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-user-id': user },
    body: JSON.stringify({ played_from: from, played_to: to, duration }),
  }).then((r) => r.json())
}

test('heartbeats accumulate real coverage; skipping leaves a gap', async () => {
  const M = 'rec-meeting-1'
  let res = await beat(M, 'u1', 0, 30, 100)
  assert.equal(res.percentComplete, 0.3)

  // user drags to the end and watches the last 10s — must NOT jump to 100%
  res = await beat(M, 'u1', 90, 100, 100)
  assert.equal(res.percentComplete, 0.4) // 0-30 + 90-100 = 40s

  // now actually watch the middle 30-90 → full coverage
  res = await beat(M, 'u1', 30, 90, 100)
  assert.equal(res.percentComplete, 1)
})

test('progress endpoint returns the resume point per user', async () => {
  const M = 'rec-meeting-2'
  await beat(M, 'u2', 0, 42, 200)
  const res = await fetch(`${base}/api/recordings/${M}/progress`, {
    headers: { 'x-user-id': 'u2' },
  }).then((r) => r.json())
  assert.equal(res.lastPosition, 42)
  assert.equal(res.percentComplete, 42 / 200)
})

test('heartbeat without identity is rejected', async () => {
  const res = await fetch(`${base}/api/recordings/x/heartbeat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ played_from: 0, played_to: 1, duration: 10 }),
  })
  assert.equal(res.status, 401)
})
