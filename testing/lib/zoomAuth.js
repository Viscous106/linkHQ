/**
 * Zoom Server-to-Server OAuth token helper (account_credentials grant).
 *
 * Used by the Reports API and recording downloads. Caches the token in-process
 * until shortly before expiry. Docs:
 * https://developers.zoom.us/docs/internal-apps/s2s-oauth/
 */
const TOKEN_URL = 'https://zoom.us/oauth/token'

let cached = { token: null, expiresAt: 0 }

/**
 * @param {object} [env] - override for testing (defaults to process.env)
 * @returns {Promise<string>} a valid access token
 */
export async function getZoomAccessToken(env = process.env) {
  const now = Date.now()
  if (cached.token && now < cached.expiresAt) return cached.token

  const accountId = env.ZOOM_S2S_ACCOUNT_ID
  const clientId = env.ZOOM_S2S_CLIENT_ID
  const clientSecret = env.ZOOM_S2S_CLIENT_SECRET
  if (!accountId || !clientId || !clientSecret) {
    throw new Error('Missing ZOOM_S2S_ACCOUNT_ID/CLIENT_ID/CLIENT_SECRET in env')
  }

  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString('base64')
  const url = `${TOKEN_URL}?grant_type=account_credentials&account_id=${encodeURIComponent(accountId)}`
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Basic ${basic}` },
  })
  if (!res.ok) {
    throw new Error(`Zoom OAuth failed: ${res.status} ${await res.text()}`)
  }
  const json = await res.json()
  cached = {
    token: json.access_token,
    // refresh 60s early
    expiresAt: now + (json.expires_in ?? 3600) * 1000 - 60_000,
  }
  return cached.token
}

/** Test/util: clear the cached token. */
export function _resetZoomTokenCache() {
  cached = { token: null, expiresAt: 0 }
}
