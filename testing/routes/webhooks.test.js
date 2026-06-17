import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Isolate the DB to a throwaway file BEFORE importing anything that opens it.
const dir = mkdtempSync(join(tmpdir(), 'wh-'))
process.env.DATABASE_URL = join(dir, 'test.sqlite')

const SECRET = 'test-secret-token'
let server
let base
let db

before(async () => {
  const express = (await import('express')).default
  const { createWebhookRouter } = await import('./webhooks.js')
  db = (await import('../lib/db.js')).default

  const app = express()
  app.use('/', express.raw({ type: '*/*' }), createWebhookRouter({ secretToken: SECRET }))
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      base = `http://127.0.0.1:${server.address().port}`
      resolve()
    })
  })
})

after(() => {
  server?.close()
  rmSync(dir, { recursive: true, force: true })
})

function post(body, { sign = true, ts = '1700000000' } = {}) {
  const raw = JSON.stringify(body)
  const headers = { 'content-type': 'application/json' }
  if (sign) {
    headers['x-zm-request-timestamp'] = ts
    headers['x-zm-signature'] =
      'v0=' + createHmac('sha256', SECRET).update(`v0:${ts}:${raw}`).digest('hex')
  }
  return fetch(`${base}/`, { method: 'POST', headers, body: raw })
}

test('url_validation handshake returns a correct encryptedToken', async () => {
  const res = await fetch(`${base}/`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ event: 'endpoint.url_validation', payload: { plainToken: 'abc123' } }),
  })
  const json = await res.json()
  assert.equal(json.plainToken, 'abc123')
  assert.equal(
    json.encryptedToken,
    createHmac('sha256', SECRET).update('abc123').digest('hex'),
  )
})

test('rejects a bad signature with 401', async () => {
  const res = await post(
    { event: 'meeting.ended', event_ts: 1, payload: { object: { uuid: 'x' } } },
    { sign: false },
  )
  assert.equal(res.status, 401)
})

test('participant_joined then _left writes one merged session', async () => {
  const uuid = 'aBc==/uuid'
  await post({
    event: 'meeting.participant_joined',
    event_ts: 111,
    payload: {
      object: {
        uuid,
        id: '9999',
        participant: {
          participant_uuid: 'p-1',
          customer_key: 'user-42',
          email: 'a@b.com',
          user_name: 'Alice',
          join_time: '2026-01-01T10:00:00Z',
        },
      },
    },
  })
  await post({
    event: 'meeting.participant_left',
    event_ts: 222,
    payload: {
      object: { uuid, participant: { participant_uuid: 'p-1', leave_time: '2026-01-01T10:30:00Z' } },
    },
  })

  const row = db
    .prepare('SELECT * FROM attendance_sessions WHERE zoom_uuid = ? AND zoom_participant_uuid = ?')
    .get(uuid, 'p-1')
  assert.equal(row.user_id, 'user-42')
  assert.equal(row.email, 'a@b.com')
  assert.ok(row.joined_at > 0 && row.left_at > row.joined_at, 'join/leave times set')
})

test('duplicate delivery is ignored (idempotent)', async () => {
  const evt = {
    event: 'meeting.participant_joined',
    event_ts: 333,
    payload: {
      object: { uuid: 'dup-uuid', id: '1', participant: { participant_uuid: 'p-dup', user_name: 'Bob' } },
    },
  }
  const r1 = await post(evt)
  const r2 = await post(evt)
  assert.equal((await r1.json()).status, 'ok')
  assert.equal((await r2.json()).status, 'duplicate-ignored')
  const count = db
    .prepare('SELECT COUNT(*) c FROM attendance_sessions WHERE zoom_participant_uuid = ?')
    .get('p-dup').c
  assert.equal(count, 1)
})

test('meeting.ended enqueues a reconcile job in the future', async () => {
  await post({
    event: 'meeting.ended',
    event_ts: 444,
    payload: { object: { uuid: 'end-uuid', id: '1', end_time: '2026-01-01T11:00:00Z' } },
  })
  const job = db.prepare("SELECT * FROM jobs WHERE type='reconcile' ORDER BY id DESC LIMIT 1").get()
  assert.ok(job, 'reconcile job exists')
  assert.ok(job.run_after > Date.now(), 'reconcile is delayed into the future')
})
