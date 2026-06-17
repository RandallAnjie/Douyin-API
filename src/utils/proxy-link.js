// Build self-referential /proxy links carrying a per-resource HMAC, so
// rewritten media URLs are fetchable without leaking the master token.
import { sign, canonical } from './auth.js'

export function proxyBase (request, ctx) {
  const u = new URL(request.url)
  // The edge terminates TLS and forwards plain HTTP to workerd, so
  // request.url is http://. Use the forwarded proto (or default https)
  // and the forwarded host so rewritten links point at the public URL.
  const proto = request.headers.get('x-forwarded-proto') || 'https'
  const host = request.headers.get('x-forwarded-host') || u.host
  return `${proto}://${host}${ctx.config.http.prefix}`
}

// Build a /proxy link. When expSec is given the link is TEMPORARY: an
// exp=<unix-sec> is appended and the HMAC covers it, so guests get a
// link that stops working after the TTL and can't be tampered with.
export function proxyLink (request, ctx, platform, id, kind, expSec) {
  const secret = ctx.config.auth.token
  const params = new URLSearchParams({ platform, id: String(id), kind })
  if (expSec) {
    const exp = Math.floor(Date.now() / 1000) + expSec
    params.set('exp', String(exp))
    params.set('auth', sign(`${canonical('proxy', platform, id)}${exp}`, secret))
  } else {
    params.set('auth', sign(canonical('proxy', platform, id), secret))
  }
  return `${proxyBase(request, ctx)}/proxy?${params.toString()}`
}

// Replace the CDN URLs in a minimal hybrid result with /proxy links.
// expSec (optional) makes them temporary — used for guests.
export function rewriteMinimalToProxy (minimal, request, ctx, expSec) {
  const { platform, video_id: id } = minimal
  const L = (kind) => proxyLink(request, ctx, platform, id, kind, expSec)
  if (minimal.video_data) {
    const nwm = L('nwm')
    const wm = L('wm')
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
      no_watermark_image_list: minimal.image_data.no_watermark_image_list.map((_, i) => L(`image${i}`)),
      watermark_image_list: minimal.image_data.watermark_image_list.map((_, i) => L(`imagewm${i}`))
    }
  }
  if (minimal.cover_data) {
    minimal.cover_data = { ...minimal.cover_data, cover: L('cover') }
  }
  return minimal
}
