// /api/hybrid/* and /download handlers.
import { HTTPException } from '../utils/http-exception.js'
import { jsonResponse } from '../utils/respond.js'
import { requireAuth } from '../utils/auth.js'
import { hybridParseSingleVideo } from '../hybrid/crawler.js'
import { rewriteMinimalToProxy } from '../utils/proxy-link.js'

const PLATFORM = 'hybrid'
const truthy = (v) => ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase())

export async function hybridService (route, request, ctx) {
  if (request.method === 'GET' && route === 'video_data') {
    const url = new URL(request.url)
    const target = url.searchParams.get('url')
    if (!target) throw new HTTPException(400, { message: 'Missing query param: url' })
    requireAuth(request, ctx, PLATFORM, 'video_data', target)
    const minimal = truthy(url.searchParams.get('minimal') ?? 'false')
    const refresh = truthy(url.searchParams.get('refresh') ?? 'false')
    // ?proxy=1 rewrites media URLs to cached /proxy self-links (needs
    // minimal=true since the unified schema is what carries the urls).
    const proxy = truthy(url.searchParams.get('proxy') ?? 'false')
    let data = await hybridParseSingleVideo(ctx, target, minimal, refresh)
    if (minimal && proxy) data = rewriteMinimalToProxy(data, request, ctx)
    return jsonResponse(data, { router: 'hybrid/video_data', params: { url: target, minimal, proxy } })
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
