import { useEffect, useRef, useState } from 'react'
import * as ZoomSDK from '@zoom/meetingsdk/embedded'
import RecordingPlayer from './RecordingPlayer'

// CJS/ESM interop: the embedded SDK is a UMD bundle
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ZoomMtgEmbedded = ((ZoomSDK as any).default ?? ZoomSDK) as typeof import('@zoom/meetingsdk/embedded').default
type EmbeddedClient = ReturnType<typeof ZoomMtgEmbedded.createClient>
import './App.css'

interface JoinFormData {
  meetingNumber: string
  password: string
  userName: string
  userEmail: string
  role: 0 | 1 // 0 = attendee, 1 = host
}

const initialForm: JoinFormData = {
  meetingNumber: '',
  password: '',
  userName: '',
  userEmail: '',
  role: 0,
}

/**
 * Identity glue: the value passed to Zoom as `customerKey` so webhook + report
 * payloads are attributable to a real app user. Zoom caps this at 35 chars.
 * NOTE: with real auth this MUST come from the validated server session, never
 * from a free-typed field. Here we derive it from the email for the demo.
 */
function deriveCustomerKey(email: string, name: string): string {
  const base = (email || name || 'guest').trim().toLowerCase()
  return base.slice(0, 35)
}

export default function App() {
  const meetingSDKElementRef = useRef<HTMLDivElement>(null)
  const clientRef = useRef<EmbeddedClient | null>(null)
  const [form, setForm] = useState<JoinFormData>(initialForm)
  const [status, setStatus] = useState<'idle' | 'joining' | 'in-meeting' | 'error'>('idle')
  const [errorMsg, setErrorMsg] = useState('')
  const [sdkReady, setSdkReady] = useState(false)
  const [attendeeCount, setAttendeeCount] = useState(0)
  const [view, setView] = useState<'join' | 'recordings'>('join')
  const [recMeetingId, setRecMeetingId] = useState('')
  const [recUserId, setRecUserId] = useState('')
  const [recActive, setRecActive] = useState(false)

  useEffect(() => {
    // Initialize the embedded client once on mount
    const client = ZoomMtgEmbedded.createClient()
    clientRef.current = client
    setSdkReady(true)
    return () => {
      // Clean up on unmount
      try { ZoomMtgEmbedded.destroyClient() } catch (_) { /* noop */ }
    }
  }, [])

  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    const { name, value } = e.target
    setForm(prev => ({ ...prev, [name]: name === 'role' ? Number(value) : value }))
  }

  // Recompute the live attendee count from the SDK's current participant list.
  const refreshAttendeeCount = () => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const list = (clientRef.current as any)?.getAttendeeslist?.() ?? []
      setAttendeeCount(Array.isArray(list) ? list.length : 0)
    } catch {
      /* not in a meeting yet */
    }
  }

  const attachAttendeeListeners = () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const c = clientRef.current as any
    if (!c) return
    c.on('user-added', refreshAttendeeCount)
    c.on('user-removed', refreshAttendeeCount)
    c.on('user-updated', refreshAttendeeCount)
    refreshAttendeeCount()
  }

  const detachAttendeeListeners = () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const c = clientRef.current as any
    if (!c) return
    try {
      c.off('user-added', refreshAttendeeCount)
      c.off('user-removed', refreshAttendeeCount)
      c.off('user-updated', refreshAttendeeCount)
    } catch {
      /* noop */
    }
    setAttendeeCount(0)
  }

  const getSignature = async (meetingNumber: string, role: number) => {
    const res = await fetch('/api/signature', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ meetingNumber, role }),
    })
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: 'Failed to fetch signature' }))
      throw new Error(err.error || 'Server error')
    }
    return res.json() as Promise<{ signature: string; sdkKey: string }>
  }

  const joinMeeting = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!clientRef.current || !meetingSDKElementRef.current) return

    setStatus('joining')
    setErrorMsg('')

    try {
      // 1. Get signature from backend
      const { signature } = await getSignature(form.meetingNumber, form.role)

      // 2. Init the embedded client
      await clientRef.current.init({
        debug: true,
        zoomAppRoot: meetingSDKElementRef.current,
        language: 'en-US',
        customize: {
          video: {
            isResizable: true,
            viewSizes: {
              default: { width: 1000, height: 600 },
            },
          },
          meetingInfo: [
            'topic',
            'host',
            'mn',
            'pwd',
            'telPwd',
            'invite',
            'participant',
            'dc',
            'enctype',
          ],
        },
      })

      // 3. Join the meeting — customerKey is the identity glue (see deriveCustomerKey)
      await clientRef.current.join({
        signature,
        meetingNumber: form.meetingNumber,
        password: form.password,
        userName: form.userName,
        userEmail: form.userEmail,
        customerKey: deriveCustomerKey(form.userEmail, form.userName),
      })

      setStatus('in-meeting')

      // 4. Live attendee counter — driven by SDK events (UI only, NOT persisted;
      // the durable attendance log comes from server-side webhooks).
      attachAttendeeListeners()
    } catch (err: unknown) {
      console.error('Zoom SDK error:', err)
      let msg: string
      if (err instanceof Error) {
        msg = err.message
      } else if (typeof err === 'object' && err !== null) {
        // Zoom SDK returns error objects like { type, reason, errorCode }
        const e = err as Record<string, unknown>
        msg = `${e.type ?? ''} ${e.reason ?? ''} ${e.errorCode ?? ''} — ${JSON.stringify(err)}`
      } else {
        msg = String(err)
      }
      setErrorMsg(msg.trim() || 'Unknown error — check browser console (F12)')
      setStatus('error')
    }
  }

  const leaveMeeting = async () => {
    detachAttendeeListeners()
    try {
      await clientRef.current?.leaveMeeting()
    } catch (_) { /* noop */ }
    setStatus('idle')
    setForm(initialForm)
  }

  return (
    <div className="app">
      {/* Header */}
      <header className="header">
        <div className="header-inner">
          <div className="logo">
            <svg width="28" height="28" viewBox="0 0 28 28" fill="none" xmlns="http://www.w3.org/2000/svg">
              <rect width="28" height="28" rx="6" fill="#2D8CFF"/>
              <path d="M6 10.5C6 9.67 6.67 9 7.5 9H16.5C17.33 9 18 9.67 18 10.5V17.5C18 18.33 17.33 19 16.5 19H7.5C6.67 19 6 18.33 6 17.5V10.5Z" fill="white"/>
              <path d="M19 12.5L22.5 10V18L19 15.5V12.5Z" fill="white"/>
            </svg>
            <span>Zoom SDK</span>
            <span className="badge">Component View</span>
          </div>
          <div className="header-status">
            <span className={`status-dot ${sdkReady ? 'ready' : 'loading'}`} />
            <span>{sdkReady ? 'SDK Ready' : 'Initializing…'}</span>
          </div>
        </div>
      </header>

      <main className="main">
        {/* Tabs (hidden while in a meeting) */}
        {status !== 'in-meeting' && (
          <div className="tabs">
            <button
              className={`tab ${view === 'join' ? 'active' : ''}`}
              onClick={() => setView('join')}
            >
              Join Meeting
            </button>
            <button
              className={`tab ${view === 'recordings' ? 'active' : ''}`}
              onClick={() => setView('recordings')}
            >
              Recordings
            </button>
          </div>
        )}

        {/* Recordings: watch-tracking demo */}
        {status !== 'in-meeting' && view === 'recordings' && (
          <div className="card join-card">
            <div className="card-header">
              <h1>Recording Playback</h1>
              <p>Enter a meeting UUID and your user id to watch its recording with compliance-grade watch tracking.</p>
            </div>
            {!recActive ? (
              <div className="join-form">
                <div className="form-row">
                  <div className="form-group">
                    <label htmlFor="recMeetingId">Meeting UUID *</label>
                    <input
                      id="recMeetingId"
                      value={recMeetingId}
                      onChange={(e) => setRecMeetingId(e.target.value)}
                      placeholder="meeting uuid"
                    />
                  </div>
                  <div className="form-group">
                    <label htmlFor="recUserId">Your User ID *</label>
                    <input
                      id="recUserId"
                      value={recUserId}
                      onChange={(e) => setRecUserId(e.target.value)}
                      placeholder="e.g. your@email.com"
                    />
                  </div>
                </div>
                <button
                  className="btn btn-primary"
                  disabled={!recMeetingId || !recUserId}
                  onClick={() => setRecActive(true)}
                >
                  Load Recording
                </button>
              </div>
            ) : (
              <>
                <button className="btn btn-danger btn-sm" onClick={() => setRecActive(false)}>
                  ← Back
                </button>
                <RecordingPlayer meetingId={recMeetingId} userId={recUserId} />
              </>
            )}
          </div>
        )}

        {/* Join Form */}
        {status !== 'in-meeting' && view === 'join' && (
          <div className="card join-card">
            <div className="card-header">
              <h1>Join a Meeting</h1>
              <p>Enter your meeting details below to join via the Zoom Component View.</p>
            </div>

            {status === 'error' && (
              <div className="alert alert-error">
                <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M8 1a7 7 0 100 14A7 7 0 008 1zm-.75 4a.75.75 0 011.5 0v3a.75.75 0 01-1.5 0V5zm.75 6a1 1 0 110-2 1 1 0 010 2z"/></svg>
                <span>{errorMsg}</span>
              </div>
            )}

            <form onSubmit={joinMeeting} className="join-form">
              <div className="form-row">
                <div className="form-group">
                  <label htmlFor="meetingNumber">Meeting Number *</label>
                  <input
                    id="meetingNumber"
                    name="meetingNumber"
                    type="text"
                    placeholder="e.g. 1234567890"
                    value={form.meetingNumber}
                    onChange={handleChange}
                    required
                    disabled={status === 'joining'}
                  />
                </div>
                <div className="form-group">
                  <label htmlFor="password">Meeting Password</label>
                  <input
                    id="password"
                    name="password"
                    type="password"
                    placeholder="Leave blank if none"
                    value={form.password}
                    onChange={handleChange}
                    disabled={status === 'joining'}
                  />
                </div>
              </div>

              <div className="form-row">
                <div className="form-group">
                  <label htmlFor="userName">Display Name *</label>
                  <input
                    id="userName"
                    name="userName"
                    type="text"
                    placeholder="Your name in the meeting"
                    value={form.userName}
                    onChange={handleChange}
                    required
                    disabled={status === 'joining'}
                  />
                </div>
                <div className="form-group">
                  <label htmlFor="userEmail">Email (required for webinars)</label>
                  <input
                    id="userEmail"
                    name="userEmail"
                    type="email"
                    placeholder="your@email.com"
                    value={form.userEmail}
                    onChange={handleChange}
                    disabled={status === 'joining'}
                  />
                </div>
              </div>

              <div className="form-row">
                <div className="form-group">
                  <label htmlFor="role">Join as</label>
                  <select
                    id="role"
                    name="role"
                    value={form.role}
                    onChange={handleChange}
                    disabled={status === 'joining'}
                  >
                    <option value={0}>Attendee (role: 0)</option>
                    <option value={1}>Host / Co-host (role: 1)</option>
                  </select>
                </div>
              </div>

              <button
                type="submit"
                className="btn btn-primary"
                disabled={status === 'joining' || !sdkReady}
              >
                {status === 'joining' ? (
                  <>
                    <span className="spinner" />
                    Joining…
                  </>
                ) : (
                  <>
                    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M2 2.5A2.5 2.5 0 014.5 0h8.75a.75.75 0 01.75.75v12.5a.75.75 0 01-.75.75h-2.5a.75.75 0 110-1.5h1.75v-2h-8a1 1 0 00-.714 1.7.75.75 0 01-1.072 1.05A2.495 2.495 0 012 11.5v-9zm10.5-1V9h-8c-.356 0-.694.074-1 .208V2.5a1 1 0 011-1h8zM5 12.25v3.25a.25.25 0 00.4.2l1.45-1.087a.25.25 0 01.3 0L8.6 15.7a.25.25 0 00.4-.2v-3.25a.25.25 0 00-.25-.25h-3.5a.25.25 0 00-.25.25z"/></svg>
                    Join Meeting
                  </>
                )}
              </button>
            </form>

            <div className="info-strip">
              <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M8 1a7 7 0 100 14A7 7 0 008 1zm-.75 4a.75.75 0 011.5 0v3a.75.75 0 01-1.5 0V5zm.75 6a1 1 0 110-2 1 1 0 010 2z"/></svg>
              <span>Signature is generated server-side. Edit <code>.env</code> with your SDK Key &amp; Secret to get started.</span>
            </div>
          </div>
        )}

        {/* Meeting Container */}
        <div className={`meeting-container ${status === 'in-meeting' ? 'visible' : ''}`}>
          {status === 'in-meeting' && (
            <div className="meeting-toolbar">
              <span className="live-indicator">
                <span className="live-dot" />
                Live
              </span>
              <span className="attendee-count" title="Live participant count (from SDK events)">
                👥 {attendeeCount} in meeting
              </span>
              <button className="btn btn-danger btn-sm" onClick={leaveMeeting}>
                Leave Meeting
              </button>
            </div>
          )}
          {/* This div is where Zoom Component View renders */}
          <div
            id="meetingSDKElement"
            ref={meetingSDKElementRef}
            className="meeting-sdk-element"
          />
        </div>
      </main>
    </div>
  )
}
