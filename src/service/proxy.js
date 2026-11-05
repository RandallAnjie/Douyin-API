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
import { fetchRawById, mediaCandidates, toMinimal } from '../hybrid/crawler.js'
import { serveFromR2, teeIntoCache, warmUrl, mediaKey, metaKey, getJson } from '../utils/r2cache.js'
import { isWatermarkUrl, downloadFilename, contentDispositionAttachment } from '../utils/media.js'

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
  const extHint = (kind === 'nwm' || kind === 'wm') ? 'mp4' : 'jpeg'

  const filenameFor = async (raw) => {
    if (!download) return null
    return resolveDownloadName(bucket, platform, id, kind, raw, extHint)
  }

  // R2 hit first (cheap, handles Range). minSize bypasses a poisoned
  // (too-small) entry so it self-heals on the next fetch.
  if (bucket && !refresh) {
    const hit = await serveFromR2(bucket, request, key, undefined, minSizeForKind(kind))
    if (hit) return withDisposition(hit, download, await filenameFor(null), extHint)
  }

  const isVideo = kind === 'nwm' || kind === 'wm'
  const contentType = isVideo ? 'video/mp4' : 'image/jpeg'
  const reqHeaders = {
    'User-Agent': platform === 'douyin' ? ctx.config.douyin.userAgent : ctx.config.tiktok.userAgent,
    Referer: REFERER[platform]
  }
  const rangeHeader = request.headers.get('range')

  // Probe candidates until one actually serves media.
  const probe = async (cands) => {
    for (const u of cands) {
      if (kind === 'nwm' && isWatermarkUrl(u)) continue
      let r
      try { r = await fetch(u, { headers: rangeHeader ? { ...reqHeaders, range: rangeHeader } : reqHeaders }) } catch { continue }
      if (looksLikeMedia(r, kind, !!rangeHeader, u)) return { upstream: r, usedUrl: u }
      try { await r.body?.cancel() } catch {}
    }
    return { upstream: null, usedUrl: null }
  }

  // Miss → resolve candidate CDN urls from (cached) metadata and try them
  // in order; douyin returns dead/expired mirrors mixed in.
  let { raw } = await fetchRawById(ctx, platform, id, refresh)
  let candidates = mediaCandidates(platform, raw, kind)
  if (!candidates.length && refresh) throw new HTTPException(404, { message: `No media url for kind=${kind}` })
  let { upstream, usedUrl } = candidates.length ? await probe(candidates) : { upstream: null, usedUrl: null }

  // Signed CDN urls in cached metadata expire. If every cached candidate
  // failed and we hadn't already forced a refresh, re-resolve fresh links
  // once and retry before giving up.
  if (!upstream && !refresh) {
    ;({ raw } = await fetchRawById(ctx, platform, id, true))
    candidates = mediaCandidates(platform, raw, kind)
    if (!candidates.length) throw new HTTPException(404, { message: `No media url for kind=${kind}` })
    ;({ upstream, usedUrl } = await probe(candidates))
  }
  if (!upstream) {
    throw new HTTPException(502, { message: `All ${candidates.length} candidate url(s) failed for kind=${kind}` })
  }

  // A genuine sub-range (seek, e.g. bytes=5000000-) just gets the slice;
  // the cache is filled by full / open-ended passes, after which R2 answers
  // ranges directly. An OPEN-ended range from 0 (bytes=0-, what a <video>
  // sends first) is treated as a full GET so we can tee it into R2 DURING
  // the transfer — reliable, unlike a background warm that outlives the
  // post-response time budget.
  const openFromZero = /^bytes=0-$/.test((rangeHeader || '').trim())
  if (rangeHeader && !openFromZero) {
    // Genuine sub-range (seek). Serve the slice now, and warm the WHOLE
    // file into R2 in the background (deduped) so later reads hit cache.
    if (bucket) warmUrl(ctx, bucket, key, usedUrl, reqHeaders, contentType)
    return withDisposition(wrapMedia(upstream, contentType, 'upstream-range'), download, await filenameFor(raw), extHint)
  }
  if (openFromZero) {
    try { await upstream.body?.cancel() } catch {}
    try { upstream = await fetch(usedUrl, { headers: reqHeaders }) } catch { upstream = null }
    if (!upstream || !looksLikeMedia(upstream, kind, false, usedUrl)) {
      throw new HTTPException(502, { message: `re-fetch failed for kind=${kind}` })
    }
  }

  // Always stream the user branch immediately. Playback (and download)
  // must not wait to buffer the whole upstream body — HTML5 <video>
  // needs first byte + Range to start. R2 populate (retry / multipart)
  // happens only on the teed cache branch.
  const streamed = bucket
    ? teeIntoCache(bucket, ctx, key, upstream, contentType, { minCacheBytes: MIN_CACHE_BYTES })
    : wrapMedia(upstream, contentType, 'upstream-plain')
  return withDisposition(streamed, download, await filenameFor(raw), extHint)
}

// Heuristic: does this response look like real media (vs an expired-link
// error page / JSON / tiny body)? For range hits we skip the size check
// (the body is just a slice).
function looksLikeMedia (resp, kind, isRange, usedUrl) {
  if (!resp.ok || !resp.body) return false
  const ct = (resp.headers.get('content-type') || '').toLowerCase()
  if (ct.includes('text/html') || ct.includes('application/json') || ct.includes('text/xml') || ct.includes('text/plain')) return false
  if (kind === 'nwm' && isWatermarkUrl(resp.url || usedUrl || '')) return false
  if (!isRange) {
    const len = Number(resp.headers.get('content-length') || 0)
    if (len && len < minSizeForKind(kind)) return false
  }
  return true
}

function wrapMedia (upstream, contentType, source) {
  const out = new Headers()
  // Prefer the kind's known type (video/mp4, image/jpeg) so <video>
  // can start progressively. Never forward Content-Encoding — it
  // breaks byte-range scrubbing.
  out.set('content-type', contentType || upstream.headers.get('content-type') || 'application/octet-stream')
  const cl = upstream.headers.get('content-length')
  if (cl) out.set('content-length', cl)
  const cr = upstream.headers.get('content-range')
  if (cr) out.set('content-range', cr)
  out.set('accept-ranges', 'bytes')
  out.set('cache-control', 'public, max-age=300')
  out.set('x-cache-source', source)
  return new Response(upstream.body, { status: upstream.status, headers: out })
}

async function resolveDownloadName (bucket, platform, id, kind, raw, ext) {
  let author = ''
  let desc = ''
  let detail = raw
  if (!detail && bucket) {
    try {
      const cached = await getJson(bucket, metaKey(platform, id), 0)
      detail = cached?.aweme_detail || (platform === 'tiktok' ? cached : null)
    } catch {}
  }
  if (detail) {
    try {
      const min = toMinimal(platform, id, detail)
      author = min.author?.nickname || ''
      desc = min.desc || ''
    } catch {
      author = detail.author?.nickname || ''
      desc = detail.desc || ''
    }
  }
  const e = ext || (kind === 'cover' || String(kind).startsWith('image') ? 'jpeg' : 'mp4')
  return downloadFilename({ author, desc, id, ext: e })
}

function withDisposition (resp, download, filename, ext) {
  if (!download) return resp
  const headers = new Headers(resp.headers)
  const name = filename || `download.${ext || 'mp4'}`
  headers.set('content-disposition', contentDispositionAttachment(name))
  return new Response(resp.body, { status: resp.status, headers })
}
