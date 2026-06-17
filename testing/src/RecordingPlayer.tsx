import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * Compliance-grade recording player.
 *
 * Tracks the spans the viewer ACTUALLY plays and reports them to the backend,
 * which unions them into watch coverage. Seeking closes the current span and
 * starts a fresh one after the seek, so dragging the scrubber forward never
 * earns credit for skipped regions.
 *
 * Identity note: userId is passed as the x-user-id header for this demo. In
 * production the backend derives it from the authenticated session instead.
 */
interface Props {
  meetingId: string
  userId: string
}

const HEARTBEAT_MS = 10_000

export default function RecordingPlayer({ meetingId, userId }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const [src, setSrc] = useState<string | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [percent, setPercent] = useState(0)
  const [resumeAt, setResumeAt] = useState(0)

  // span tracking
  const spanStart = useRef<number | null>(null)
  const lastTime = useRef(0)

  const api = (path: string, init?: RequestInit) =>
    fetch(`/api/recordings/${meetingId}${path}`, {
      ...init,
      headers: { 'content-type': 'application/json', 'x-user-id': userId, ...(init?.headers ?? {}) },
    })

  // Send the currently-open played span [spanStart, lastTime] to the backend.
  const flush = useCallback(
    (reason: string) => {
      const v = videoRef.current
      if (!v || spanStart.current == null) return
      const from = spanStart.current
      const to = lastTime.current
      // reset the open span to the current position
      spanStart.current = v.paused ? null : v.currentTime
      if (to - from < 0.5) return // ignore sub-half-second blips
      api('/heartbeat', {
        method: 'POST',
        body: JSON.stringify({ played_from: from, played_to: to, duration: v.duration || 0 }),
        keepalive: reason === 'unload',
      })
        .then((r) => (r.ok ? r.json() : null))
        .then((j) => j && typeof j.percentComplete === 'number' && setPercent(j.percentComplete))
        .catch(() => {})
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [meetingId, userId],
  )

  // Load signed URL + prior progress.
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const [urlRes, progRes] = await Promise.all([api('/url'), api('/progress')])
        if (cancelled) return
        if (!urlRes.ok) {
          const j = await urlRes.json().catch(() => ({}))
          setLoadError(j.error || `recording unavailable (${urlRes.status})`)
        } else {
          const { url } = await urlRes.json()
          setSrc(url)
        }
        if (progRes.ok) {
          const p = await progRes.json()
          setPercent(p.percentComplete || 0)
          setResumeAt(p.lastPosition || 0)
        }
      } catch (e) {
        if (!cancelled) setLoadError(String(e))
      }
    })()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meetingId, userId])

  // Periodic flush while playing + flush on tab close.
  useEffect(() => {
    const id = setInterval(() => flush('interval'), HEARTBEAT_MS)
    const onUnload = () => flush('unload')
    window.addEventListener('pagehide', onUnload)
    return () => {
      clearInterval(id)
      window.removeEventListener('pagehide', onUnload)
      flush('unmount')
    }
  }, [flush])

  // Resume to the saved position once metadata is ready.
  const onLoadedMetadata = () => {
    if (resumeAt > 0 && videoRef.current) videoRef.current.currentTime = resumeAt
  }

  const onPlay = () => {
    if (videoRef.current) spanStart.current = videoRef.current.currentTime
  }
  const onTimeUpdate = () => {
    if (videoRef.current && !videoRef.current.seeking) lastTime.current = videoRef.current.currentTime
  }
  // A seek closes the current span; the gap is never counted.
  const onSeeking = () => flush('seek')
  const onSeeked = () => {
    if (videoRef.current && !videoRef.current.paused) spanStart.current = videoRef.current.currentTime
  }
  const onPause = () => flush('pause')
  const onEnded = () => flush('ended')

  return (
    <div className="recording-player">
      <h2>Recording — coverage {(percent * 100).toFixed(1)}%</h2>
      <div className="coverage-bar">
        <div className="coverage-fill" style={{ width: `${Math.min(100, percent * 100)}%` }} />
      </div>

      {loadError && <div className="alert alert-error">{loadError}</div>}

      {src ? (
        <video
          ref={videoRef}
          src={src}
          controls
          width={720}
          onLoadedMetadata={onLoadedMetadata}
          onPlay={onPlay}
          onTimeUpdate={onTimeUpdate}
          onSeeking={onSeeking}
          onSeeked={onSeeked}
          onPause={onPause}
          onEnded={onEnded}
        />
      ) : (
        !loadError && <p>Loading recording…</p>
      )}
    </div>
  )
}
