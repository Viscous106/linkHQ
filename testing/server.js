import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import { createHmac } from 'crypto'
import { createWebhookRouter } from './routes/webhooks.js'
import { createRecordingsRouter } from './routes/recordings.js'
import { startJobRunner } from './workers/jobRunner.js'

const app = express()
const PORT = process.env.PORT || 4000

app.use(cors({ origin: process.env.CORS_ORIGIN?.split(',') ?? true, credentials: true }))

// Zoom webhooks need the RAW request body for HMAC signature verification, so
// this must be mounted before the global express.json() parser.
app.use(
  '/api/webhooks/zoom',
  express.raw({ type: '*/*' }),
  createWebhookRouter({ secretToken: process.env.ZOOM_WEBHOOK_SECRET_TOKEN || '' }),
)

app.use(express.json())

/**
 * Generate Zoom Meeting SDK JWT Signature
 * Docs: https://developers.zoom.us/docs/meeting-sdk/auth/
 */
function generateSignature(sdkKey, sdkSecret, meetingNumber, role) {
  const iat = Math.round(new Date().getTime() / 1000) - 30
  const exp = iat + 60 * 60 * 2 // 2 hours

  const oHeader = { alg: 'HS256', typ: 'JWT' }

  const oPayload = {
    appKey: sdkKey,   // sdkKey is deprecated since v5, use appKey
    mn: meetingNumber,
    role,
    iat,
    exp,
    tokenExp: exp,
  }

  const base64Header = Buffer.from(JSON.stringify(oHeader)).toString('base64url')
  const base64Payload = Buffer.from(JSON.stringify(oPayload)).toString('base64url')
  const message = `${base64Header}.${base64Payload}`

  const signature = createHmac('sha256', sdkSecret)
    .update(message)
    .digest('base64url')

  return `${message}.${signature}`
}

app.post('/api/signature', (req, res) => {
  const { meetingNumber, role } = req.body

  if (!meetingNumber) {
    return res.status(400).json({ error: 'meetingNumber is required' })
  }

  const sdkKey = process.env.ZOOM_SDK_KEY
  const sdkSecret = process.env.ZOOM_SDK_SECRET

  if (!sdkKey || !sdkSecret) {
    return res.status(500).json({
      error: 'ZOOM_SDK_KEY and ZOOM_SDK_SECRET must be set in .env',
    })
  }

  try {
    const signature = generateSignature(sdkKey, sdkSecret, meetingNumber, role ?? 0)
    res.json({ signature, sdkKey })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

app.use('/api/recordings', createRecordingsRouter())

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', sdkKeySet: !!process.env.ZOOM_SDK_KEY })
})

app.listen(PORT, () => {
  // Start the background job worker (reconcile + recording ingest).
  startJobRunner({ intervalMs: 30_000 })

  console.log(`\n✅ Zoom backend running at http://localhost:${PORT}`)
  console.log(`   SDK Key configured:      ${!!process.env.ZOOM_SDK_KEY}`)
  console.log(`   Webhook secret set:      ${!!process.env.ZOOM_WEBHOOK_SECRET_TOKEN}`)
  console.log(`   S2S OAuth configured:    ${!!process.env.ZOOM_S2S_CLIENT_ID}`)
  console.log(`   POST /api/signature      →  { meetingNumber, role }`)
  console.log(`   POST /api/webhooks/zoom  →  Zoom event subscriptions`)
  console.log(`   GET  /health\n`)
})
