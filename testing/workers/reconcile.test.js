import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Isolate the DB this module transitively opens (reconcile.js → lib/db.js),
// importing lazily AFTER DATABASE_URL is set so no ./data artifact is created.
const dir = mkdtempSync(join(tmpdir(), 'reconcile-'))
process.env.DATABASE_URL = join(dir, 'test.sqlite')

let reconcileParticipants, encodeMeetingUuid, runReconcile

before(async () => {
  ;({ reconcileParticipants, encodeMeetingUuid, runReconcile } = await import('./reconcile.js'))
})

after(() => rmSync(dir, { recursive: true, force: true }))

test('encodeMeetingUuid: plain uuid encoded once', () => {
  assert.equal(encodeMeetingUuid('abc123def'), 'abc123def')
})

test('encodeMeetingUuid: uuid with / or // is double-encoded', () => {
  // contains '/' (single) -> encoded once -> '%2F' ... but rule triggers on '//'
  assert.equal(encodeMeetingUuid('/startslash'), encodeURIComponent(encodeURIComponent('/startslash')))
  assert.equal(encodeMeetingUuid('a//b'), encodeURIComponent(encodeURIComponent('a//b')))
})

test('reconcile: two reconnect sessions for same customer_key are unioned, not summed', () => {
  const base = Date.parse('2026-01-01T10:00:00Z')
  const iso = (s) => new Date(base + s * 1000).toISOString()
  const participants = [
    // user joins 0-600s, drops, rejoins 300-900s (overlap) -> union 0-900 = 900s
    { customer_key: 'u1', name: 'Alice', join_time: iso(0), leave_time: iso(600) },
    { customer_key: 'u1', name: 'Alice', join_time: iso(300), leave_time: iso(900) },
  ]
  const [r] = reconcileParticipants(participants)
  assert.equal(r.user_id, 'u1')
  assert.equal(r.present_seconds, 900) // NOT 1200
})

test('reconcile: falls back to email when no customer_key', () => {
  const base = Date.parse('2026-01-01T10:00:00Z')
  const iso = (s) => new Date(base + s * 1000).toISOString()
  const out = reconcileParticipants([
    { user_email: 'b@x.com', name: 'Bob', join_time: iso(0), leave_time: iso(120) },
  ])
  assert.equal(out.length, 1)
  assert.equal(out[0].email, 'b@x.com')
  assert.equal(out[0].present_seconds, 120)
})

test('runReconcile: paginates, merges, and writes one row per identity', async () => {
  const base = Date.parse('2026-01-01T10:00:00Z')
  const iso = (s) => new Date(base + s * 1000).toISOString()
  const page1 = {
    participants: [{ customer_key: 'u1', name: 'A', join_time: iso(0), leave_time: iso(60) }],
    next_page_token: 'TOK',
  }
  const page2 = {
    participants: [{ customer_key: 'u1', name: 'A', join_time: iso(60), leave_time: iso(120) }],
    next_page_token: '',
  }
  const calls = []
  const fakeFetch = async (url) => {
    calls.push(url)
    const body = url.includes('next_page_token=TOK') ? page2 : page1
    return { ok: true, json: async () => body }
  }
  const written = []
  const n = await runReconcile(
    { zoom_uuid: 'meeting-uuid-1' },
    { fetch: fakeFetch, getToken: async () => 'tok', write: (row) => written.push(row) },
  )
  assert.equal(n, 1)
  assert.equal(calls.length, 2, 'followed pagination')
  // adjacent sessions 0-60 + 60-120 merge to 120s
  assert.equal(written[0].present_seconds, 120)
  assert.equal(written[0].user_id, 'u1')
})
