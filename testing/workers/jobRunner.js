/**
 * In-process durable job worker (MVP).
 *
 * Polls the `jobs` table on an interval, atomically claims each due job, and
 * dispatches by type. Failed jobs are retried with exponential backoff (in
 * lib/db.failJob) up to a cap. Handlers must be idempotent — a job may run more
 * than once. Swap this for BullMQ/SQS later without touching callers.
 */
import { dueJobs, takeJob, completeJob, failJob } from '../lib/db.js'
import { runReconcile } from './reconcile.js'
import { runRecordingIngest } from './recordingIngest.js'

const DEFAULT_HANDLERS = {
  reconcile: runReconcile,
  recording_ingest: runRecordingIngest,
}

/**
 * Process all jobs that are currently due. Returns the count processed.
 * Exposed separately so tests can drive one tick deterministically.
 */
export async function tick(handlers = DEFAULT_HANDLERS, batch = 5) {
  const jobs = dueJobs(batch)
  let processed = 0
  for (const job of jobs) {
    if (!takeJob(job.id)) continue // someone else claimed it
    const handler = handlers[job.type]
    try {
      if (!handler) throw new Error(`no handler for job type "${job.type}"`)
      const payload = JSON.parse(job.payload || '{}')
      await handler(payload)
      completeJob(job.id)
    } catch (err) {
      console.error(`[jobs] job ${job.id} (${job.type}) failed:`, err.message)
      failJob(job.id, job.attempts, err.message)
    }
    processed++
  }
  return processed
}

let timer = null

/** Start the polling loop. Returns a stop() function. */
export function startJobRunner({ intervalMs = 30_000, handlers = DEFAULT_HANDLERS } = {}) {
  if (timer) return stopJobRunner
  let running = false
  timer = setInterval(async () => {
    if (running) return // don't overlap ticks
    running = true
    try {
      await tick(handlers)
    } catch (err) {
      console.error('[jobs] tick error:', err)
    } finally {
      running = false
    }
  }, intervalMs)
  timer.unref?.() // don't keep the process alive just for polling
  console.log(`✅ Job runner started (every ${intervalMs}ms)`)
  return stopJobRunner
}

export function stopJobRunner() {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
}
