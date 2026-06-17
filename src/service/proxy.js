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
import { fetchRawById, toMinimal, resolveKindUrl } from '../hybrid/crawler.js'
import { serveFromR2, cachePopulateAside, r2PutRetry, mediaKey } from '../utils/r2cache.js'

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

  // A *known* large body: stream straight through, no caching (avoid
  // relaying tens of MB through memory just to attempt an R2 put).
  const cl = Number(upstream.headers.get('content-length') || 0)
  if (cl > BUFFER_CAP) {
    return withDisposition(wrapMedia(upstream, contentType, 'upstream-plain'), download, platform, id, kind, ext)
  }

  // Cache miss, bufferable body (incl. unknown length — douyin's play
  // CDN often omits content-length). Buffer, serve from memory, and
  // cache in the BACKGROUND (never block the user response on the R2
  // put). Skip caching a suspiciously small body (likely an error).
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
