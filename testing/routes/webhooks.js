/**
 * Zoom webhook ingestion — the durable attendance spine.
 *
 * This router MUST be mounted with a raw body parser (express.raw) BEFORE the
 * global express.json(), because the signature is computed over the exact raw
 * bytes Zoom sent. See server.js for the mount.
 *
 * Handles: endpoint.url_validation (handshake), meeting.started,
 * meeting.participant_joined / _left, meeting.ended, recording.completed.
 * Every event is verified, deduped, and (for slow work) turned into a job.
 *
 * Docs: https://developers.zoom.us/docs/api/webhooks/
 */
import { Router } from 'express'
import { createHmac, timingSafeEqual } from 'node:crypto'
import {
  claimWebhookEvent,
  upsertMeetingRow,
  recordParticipantJoin,
  recordParticipantLeave,
  markMeetingEnded,
  enqueueJob,
} from '../lib/db.js'

const RECONCILE_DELAY_MS = 5 * 60_000 // give Zoom time to finalize the report

/** ISO-8601 (or epoch) → epoch ms, or null. */
function toMs(t) {
  if (t == null) return null
  if (typeof t === 'number') return t
  const ms = Date.parse(t)
  return Number.isNaN(ms) ? null : ms
}

/** Constant-time compare of two hex/ascii strings. */
function safeEqual(a, b) {
  const ba = Buffer.from(a)
  const bb = Buffer.from(b)
  if (ba.length !== bb.length) return false
  return timingSafeEqual(ba, bb)
}

/**
 * @param {{ secretToken: string }} opts
 * @returns {import('express').Router}
 */
export function createWebhookRouter({ secretToken }) {
  const router = Router()

  router.post('/', (req, res) => {
    // req.body is a Buffer here (express.raw). Keep the raw bytes for the HMAC.
    const raw = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : ''
    let event
    try {
      event = JSON.parse(raw || '{}')
    } catch {
      return res.status(400).json({ error: 'invalid JSON' })
    }

    // 1) URL validation handshake — must echo an HMAC of the plainToken.
    if (event.event === 'endpoint.url_validation') {
      const plainToken = event.payload?.plainToken ?? ''
      const encryptedToken = createHmac('sha256', secretToken)
        .update(plainToken)
        .digest('hex')
      return res.json({ plainToken, encryptedToken })
    }

    // 2) Verify signature: v0={hex hmac of `v0:{ts}:{rawBody}`}
    const ts = req.header('x-zm-request-timestamp') ?? ''
    const signature = req.header('x-zm-signature') ?? ''
    const expected =
      'v0=' +
      createHmac('sha256', secretToken).update(`v0:${ts}:${raw}`).digest('hex')
    if (!signature || !safeEqual(expected, signature)) {
      return res.status(401).json({ error: 'invalid signature' })
    }

    // 3) Idempotency — Zoom redelivers. event_ts + event is a stable-enough key.
    const eventId = `${event.event}:${event.event_ts ?? ''}:${
      event.payload?.object?.uuid ?? ''
    }:${event.payload?.object?.participant?.participant_uuid ?? ''}`
    if (!claimWebhookEvent(eventId)) {
      return res.status(200).json({ status: 'duplicate-ignored' })
    }

    // 4) Route the event. Ack fast (200) — heavy work goes to the job queue.
    try {
      handleEvent(event)
    } catch (err) {
      // Log but still 200: a 5xx makes Zoom retry, and the data is best-effort
      // (reconciliation via Reports API is the source of truth anyway).
      console.error('[webhook] handler error:', err)
    }
    return res.status(200).json({ status: 'ok' })
  })

  return router
}

function handleEvent(event) {
  const obj = event.payload?.object ?? {}
  const zoomUuid = obj.uuid
  if (!zoomUuid && event.event.startsWith('meeting.')) return

  switch (event.event) {
    case 'meeting.started':
      upsertMeetingRow({
        zoom_uuid: zoomUuid,
        zoom_meeting_id: obj.id,
        host_user_id: obj.host_id,
        topic: obj.topic,
        started_at: toMs(obj.start_time) ?? Date.now(),
      })
      break

    case 'meeting.participant_joined': {
      const p = obj.participant ?? {}
      upsertMeetingRow({ zoom_uuid: zoomUuid, zoom_meeting_id: obj.id, topic: obj.topic })
      recordParticipantJoin({
        zoom_uuid: zoomUuid,
        participant_uuid: p.participant_uuid ?? p.user_id ?? `${p.user_name}-${p.join_time}`,
        user_id: p.customer_key ?? null, // our app user id (identity glue)
        email: p.email ?? null, // fallback match key
        display_name: p.user_name ?? null,
        joined_at: toMs(p.join_time) ?? Date.now(),
      })
      break
    }

    case 'meeting.participant_left': {
      const p = obj.participant ?? {}
      recordParticipantLeave({
        zoom_uuid: zoomUuid,
        participant_uuid: p.participant_uuid ?? p.user_id ?? `${p.user_name}-${p.leave_time}`,
        left_at: toMs(p.leave_time) ?? Date.now(),
      })
      break
    }

    case 'meeting.ended':
      markMeetingEnded(zoomUuid, toMs(obj.end_time) ?? Date.now())
      // Reconcile against the Reports API after Zoom finalizes the report.
      enqueueJob(
        'reconcile',
        { zoom_uuid: zoomUuid, zoom_meeting_id: obj.id },
        Date.now() + RECONCILE_DELAY_MS,
      )
      break

    case 'recording.completed':
      // download_token may arrive at the event root or inside payload.
      enqueueJob('recording_ingest', {
        zoom_uuid: zoomUuid,
        zoom_meeting_id: obj.id,
        download_token: event.download_token ?? event.payload?.download_token ?? null,
        recording_files: obj.recording_files ?? [],
      })
      break

    default:
      // Unsubscribed/unknown event — ignore.
      break
  }
}
