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
import { requireAuth } from '../utils/auth.js'
import { fetchRawById, toMinimal, resolveKindUrl } from '../hybrid/crawler.js'
import { serveFromR2, teeIntoCache, cachePopulateAside, r2PutRetry, mediaKey } from '../utils/r2cache.js'

// Media at or under this size is buffered so the R2 write can be
// retried from memory (the plane PUT 502s intermittently); larger
// files fall back to a single-shot tee. Douyin/TikTok short clips and
// images sit well under this.
const BUFFER_CAP = 20 * 1024 * 1024
// At or under this, await the R2 write (cheap, guarantees the cache
// lands); above it, write in the background.
const SMALL_MEDIA = 2 * 1024 * 1024

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
  requireAuth(request, ctx, 'proxy', platform, id)

  const refresh = ['1', 'true', 'yes'].includes(String(url.searchParams.get('refresh')).toLowerCase())
  const download = ['1', 'true', 'yes'].includes(String(url.searchParams.get('download')).toLowerCase())
  const bucket = ctx.config.mediaR2
  const key = mediaKey(platform, id, kind)

  // R2 hit first (cheap, handles Range).
  if (bucket && !refresh) {
    const hit = await serveFromR2(bucket, request, key)
    if (hit) return withDisposition(hit, download, platform, id, kind)
  }

  // Miss → resolve the current CDN url from (cached) metadata.
  const { raw } = await fetchRawById(ctx, platform, id, refresh)
  const minimal = toMinimal(platform, id, raw)
  const { url: cdnUrl, contentType, ext } = resolveKindUrl(minimal, kind)
  if (!cdnUrl) throw new HTTPException(404, { message: `No media url for kind=${kind}` })

  const reqHeaders = {
    'User-Agent': platform === 'douyin' ? ctx.config.douyin.userAgent : ctx.config.tiktok.userAgent,
    Referer: REFERER[platform]
  }
  const rangeHeader = request.headers.get('range')

  // Range miss → serve a Range fetch now, populate full body to R2 aside.
  if (rangeHeader && bucket) {
    const resp = await cachePopulateAside(
      bucket, ctx, key,
      () => fetch(cdnUrl, { headers: { ...reqHeaders, range: rangeHeader } }).then(r => wrapMedia(r, contentType, 'upstream-range')),
      () => fetch(cdnUrl, { headers: reqHeaders }),
      contentType
    )
    return withDisposition(resp, download, platform, id, kind, ext)
  }

  // No bucket, or no Range → single upstream fetch.
  const upstream = await fetch(cdnUrl, { headers: rangeHeader ? { ...reqHeaders, range: rangeHeader } : reqHeaders })
  if (!upstream.ok || !upstream.body) {
    throw new HTTPException(502, { message: `Upstream media fetch failed (${upstream.status})` })
  }

  // No cache, or a Range we couldn't aside (no bucket) → plain proxy.
  if (!bucket || rangeHeader) {
    return withDisposition(wrapMedia(upstream, contentType, 'upstream-plain'), download, platform, id, kind, ext)
  }

  // Cache miss, full body. Buffer so the R2 put can retry from memory.
  // Douyin's play CDN often omits content-length, so treat unknown
  // length as bufferable too; only a *known* oversized body tees.
  const cl = Number(upstream.headers.get('content-length') || 0)
  if (cl <= BUFFER_CAP) {
    const buf = await upstream.arrayBuffer()
    const size = buf.byteLength
    const putP = r2PutRetry(bucket, key, () => new Response(buf).body, { httpMetadata: { contentType } })
    // Small media (covers/images/short clips): await so it reliably
    // lands. Larger clips: cache in the background.
    if (size <= SMALL_MEDIA) { try { await putP } catch {} } else if (ctx?.waitUntil) { ctx.waitUntil(putP) }
    const out = new Headers({
      'content-type': contentType,
      'content-length': String(size),
      'accept-ranges': 'bytes',
      'cache-control': 'public, max-age=300',
      'x-cache-source': 'upstream-buffer'
    })
    return withDisposition(new Response(buf, { status: 200, headers: out }), download, platform, id, kind, ext)
  }
  return withDisposition(teeIntoCache(bucket, ctx, key, upstream, contentType), download, platform, id, kind, ext)
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
