import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'jobs-'))
process.env.DATABASE_URL = join(dir, 'test.sqlite')

let db, enqueueJob, tick

before(async () => {
  const m = await import('../lib/db.js')
  db = m.default
  enqueueJob = m.enqueueJob
  ;({ tick } = await import('./jobRunner.js'))
})

after(() => rmSync(dir, { recursive: true, force: true }))

test('tick runs a due job and marks it done', async () => {
  const id = enqueueJob('reconcile', { zoom_uuid: 'z1' }, Date.now() - 1)
  let seen = null
  await tick({ reconcile: async (p) => { seen = p } })
  assert.deepEqual(seen, { zoom_uuid: 'z1' })
  const row = db.prepare('SELECT status FROM jobs WHERE id = ?').get(id)
  assert.equal(row.status, 'done')
})

test('tick does NOT run a job scheduled in the future', async () => {
  enqueueJob('reconcile', { zoom_uuid: 'future' }, Date.now() + 60_000)
  let ran = false
  await tick({ reconcile: async () => { ran = true } })
  assert.equal(ran, false)
})

test('a throwing handler reschedules the job for retry (not done)', async () => {
  const id = enqueueJob('recording_ingest', {}, Date.now() - 1)
  await tick({ recording_ingest: async () => { throw new Error('boom') } })
  const row = db.prepare('SELECT * FROM jobs WHERE id = ?').get(id)
  assert.equal(row.status, 'pending') // back to pending for retry
  assert.equal(row.attempts, 1)
  assert.match(row.last_error, /boom/)
  assert.ok(row.run_after > Date.now(), 'backoff pushed run_after into the future')
})
