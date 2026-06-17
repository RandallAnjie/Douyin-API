// /api/hybrid/* and /download handlers.
import { HTTPException } from '../utils/http-exception.js'
import { jsonResponse } from '../utils/respond.js'
import { isAuthorised, getClientIp } from '../utils/auth.js'
import { hybridParseSingleVideo, resolvePlatformId, fetchRawById, toMinimal } from '../hybrid/crawler.js'
import { rewriteMinimalToProxy, proxyLink } from '../utils/proxy-link.js'
import { logQuery, rateLimitHit } from '../utils/db.js'
import { maybeFetchComments } from '../utils/comments.js'

const PLATFORM = 'hybrid'
const truthy = (v) => ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase())

export async function hybridService (route, request, ctx) {
  if (request.method === 'GET' && route === 'video_data') {
    const url = new URL(request.url)
    const target = url.searchParams.get('url')
    if (!target) throw new HTTPException(400, { message: 'Missing query param: url' })

    const authed = isAuthorised(request, ctx, PLATFORM, 'video_data', target)
    let guest = false
    if (!authed) {
      // Guest: allowed to parse, but rate-limited and restricted to
      // minimal + temporary proxied links (never raw JSON).
      const g = ctx.config.guest
      if (!g.enabled) {
        throw new HTTPException(401, { message: 'Unauthorized: pass ?token=<secret>' })
      }
      const rl = await rateLimitHit(ctx, getClientIp(request), g.limit, g.windowSec)
      if (rl.reason === 'no-store') {
        throw new HTTPException(503, { message: '游客模式需要 D1 才能限流，请联系管理员绑定 / guest mode needs a D1 binding' })
      }
      if (!rl.allowed) {
        return new Response(JSON.stringify({ code: 429, message: `游客每 ${Math.round(g.windowSec / 60)} 分钟限 ${g.limit} 次，请 ${rl.resetSec}s 后再试或填入访问钥匙` }), {
          status: 429,
          headers: { 'content-type': 'application/json; charset=utf-8', 'retry-after': String(rl.resetSec || g.windowSec) }
        })
      }
      guest = true
    }

    // Guests are forced to minimal + proxy, no refresh; authed callers
    // honour the query params.
    const minimal = guest ? true : truthy(url.searchParams.get('minimal') ?? 'false')
    const proxy = guest ? true : truthy(url.searchParams.get('proxy') ?? 'false')
    const refresh = guest ? false : truthy(url.searchParams.get('refresh') ?? 'false')
    const linkTtl = guest ? ctx.config.guest.linkTtlSec : undefined

    const { platform, id } = await resolvePlatformId(target)
    const { raw } = await fetchRawById(ctx, platform, id, refresh)
    const min = toMinimal(platform, id, raw)

    // Log to the D1 query history (best-effort). Store permanent proxied
    // cover/play links so /admin can render them directly.
    const a = min.author || {}
    const s = min.statistics || {}
    await logQuery(ctx, {
      platform,
      video_id: id,
      type: min.type,
      author: a.nickname || null,
      authorInfo: (a.sec_uid || a.uid)
        ? {
            id: a.sec_uid || String(a.uid),
            name: a.nickname || null,
            avatar: proxyLink(request, ctx, platform, id, 'avatar'),
            extra: { follower: a.follower_count, signature: a.signature, uid: a.uid, sec_uid: a.sec_uid }
          }
        : null,
      create_time: min.create_time || null,
      stats: {
        play: s.play_count, digg: s.digg_count, comment: s.comment_count,
        share: s.share_count, collect: s.collect_count
      },
      tags: Array.isArray(raw.text_extra)
        ? raw.text_extra.map(t => t.hashtag_name).filter(Boolean)
        : null,
      music: raw.music ? { id: raw.music.id, title: raw.music.title, author: raw.music.author } : null,
      description: min.desc || null,
      original_url: target,
      cover: proxyLink(request, ctx, platform, id, 'cover'),
      play: min.type === 'video' ? proxyLink(request, ctx, platform, id, 'nwm') : null,
      duration: raw.duration ? Math.round(raw.duration / 1000) : null,
      extra: {
        stats: min.statistics || null,
        // For image posts, store the cached proxy image links so the
        // discover lightbox can show them with zero extra requests.
        images: min.type === 'image' && min.image_data
          ? min.image_data.no_watermark_image_list.map((_, i) => proxyLink(request, ctx, platform, id, `image${i}`))
          : undefined
      }
    })

    // Async: refresh this work's comments into D1 (best-effort, 6h TTL).
    if (ctx.waitUntil) ctx.waitUntil(maybeFetchComments(ctx, platform, id))

    let data = minimal ? min : raw
    if (minimal && proxy) data = rewriteMinimalToProxy(data, request, ctx, linkTtl)
    return jsonResponse(data, { router: 'hybrid/video_data', params: { url: target, minimal, proxy, guest } })
  }

  if (request.method === 'POST' && route === 'update_cookie') {
    // Workers are stateless; cookies come from env bindings
    // (DOUYIN_COOKIE / TIKTOK_COOKIE), updated by the operator.
    throw new HTTPException(501, {
      message: 'update_cookie is not supported in the worker — set DOUYIN_COOKIE / TIKTOK_COOKIE env bindings instead.'
    })
  }

  throw new HTTPException(404, { message: `Unknown hybrid route: ${route}` })
}

export async function downloadService (request, ctx) {
  const url = new URL(request.url)
  const target = url.searchParams.get('url')
  if (!target) throw new HTTPException(400, { message: 'Missing query param: url' })
  requireAuth(request, ctx, PLATFORM, 'download', target)
  const withWatermark = truthy(url.searchParams.get('with_watermark') ?? 'false')

  const data = await hybridParseSingleVideo(ctx, target, true)

  let fileUrl, ext
  if (data.type === 'video') {
    fileUrl = withWatermark
      ? (data.video_data.wm_video_url_HQ || data.video_data.wm_video_url)
      : (data.video_data.nwm_video_url_HQ || data.video_data.nwm_video_url)
    ext = 'mp4'
  } else {
    const list = withWatermark ? data.image_data.watermark_image_list : data.image_data.no_watermark_image_list
    fileUrl = list[0]
    ext = 'jpeg'
  }
  if (!fileUrl) throw new HTTPException(404, { message: 'No downloadable URL found' })

  const upstream = await fetch(fileUrl, {
    headers: {
      'User-Agent': ctx.config.douyin.userAgent,
      Referer: data.platform === 'douyin' ? 'https://www.douyin.com/' : 'https://www.tiktok.com/'
    }
  })
  if (!upstream.ok || !upstream.body) {
    throw new HTTPException(502, { message: `Failed to fetch media (${upstream.status})` })
  }

  const filename = `${data.platform}_${data.video_id}.${ext}`
  const headers = new Headers()
  headers.set('content-type', upstream.headers.get('content-type') || (ext === 'mp4' ? 'video/mp4' : 'image/jpeg'))
  const len = upstream.headers.get('content-length')
  if (len) headers.set('content-length', len)
  headers.set('content-disposition', `attachment; filename="${filename}"`)
  return new Response(upstream.body, { status: 200, headers })
}
