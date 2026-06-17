// /proxy — id-based media reverse proxy with R2 byte cache.
//
//   GET /proxy?platform=douyin&id=<aweme_id>&kind=nwm[&download=1][&refresh=1]
//
// Cache key is platform/id/kind (stable), so the signed CDN URL can
// rotate without breaking cache hits. On miss we re-resolve the URL
// from the (cached) metadata, fetch it with the right Referer/UA,
// stream to the client and populate R2. Range is supported for video
// scrubbing.
import { HTTPException } from '../utils/http-exception.js'
import { requireProxyAuth } from '../utils/auth.js'
import { fetchRawById, mediaCandidates } from '../hybrid/crawler.js'
import { serveFromR2, r2PutRetry, mediaKey } from '../utils/r2cache.js'

// Media at or under this is buffered so the R2 write can retry from
// memory (the plane PUT 502s intermittently). A *known* larger body is
// streamed straight through without caching (don't relay+buffer 80 MB).
const BUFFER_CAP = 20 * 1024 * 1024
// Don't cache a body smaller than this — it's almost certainly an
// upstream error page, not real media (guards against poisoning the
// cache with e.g. a 16-byte body served forever after).
const MIN_CACHE_BYTES = 1024

// Minimum plausible size per kind, used to bypass a poisoned cache hit.
const minSizeForKind = (kind) => (kind === 'nwm' || kind === 'wm' ? 10000 : 256)

const REFERER = { douyin: 'https://www.douyin.com/', tiktok: 'https://www.tiktok.com/' }

export async function proxyService (request, ctx) {
  const url = new URL(request.url)
  const platform = url.searchParams.get('platform') || ''
  const id = url.searchParams.get('id') || url.searchParams.get('aweme_id') || ''
  const kind = url.searchParams.get('kind') || 'nwm'
  if (!['douyin', 'tiktok'].includes(platform)) {
    throw new HTTPException(400, { message: 'platform must be douyin or tiktok' })
  }
  if (!id) throw new HTTPException(400, { message: 'Missing query param: id' })
  requireProxyAuth(request, ctx, platform, id)

  const refresh = ['1', 'true', 'yes'].includes(String(url.searchParams.get('refresh')).toLowerCase())
  const download = ['1', 'true', 'yes'].includes(String(url.searchParams.get('download')).toLowerCase())
  const bucket = ctx.config.mediaR2
  const key = mediaKey(platform, id, kind)

  // R2 hit first (cheap, handles Range). minSize bypasses a poisoned
  // (too-small) entry so it self-heals on the next fetch.
  if (bucket && !refresh) {
    const hit = await serveFromR2(bucket, request, key, undefined, minSizeForKind(kind))
    if (hit) return withDisposition(hit, download, platform, id, kind)
  }

  // Miss → resolve candidate CDN urls from (cached) metadata and try
  // them in order; douyin returns dead/expired mirrors mixed in.
  const { raw } = await fetchRawById(ctx, platform, id, refresh)
  const candidates = mediaCandidates(platform, raw, kind)
  if (!candidates.length) throw new HTTPException(404, { message: `No media url for kind=${kind}` })

  const isVideo = kind === 'nwm' || kind === 'wm'
  const contentType = isVideo ? 'video/mp4' : 'image/jpeg'
  const ext = isVideo ? 'mp4' : 'jpeg'
  const reqHeaders = {
    'User-Agent': platform === 'douyin' ? ctx.config.douyin.userAgent : ctx.config.tiktok.userAgent,
    Referer: REFERER[platform]
  }
  const rangeHeader = request.headers.get('range')

  // Probe candidates until one actually serves media.
  let upstream = null
  let usedUrl = null
  for (const u of candidates) {
    let r
    try { r = await fetch(u, { headers: rangeHeader ? { ...reqHeaders, range: rangeHeader } : reqHeaders }) } catch { continue }
    if (looksLikeMedia(r, kind, !!rangeHeader)) { upstream = r; usedUrl = u; break }
    try { await r.body?.cancel() } catch {}
  }
  if (!upstream) {
    throw new HTTPException(502, { message: `All ${candidates.length} candidate url(s) failed for kind=${kind}` })
  }

  // Range request → serve the working slice; cache the full body of the
  // SAME working url in the background.
  if (rangeHeader) {
    if (bucket && ctx?.waitUntil) {
      ctx.waitUntil(r2PutRetry(bucket, key, async () => {
        const f = await fetch(usedUrl, { headers: reqHeaders })
        if (!f.ok || !f.body) throw new Error('aside fetch not ok')
        return f.body
      }, { httpMetadata: { contentType } }, 2))
    }
    return withDisposition(wrapMedia(upstream, contentType, 'upstream-range'), download, platform, id, kind, ext)
  }

  // No cache bound, or a *known* large body → stream straight through.
  const cl = Number(upstream.headers.get('content-length') || 0)
  if (!bucket || cl > BUFFER_CAP) {
    return withDisposition(wrapMedia(upstream, contentType, 'upstream-plain'), download, platform, id, kind, ext)
  }

  // Bufferable (incl. unknown length — douyin's play CDN often omits
  // content-length). Buffer, serve from memory, cache in the BACKGROUND
  // (never block the response). Skip caching a too-small (error) body.
  const buf = await upstream.arrayBuffer()
  const size = buf.byteLength
  if (size >= MIN_CACHE_BYTES && ctx?.waitUntil) {
    ctx.waitUntil(r2PutRetry(bucket, key, () => new Response(buf).body, { httpMetadata: { contentType } }, 2))
  }
  const out = new Headers({
    'content-type': contentType,
    'content-length': String(size),
    'accept-ranges': 'bytes',
    'cache-control': 'public, max-age=300',
    'x-cache-source': 'upstream-buffer'
  })
  return withDisposition(new Response(buf, { status: 200, headers: out }), download, platform, id, kind, ext)
}

// Heuristic: does this response look like real media (vs an expired-link
// error page / JSON / tiny body)? For range hits we skip the size check
// (the body is just a slice).
function looksLikeMedia (resp, kind, isRange) {
  if (!resp.ok || !resp.body) return false
  const ct = (resp.headers.get('content-type') || '').toLowerCase()
  if (ct.includes('text/html') || ct.includes('application/json') || ct.includes('text/xml') || ct.includes('text/plain')) return false
  if (!isRange) {
    const len = Number(resp.headers.get('content-length') || 0)
    if (len && len < minSizeForKind(kind)) return false
  }
  return true
}

function wrapMedia (upstream, contentType, source) {
  const out = new Headers()
  out.set('content-type', upstream.headers.get('content-type') || contentType || 'application/octet-stream')
  const cl = upstream.headers.get('content-length'); if (cl) out.set('content-length', cl)
  const cr = upstream.headers.get('content-range'); if (cr) out.set('content-range', cr)
  out.set('accept-ranges', upstream.headers.get('accept-ranges') || 'bytes')
  out.set('cache-control', 'public, max-age=300')
  out.set('x-cache-source', source)
  return new Response(upstream.body, { status: upstream.status, headers: out })
}

function withDisposition (resp, download, platform, id, kind, ext) {
  if (!download) return resp
  const headers = new Headers(resp.headers)
  const e = ext || (kind === 'cover' || kind.startsWith('image') ? 'jpeg' : 'mp4')
  headers.set('content-disposition', `attachment; filename="${platform}_${id}_${kind}.${e}"`)
  return new Response(resp.body, { status: resp.status, headers })
}
