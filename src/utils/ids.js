// ID extractors — ports of AwemeIdFetcher / SecUserIdFetcher /
// WebCastIdFetcher (Douyin) and the TikTok equivalents. Short links
// (v.douyin.com, vt.tiktok.com, vm.tiktok.com) are resolved by
// following redirects with fetch and reading the final URL.
import { HTTPException } from './http-exception.js'

const URL_RE = /https?:\/\/\S+/

// Extract the first http(s) URL from arbitrary share text.
export function extractValidUrl (input) {
  if (typeof input !== 'string') return null
  const m = input.match(URL_RE)
  return m ? m[0] : null
}

// Follow redirects and return the final URL. A browser-ish UA avoids
// some interstitials. Returns the original on failure.
async function resolveUrl (url) {
  const resp = await fetch(url, {
    method: 'GET',
    redirect: 'follow',
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'
    }
  })
  return resp.url || url
}

function firstMatch (str, patterns) {
  for (const re of patterns) {
    const m = str.match(re)
    if (m) return m[1]
  }
  return null
}

const AWEME_PATTERNS = [
  /video\/([^/?]+)/,
  /[?&]vid=(\d+)/,
  /note\/([^/?]+)/,
  /modal_id=(\d+)/
]

export async function getAwemeId (rawUrl) {
  const url = extractValidUrl(rawUrl)
  if (!url) throw new HTTPException(400, { message: 'Invalid URL' })
  // Direct match first (no network needed for full /video/<id> links).
  let id = firstMatch(url, AWEME_PATTERNS)
  if (id) return id
  const finalUrl = await resolveUrl(url)
  id = firstMatch(finalUrl, AWEME_PATTERNS)
  if (id) return id
  throw new HTTPException(404, { message: `aweme_id not found in ${finalUrl}` })
}

const SEC_UID_PATTERNS = [
  /user\/([^/?]+)/,
  /sec_uid=([^&]+)/
]

export async function getSecUserId (rawUrl) {
  const url = extractValidUrl(rawUrl)
  if (!url) throw new HTTPException(400, { message: 'Invalid URL' })
  let id = firstMatch(url, SEC_UID_PATTERNS)
  if (id) return id
  const finalUrl = await resolveUrl(url)
  id = firstMatch(finalUrl, SEC_UID_PATTERNS)
  if (id) return id
  throw new HTTPException(404, { message: `sec_user_id not found in ${finalUrl}` })
}

const WEBCAST_PATTERNS = [
  /live\/([^/?]+)/,
  /https?:\/\/live\.douyin\.com\/(\d+)/,
  /reflow\/([^/?]+)/
]

export async function getWebcastId (rawUrl) {
  const url = extractValidUrl(rawUrl)
  if (!url) throw new HTTPException(400, { message: 'Invalid URL' })
  let id = firstMatch(url, WEBCAST_PATTERNS)
  if (id) return id
  const finalUrl = await resolveUrl(url)
  id = firstMatch(finalUrl, WEBCAST_PATTERNS)
  if (id) return id
  throw new HTTPException(404, { message: `webcast_id not found in ${finalUrl}` })
}

// TikTok aweme/item id: .../video/<id> or .../photo/<id>; short links
// vt.tiktok.com / vm.tiktok.com redirect to the full URL.
const TIKTOK_ID_PATTERNS = [
  /\/video\/(\d+)/,
  /\/photo\/(\d+)/,
  /item_id=(\d+)/,
  /modal_id=(\d+)/
]

export async function getTiktokAwemeId (rawUrl) {
  const url = extractValidUrl(rawUrl)
  if (!url) throw new HTTPException(400, { message: 'Invalid URL' })
  let id = firstMatch(url, TIKTOK_ID_PATTERNS)
  if (id) return id
  const finalUrl = await resolveUrl(url)
  id = firstMatch(finalUrl, TIKTOK_ID_PATTERNS)
  if (id) return id
  throw new HTTPException(404, { message: `tiktok aweme_id not found in ${finalUrl}` })
}

// TikTok unique_id (@handle).
const TIKTOK_UNIQUE_PATTERNS = [/@([^/?]+)/]
export async function getTiktokUniqueId (rawUrl) {
  const url = extractValidUrl(rawUrl)
  if (!url) throw new HTTPException(400, { message: 'Invalid URL' })
  let id = firstMatch(url, TIKTOK_UNIQUE_PATTERNS)
  if (id) return id
  const finalUrl = await resolveUrl(url)
  id = firstMatch(finalUrl, TIKTOK_UNIQUE_PATTERNS)
  if (id) return id
  throw new HTTPException(404, { message: `unique_id not found in ${finalUrl}` })
}

// TikTok sec_user_id is fetched from the profile HTML, but the upstream
// also resolves it from short links; we expose handle-based resolution
// and leave secUid passthrough to the caller.
