/**
 * Authoritative attendance reconciliation.
 *
 * After a meeting ends, the Reports API is the source of truth. We pull the
 * participant report (by meeting UUID — NOT the numeric id, which returns the
 * wrong instance for recurring meetings), then union each user's join/leave
 * spans so reconnects don't double-count "present" time, and write the result
 * to attendance_final.
 *
 * Docs: GET /report/meetings/{meetingId}/participants
 */
import { mergeIntervals } from '../lib/intervals.js'
import { getZoomAccessToken } from '../lib/zoomAuth.js'
import { upsertAttendanceFinal } from '../lib/db.js'

const API_BASE = 'https://api.zoom.us/v2'

/**
 * Per Zoom docs: a meeting UUID that begins with '/' or contains '//' must be
 * double URL-encoded before being placed in the path.
 */
export function encodeMeetingUuid(uuid) {
  const once = encodeURIComponent(uuid)
  if (uuid.startsWith('/') || uuid.includes('//')) {
    return encodeURIComponent(once)
  }
  return once
}

function toMs(t) {
  const ms = Date.parse(t)
  return Number.isNaN(ms) ? null : ms
}

/**
 * PURE: group report participants by identity and union their sessions.
 * Identity key = customer_key (our app user id) when present, else email,
 * else the Zoom-assigned name (last resort).
 * @returns {Array<{user_id, email, display_name, present_seconds, sessions}>}
 */
export function reconcileParticipants(participants) {
  const groups = new Map()
  for (const p of participants) {
    const userId = p.customer_key || null
    const email = p.user_email || p.email || null
    const key = userId || email || `name:${p.name}`
    if (!groups.has(key)) {
      groups.set(key, { user_id: userId, email, display_name: p.name, intervals: [] })
    }
    const g = groups.get(key)
    g.display_name ??= p.name
    g.user_id ??= userId
    g.email ??= email

    const start = toMs(p.join_time)
    const end = toMs(p.leave_time)
    if (start != null && end != null && end > start) {
      g.intervals.push([start / 1000, end / 1000]) // seconds
    } else if (Number.isFinite(p.duration) && start != null) {
      g.intervals.push([start / 1000, start / 1000 + p.duration])
    }
  }

  const out = []
  for (const g of groups.values()) {
    const merged = mergeIntervals(g.intervals)
    const present = Math.round(merged.reduce((s, [a, b]) => s + (b - a), 0))
    out.push({
      user_id: g.user_id,
      email: g.email,
      display_name: g.display_name,
      present_seconds: present,
      sessions: merged,
    })
  }
  return out
}

/** Fetch all participant report pages for a meeting UUID. */
async function fetchAllParticipants(uuid, deps) {
  const token = await deps.getToken()
  const enc = encodeMeetingUuid(uuid)
  const all = []
  let nextPageToken = ''
  do {
    const url =
      `${API_BASE}/report/meetings/${enc}/participants?page_size=300` +
      (nextPageToken ? `&next_page_token=${nextPageToken}` : '')
    const res = await deps.fetch(url, { headers: { Authorization: `Bearer ${token}` } })
    if (!res.ok) {
      throw new Error(`Reports API ${res.status}: ${await res.text()}`)
    }
    const json = await res.json()
    all.push(...(json.participants ?? []))
    nextPageToken = json.next_page_token || ''
  } while (nextPageToken)
  return all
}

/**
 * Job handler. payload: { zoom_uuid }
 * deps is injectable for testing: { fetch, getToken, write }.
 */
export async function runReconcile(payload, deps = {}) {
  const { zoom_uuid: uuid } = payload
  if (!uuid) throw new Error('reconcile: missing zoom_uuid')

  const d = {
    fetch: deps.fetch ?? fetch,
    getToken: deps.getToken ?? (() => getZoomAccessToken()),
    write: deps.write ?? upsertAttendanceFinal,
  }

  const participants = await fetchAllParticipants(uuid, d)
  const finals = reconcileParticipants(participants)
  const now = Date.now()
  for (const f of finals) {
    d.write({
      zoom_uuid: uuid,
      user_id: f.user_id,
      email: f.email,
      display_name: f.display_name,
      present_seconds: f.present_seconds,
      sessions_json: JSON.stringify(f.sessions),
      computed_at: now,
    })
  }
  return finals.length
}
