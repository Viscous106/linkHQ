/**
 * Recording playback + compliance-grade watch tracking.
 *
 *   GET  /api/recordings/:meetingId/url       → short-lived CloudFront signed URL
 *   GET  /api/recordings/:meetingId/progress  → this user's saved progress (resume)
 *   POST /api/recordings/:meetingId/heartbeat → union an actually-played span
 *
 * Watch credit comes ONLY from played intervals (union), never from raw
 * currentTime — so seeking/scrubbing to the end cannot inflate coverage.
 *
 * IDENTITY: getUserId() must, in production, read the authenticated session
 * (Phase 0.5 requireUser middleware). For this build slice it falls back to an
 * x-user-id header / body field — clearly insufficient for real compliance.
 */
import { Router } from 'express'
import { readFileSync } from 'node:fs'
import { getSignedUrl } from '@aws-sdk/cloudfront-signer'
import { mergeIntervals, coverageFraction } from '../lib/intervals.js'
import db, { getWatchProgress, saveWatchProgress } from '../lib/db.js'

const URL_TTL_MS = 5 * 60_000

function getUserId(req) {
  // TODO(auth): replace with req.userId from requireUser middleware (Phase 0.5).
  return req.userId || req.header('x-user-id') || req.body?.userId || null
}

function cloudFrontPrivateKey(env) {
  if (env.CLOUDFRONT_PRIVATE_KEY_FILE) {
    return readFileSync(env.CLOUDFRONT_PRIVATE_KEY_FILE, 'utf8')
  }
  // allow a one-line env value with escaped newlines
  return (env.CLOUDFRONT_PRIVATE_KEY || '').replace(/\\n/g, '\n')
}

/**
 * PURE: fold a newly-played [from,to] span into the existing watched segments
 * and recompute coverage. Exposed for unit testing.
 */
export function applyHeartbeat(prevSegments, playedFrom, playedTo, duration) {
  const merged = mergeIntervals([...(prevSegments || []), [playedFrom, playedTo]])
  const percent = coverageFraction(merged, duration)
  return { segments: merged, percent }
}

export function createRecordingsRouter({ env = process.env } = {}) {
  const router = Router()

  // Signed playback URL for the stored recording.
  router.get('/:meetingId/url', (req, res) => {
    const meeting = db
      .prepare('SELECT recording_s3_key, recording_status FROM meetings WHERE id = ? OR zoom_uuid = ?')
      .get(req.params.meetingId, req.params.meetingId)

    if (!meeting?.recording_s3_key || meeting.recording_status !== 'stored') {
      return res.status(404).json({ error: 'recording not available', status: meeting?.recording_status ?? 'none' })
    }
    if (!env.CLOUDFRONT_DOMAIN || !env.CLOUDFRONT_KEY_PAIR_ID) {
      return res.status(501).json({ error: 'CloudFront not configured', configured: false })
    }

    const url = `https://${env.CLOUDFRONT_DOMAIN}/${meeting.recording_s3_key}`
    try {
      const signed = getSignedUrl({
        url,
        keyPairId: env.CLOUDFRONT_KEY_PAIR_ID,
        privateKey: cloudFrontPrivateKey(env),
        dateLessThan: new Date(Date.now() + URL_TTL_MS).toISOString(),
      })
      res.json({ url: signed, expiresInMs: URL_TTL_MS })
    } catch (err) {
      res.status(500).json({ error: `failed to sign URL: ${err.message}` })
    }
  })

  // Resume point + current coverage for this user.
  router.get('/:meetingId/progress', (req, res) => {
    const userId = getUserId(req)
    if (!userId) return res.status(401).json({ error: 'no user identity' })
    const row = getWatchProgress(req.params.meetingId, userId)
    if (!row) return res.json({ lastPosition: 0, percentComplete: 0, segments: [] })
    res.json({
      lastPosition: row.last_position_seconds,
      percentComplete: row.percent_complete,
      segments: JSON.parse(row.watched_segments || '[]'),
    })
  })

  // Heartbeat: union the actually-played span.
  router.post('/:meetingId/heartbeat', (req, res) => {
    const userId = getUserId(req)
    if (!userId) return res.status(401).json({ error: 'no user identity' })

    const meetingId = req.params.meetingId
    const playedFrom = Number(req.body?.played_from)
    const playedTo = Number(req.body?.played_to)
    const duration = Number(req.body?.duration)
    if (!Number.isFinite(playedFrom) || !Number.isFinite(playedTo) || !Number.isFinite(duration)) {
      return res.status(400).json({ error: 'played_from, played_to, duration required (numbers)' })
    }

    const existing = getWatchProgress(meetingId, userId)
    const prevSegments = existing ? JSON.parse(existing.watched_segments || '[]') : []
    const { segments, percent } = applyHeartbeat(prevSegments, playedFrom, playedTo, duration)

    const maxPos = Math.max(existing?.max_position_seconds ?? 0, playedTo)
    saveWatchProgress({
      meeting_id: meetingId,
      user_id: userId,
      recording_s3_key: existing?.recording_s3_key ?? null,
      last_position_seconds: playedTo,
      max_position_seconds: maxPos,
      watched_segments: JSON.stringify(segments),
      duration_seconds: duration,
      percent_complete: percent,
      updated_at: Date.now(),
    })

    res.json({ percentComplete: percent, segments })
  })

  return router
}
