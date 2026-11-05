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

// Build a cached /img link for an arbitrary external image URL (comment
// avatars etc. that aren't tied to a parsed work's id/kind). The HMAC
// over "img{url}" means only links we mint are fetchable — not an open
// image proxy.
export function imgProxyLink (request, ctx, srcUrl) {
  if (!srcUrl) return null
  const params = new URLSearchParams({ u: srcUrl, auth: sign(`img${srcUrl}`, ctx.config.auth.token) })
  return `${proxyBase(request, ctx)}/img?${params.toString()}`
}

// Query string for a /proxy link (HMAC over proxy{platform}{id}, or
// proxy{platform}{id}{exp} when temporary). Never the master token.
export function proxyQuery (ctx, platform, id, kind, expSec) {
  const secret = ctx.config.auth.token
  const params = new URLSearchParams({ platform, id: String(id), kind })
  if (expSec) {
    const exp = Math.floor(Date.now() / 1000) + expSec
    params.set('exp', String(exp))
    params.set('auth', sign(`${canonical('proxy', platform, id)}${exp}`, secret))
  } else {
    params.set('auth', sign(canonical('proxy', platform, id), secret))
  }
  return params.toString()
}

// Path-only /proxy link (same-origin). Public boards put this on `play`
// so <video> can start without waiting on a parse.
export function proxyPath (ctx, platform, id, kind, expSec) {
  return `${ctx.config.http.prefix}/proxy?${proxyQuery(ctx, platform, id, kind, expSec)}`
}

// Build an absolute /proxy link. When expSec is given the link is
// TEMPORARY: an exp=<unix-sec> is appended and the HMAC covers it.
export function proxyLink (request, ctx, platform, id, kind, expSec) {
  return `${proxyBase(request, ctx)}/proxy?${proxyQuery(ctx, platform, id, kind, expSec)}`
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
