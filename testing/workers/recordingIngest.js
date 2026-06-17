/**
 * Recording → S3 ingest.
 *
 * On `recording.completed`, download the MP4 (the download URL is 401 without
 * the webhook download_token or an S2S OAuth token) and stream it to S3 via the
 * managed multipart uploader, then record the S3 key on the meeting.
 *
 * Mirrors the official zoom/videosdk-s3-cloud-recordings flow.
 */
import { S3Client } from '@aws-sdk/client-s3'
import { Upload } from '@aws-sdk/lib-storage'
import { Readable } from 'node:stream'
import { getZoomAccessToken } from '../lib/zoomAuth.js'
import { setMeetingRecording } from '../lib/db.js'

/** Pick the speaker-view MP4, else any MP4. */
export function pickMp4(recordingFiles = []) {
  const mp4s = recordingFiles.filter((f) => (f.file_type || '').toUpperCase() === 'MP4')
  if (mp4s.length === 0) return null
  return (
    mp4s.find((f) => f.recording_type === 'shared_screen_with_speaker_view') ?? mp4s[0]
  )
}

let _s3
function s3Client(env = process.env) {
  if (!_s3) _s3 = new S3Client({ region: env.AWS_REGION })
  return _s3
}

/**
 * Job handler. payload: { zoom_uuid, download_token, recording_files }
 * deps injectable for testing: { getToken, fetch, upload, markRecording, env }.
 */
export async function runRecordingIngest(payload, deps = {}) {
  const env = deps.env ?? process.env
  const { zoom_uuid: uuid, download_token: downloadToken, recording_files } = payload
  if (!uuid) throw new Error('recordingIngest: missing zoom_uuid')

  const markRecording = deps.markRecording ?? setMeetingRecording
  const file = pickMp4(recording_files)
  if (!file) {
    markRecording(uuid, null, 'failed')
    throw new Error('recordingIngest: no MP4 in recording_files')
  }

  const doFetch = deps.fetch ?? fetch
  // Prefer the short-lived download_token; fall back to an S2S OAuth token.
  const token = downloadToken ?? (await (deps.getToken ?? getZoomAccessToken)())
  const sep = file.download_url.includes('?') ? '&' : '?'
  const res = await doFetch(`${file.download_url}${sep}access_token=${token}`)
  if (!res.ok || !res.body) {
    throw new Error(`recording download failed: ${res.status}`)
  }

  const key = `recordings/${uuid}.mp4`
  const upload =
    deps.upload ??
    (async (body) => {
      const up = new Upload({
        client: s3Client(env),
        params: {
          Bucket: env.S3_BUCKET,
          Key: key,
          // Web ReadableStream → Node stream for the uploader.
          Body: Readable.fromWeb(res.body),
          ContentType: 'video/mp4',
        },
      })
      await up.done()
    })

  await upload(res.body, key)
  markRecording(uuid, key, 'stored')
  return key
}
