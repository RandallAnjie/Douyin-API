// Build self-referential /proxy links carrying a per-resource HMAC, so
// rewritten media URLs are fetchable without leaking the master token.
import { sign, canonical } from './auth.js'

export function proxyBase (request, ctx) {
  const u = new URL(request.url)
  return `${u.origin}${ctx.config.http.prefix}`
}

export function proxyLink (request, ctx, platform, id, kind) {
  const auth = sign(canonical('proxy', platform, id), ctx.config.auth.token)
  const params = new URLSearchParams({ platform, id: String(id), kind, auth })
  return `${proxyBase(request, ctx)}/proxy?${params.toString()}`
}

// Replace the CDN URLs in a minimal hybrid result with /proxy links.
export function rewriteMinimalToProxy (minimal, request, ctx) {
  const { platform, video_id: id } = minimal
  if (minimal.video_data) {
    const nwm = proxyLink(request, ctx, platform, id, 'nwm')
    const wm = proxyLink(request, ctx, platform, id, 'wm')
    minimal.video_data = {
      ...minimal.video_data,
      nwm_video_url: nwm,
      nwm_video_url_HQ: nwm,
      wm_video_url: wm,
      wm_video_url_HQ: wm
    }
  }
  if (minimal.image_data) {
    minimal.image_data = {
      no_watermark_image_list: minimal.image_data.no_watermark_image_list.map((_, i) => proxyLink(request, ctx, platform, id, `image${i}`)),
      watermark_image_list: minimal.image_data.watermark_image_list.map((_, i) => proxyLink(request, ctx, platform, id, `imagewm${i}`))
    }
  }
  if (minimal.cover_data) {
    minimal.cover_data = { ...minimal.cover_data, cover: proxyLink(request, ctx, platform, id, 'cover') }
  }
  return minimal
}
