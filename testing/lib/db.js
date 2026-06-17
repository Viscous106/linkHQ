/**
 * SQLite data layer (single-process MVP).
 *
 * Holds the durable state the SDK cannot: the attendance log (from webhooks),
 * the authoritative attendance record (from the Reports API), recording
 * watch-coverage, webhook idempotency keys, app users, and the background job
 * queue. Swap better-sqlite3 for Postgres later without changing call sites —
 * keep all SQL in this module.
 */
import Database from 'better-sqlite3'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

const DB_PATH = process.env.DATABASE_URL || './data/app.sqlite'

// Ensure the parent directory exists (e.g. ./data) before opening.
try {
  mkdirSync(dirname(DB_PATH), { recursive: true })
} catch {
  /* dir already exists */
}

const db = new Database(DB_PATH)
db.pragma('journal_mode = WAL')
db.pragma('foreign_keys = ON')

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id            TEXT PRIMARY KEY,
    email         TEXT UNIQUE,
    display_name  TEXT,
    created_at    INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS meetings (
    id                TEXT PRIMARY KEY,           -- our id (= zoom_uuid normalized)
    zoom_meeting_id   TEXT,                       -- numeric meeting number
    zoom_uuid         TEXT UNIQUE,                -- per-occurrence uuid
    host_user_id      TEXT,
    topic             TEXT,
    started_at        INTEGER,
    ended_at          INTEGER,
    recording_s3_key  TEXT,
    recording_status  TEXT DEFAULT 'none'         -- none|pending|stored|failed
  );

  -- one row per join<->leave session; a user may have several per meeting
  CREATE TABLE IF NOT EXISTS attendance_sessions (
    id                    INTEGER PRIMARY KEY AUTOINCREMENT,
    zoom_uuid             TEXT NOT NULL,
    zoom_participant_uuid TEXT NOT NULL,
    user_id               TEXT,                   -- customer_key (our app user id)
    email                 TEXT,                   -- fallback match key
    display_name          TEXT,
    joined_at             INTEGER,
    left_at               INTEGER,
    source                TEXT DEFAULT 'webhook', -- webhook|report
    UNIQUE (zoom_uuid, zoom_participant_uuid)
  );

  -- authoritative per-user totals after reconciliation against the Reports API
  CREATE TABLE IF NOT EXISTS attendance_final (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    zoom_uuid       TEXT NOT NULL,
    user_id         TEXT,
    email           TEXT,
    display_name    TEXT,
    present_seconds INTEGER NOT NULL,
    sessions_json   TEXT,
    computed_at     INTEGER NOT NULL,
    UNIQUE (zoom_uuid, user_id, email)
  );

  -- recording watch coverage per user (compliance-grade: union of played spans)
  CREATE TABLE IF NOT EXISTS watch_progress (
    id                    INTEGER PRIMARY KEY AUTOINCREMENT,
    meeting_id            TEXT NOT NULL,
    user_id               TEXT NOT NULL,
    recording_s3_key      TEXT,
    last_position_seconds REAL DEFAULT 0,
    max_position_seconds  REAL DEFAULT 0,
    watched_segments      TEXT DEFAULT '[]',      -- JSON array of [start,end]
    duration_seconds      REAL DEFAULT 0,
    percent_complete      REAL DEFAULT 0,
    updated_at            INTEGER NOT NULL,
    UNIQUE (meeting_id, user_id)
  );

  -- idempotency for redelivered webhooks
  CREATE TABLE IF NOT EXISTS webhook_events (
    event_id    TEXT PRIMARY KEY,
    received_at INTEGER NOT NULL
  );

  -- durable background jobs polled by the in-process worker
  CREATE TABLE IF NOT EXISTS jobs (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    type        TEXT NOT NULL,                    -- reconcile|recording_ingest
    payload     TEXT NOT NULL DEFAULT '{}',
    run_after   INTEGER NOT NULL,
    status      TEXT NOT NULL DEFAULT 'pending',  -- pending|running|done|failed
    attempts    INTEGER NOT NULL DEFAULT 0,
    last_error  TEXT,
    created_at  INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_jobs_due ON jobs (status, run_after);
  CREATE INDEX IF NOT EXISTS idx_att_uuid ON attendance_sessions (zoom_uuid);
`)

export default db

// ── Webhook idempotency ─────────────────────────────────────────────────────
const insertEvent = db.prepare(
  `INSERT OR IGNORE INTO webhook_events (event_id, received_at) VALUES (?, ?)`,
)
/** Returns true if this is the FIRST time we've seen event_id (i.e. process it). */
export function claimWebhookEvent(eventId, now = Date.now()) {
  if (!eventId) return true // no id → can't dedupe; let it through
  return insertEvent.run(String(eventId), now).changes > 0
}

// ── Attendance sessions (from participant_joined / participant_left) ─────────
const upsertJoin = db.prepare(`
  INSERT INTO attendance_sessions
    (zoom_uuid, zoom_participant_uuid, user_id, email, display_name, joined_at, source)
  VALUES (@zoom_uuid, @participant_uuid, @user_id, @email, @display_name, @joined_at, 'webhook')
  ON CONFLICT (zoom_uuid, zoom_participant_uuid) DO UPDATE SET
    joined_at    = COALESCE(attendance_sessions.joined_at, excluded.joined_at),
    user_id      = COALESCE(attendance_sessions.user_id, excluded.user_id),
    email        = COALESCE(attendance_sessions.email, excluded.email),
    display_name = COALESCE(attendance_sessions.display_name, excluded.display_name)
`)
export function recordParticipantJoin(row) {
  upsertJoin.run(row)
}

// Tolerates out-of-order delivery: if 'left' arrives before 'joined', insert a
// stub row keyed on the participant uuid; the later 'joined' fills join time.
const upsertLeave = db.prepare(`
  INSERT INTO attendance_sessions
    (zoom_uuid, zoom_participant_uuid, left_at, source)
  VALUES (@zoom_uuid, @participant_uuid, @left_at, 'webhook')
  ON CONFLICT (zoom_uuid, zoom_participant_uuid) DO UPDATE SET
    left_at = excluded.left_at
`)
export function recordParticipantLeave(row) {
  upsertLeave.run(row)
}

// ── Meetings ────────────────────────────────────────────────────────────────
const upsertMeeting = db.prepare(`
  INSERT INTO meetings (id, zoom_meeting_id, zoom_uuid, host_user_id, topic, started_at)
  VALUES (@id, @zoom_meeting_id, @zoom_uuid, @host_user_id, @topic, @started_at)
  ON CONFLICT (id) DO UPDATE SET
    zoom_meeting_id = COALESCE(excluded.zoom_meeting_id, meetings.zoom_meeting_id),
    topic           = COALESCE(excluded.topic, meetings.topic),
    started_at      = COALESCE(meetings.started_at, excluded.started_at)
`)
export function upsertMeetingRow(row) {
  upsertMeeting.run({
    id: row.zoom_uuid,
    zoom_meeting_id: row.zoom_meeting_id ?? null,
    zoom_uuid: row.zoom_uuid,
    host_user_id: row.host_user_id ?? null,
    topic: row.topic ?? null,
    started_at: row.started_at ?? null,
  })
}
const setMeetingEnded = db.prepare(
  `UPDATE meetings SET ended_at = ? WHERE zoom_uuid = ?`,
)
export function markMeetingEnded(zoomUuid, endedAt = Date.now()) {
  setMeetingEnded.run(endedAt, zoomUuid)
}
const setRecording = db.prepare(
  `UPDATE meetings SET recording_s3_key = ?, recording_status = ? WHERE zoom_uuid = ?`,
)
export function setMeetingRecording(zoomUuid, s3Key, status) {
  setRecording.run(s3Key, status, zoomUuid)
}

// ── Authoritative attendance (Reports API reconciliation) ───────────────────
const upsertFinal = db.prepare(`
  INSERT INTO attendance_final
    (zoom_uuid, user_id, email, display_name, present_seconds, sessions_json, computed_at)
  VALUES (@zoom_uuid, @user_id, @email, @display_name, @present_seconds, @sessions_json, @computed_at)
  ON CONFLICT (zoom_uuid, user_id, email) DO UPDATE SET
    present_seconds = excluded.present_seconds,
    sessions_json   = excluded.sessions_json,
    display_name    = excluded.display_name,
    computed_at     = excluded.computed_at
`)
export function upsertAttendanceFinal(row) {
  upsertFinal.run(row)
}

// ── Watch progress ──────────────────────────────────────────────────────────
const getWatch = db.prepare(
  `SELECT * FROM watch_progress WHERE meeting_id = ? AND user_id = ?`,
)
export function getWatchProgress(meetingId, userId) {
  return getWatch.get(meetingId, userId)
}
const upsertWatch = db.prepare(`
  INSERT INTO watch_progress
    (meeting_id, user_id, recording_s3_key, last_position_seconds,
     max_position_seconds, watched_segments, duration_seconds, percent_complete, updated_at)
  VALUES (@meeting_id, @user_id, @recording_s3_key, @last_position_seconds,
     @max_position_seconds, @watched_segments, @duration_seconds, @percent_complete, @updated_at)
  ON CONFLICT (meeting_id, user_id) DO UPDATE SET
    recording_s3_key      = excluded.recording_s3_key,
    last_position_seconds = excluded.last_position_seconds,
    max_position_seconds  = MAX(watch_progress.max_position_seconds, excluded.max_position_seconds),
    watched_segments      = excluded.watched_segments,
    duration_seconds      = excluded.duration_seconds,
    percent_complete      = excluded.percent_complete,
    updated_at            = excluded.updated_at
`)
export function saveWatchProgress(row) {
  upsertWatch.run(row)
}

// ── Jobs ────────────────────────────────────────────────────────────────────
const insertJob = db.prepare(`
  INSERT INTO jobs (type, payload, run_after, created_at)
  VALUES (?, ?, ?, ?)
`)
export function enqueueJob(type, payload, runAfter = Date.now()) {
  return insertJob.run(type, JSON.stringify(payload ?? {}), runAfter, Date.now()).lastInsertRowid
}
const claimDueJobs = db.prepare(`
  SELECT * FROM jobs
  WHERE status = 'pending' AND run_after <= ?
  ORDER BY run_after ASC
  LIMIT ?
`)
export function dueJobs(limit = 5, now = Date.now()) {
  return claimDueJobs.all(now, limit)
}
const markJobRunning = db.prepare(`UPDATE jobs SET status = 'running' WHERE id = ? AND status = 'pending'`)
export function takeJob(id) {
  return markJobRunning.run(id).changes > 0
}
const markJobDone = db.prepare(`UPDATE jobs SET status = 'done' WHERE id = ?`)
export function completeJob(id) {
  markJobDone.run(id)
}
const markJobRetry = db.prepare(`
  UPDATE jobs SET status = 'pending', attempts = attempts + 1, last_error = ?, run_after = ? WHERE id = ?
`)
const markJobFailed = db.prepare(`
  UPDATE jobs SET status = 'failed', attempts = attempts + 1, last_error = ? WHERE id = ?
`)
export function failJob(id, attempts, error, maxAttempts = 5) {
  if (attempts + 1 >= maxAttempts) {
    markJobFailed.run(String(error), id)
  } else {
    const backoffMs = Math.min(60_000 * 2 ** attempts, 15 * 60_000)
    markJobRetry.run(String(error), Date.now() + backoffMs, id)
  }
}

// ── Users (Phase 0.5 minimal auth) ──────────────────────────────────────────
const insertUser = db.prepare(`
  INSERT INTO users (id, email, display_name, created_at)
  VALUES (@id, @email, @display_name, @created_at)
  ON CONFLICT (email) DO UPDATE SET display_name = excluded.display_name
  RETURNING *
`)
export function upsertUser(row) {
  return insertUser.get(row)
}
const findUserByEmail = db.prepare(`SELECT * FROM users WHERE email = ?`)
export function getUserByEmail(email) {
  return findUserByEmail.get(email)
}
