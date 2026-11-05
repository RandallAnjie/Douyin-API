// GET|POST /api/share — turn a Douyin/TikTok share sheet blob into a
// same-origin /work link for iOS Shortcuts (and anyone else). Resolving
// platform+id is enough to answer; ingest runs in the background so
// /work is warm when the friend opens it.
import { isAuthorised, getClientIp } from '../utils/auth.js'
import { resolvePlatformId } from '../hybrid/crawler.js'
import { proxyBase, proxyPath } from '../utils/proxy-link.js'
import { rateLimitHit } from '../utils/db.js'
import { ingestWork } from '../utils/ingest.js'
import { maybeFetchComments } from '../utils/comments.js'

const PLATFORM = 'share'
const ROUTE = 'share'
export const SHARE_INGEST_WAIT_MS = 8000
const INPUT_CAP = 64 * 1024
const truthy = (v) => ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase())

// Stop the URL at whitespace, quotes, and CJK punctuation/brackets so
// trailing "。，】" and the "F@a.Bc 05/12" Douyin tail are not eaten.
const URL_RE = /https?:\/\/[^\s<>"'，。、；：！？）】》〉」』【《〈「『（]+/i
const TRAIL_RE = /[.,;:!?…'"')\]}>~]+$/

// Fullwidth ASCII (FF01-FF5E) -> ASCII. Lets https：／／v.douyin.com work.
export function normalizeShareText (input) {
  return String(input ?? '').replace(/[\uFF01-\uFF5E]/g, (ch) =>
    String.fromCharCode(ch.charCodeAt(0) - 0xFEE0)
  ).replace(/[\u200B-\u200D\uFEFF]/g, '')
}

// First http(s) URL in share text. Trailing punctuation stripped.
export function extractShareUrl (input) {
  if (typeof input !== 'string' || !input) return null
  const m = normalizeShareText(input).match(URL_RE)
  if (!m) return null
  const url = m[0].replace(TRAIL_RE, '')
  return url || null
}

export function buildWorkLink (request, ctx, platform, id) {
  return `${proxyBase(request, ctx)}/work?platform=${encodeURIComponent(platform)}&id=${encodeURIComponent(id)}`
}

export function formatShareMessage (title, author, link) {
  const t = String(title || '').trim()
  const a = String(author || '').trim()
  if (t && a) return `${t} - @${a}\n${link}`
  if (t) return `${t}\n${link}`
  return link
}

export async function raceOrTimeout (promise, ms) {
  let timer
  try {
    return await Promise.race([
      Promise.resolve(promise),
      new Promise((resolve) => { timer = setTimeout(() => resolve(undefined), ms) })
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function clip (s) {
  const t = String(s || '')
  return t.length > INPUT_CAP ? t.slice(0, INPUT_CAP) : t
}

export async function readShareInput (request) {
  const url = new URL(request.url)
  const q = (url.searchParams.get('text') || url.searchParams.get('url') || '').trim()
  if (q) return clip(q)
  if (request.method === 'GET' || request.method === 'HEAD') return ''
  const ct = (request.headers.get('content-type') || '').toLowerCase()
  try {
    if (ct.includes('application/x-www-form-urlencoded') || ct.includes('multipart/form-data')) {
      const fd = await request.formData()
      const named = fd.get('text') || fd.get('url')
      if (typeof named === 'string' && named.trim()) return clip(named.trim())
      if (named && typeof named.text === 'function') {
        const t = (await named.text()).trim()
        if (t) return clip(t)
      }
      for (const [, v] of fd.entries()) {
        if (typeof v === 'string' && v.trim()) return clip(v.trim())
      }
      for (const [, v] of fd.entries()) {
        if (v && typeof v.text === 'function') {
          const t = (await v.text()).trim()
          if (t) return clip(t)
        }
      }
      return ''
    }
    return clip((await request.text()).trim())
  } catch {
    return ''
  }
}

function parseFormat (request) {
  const raw = String(new URL(request.url).searchParams.get('format') || 'text').toLowerCase()
  if (raw === 'json' || raw === 'redirect') return raw
  return 'text'
}

function textResponse (status, message) {
  return new Response(String(message || ''), {
    status,
    headers: { 'content-type': 'text/plain; charset=utf-8' }
  })
}

function jsonResponse (status, obj) {
  return new Response(JSON.stringify({ code: status, ...obj }), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' }
  })
}

function errorResponse (format, status, message) {
  if (format === 'json') return jsonResponse(status, { message })
  return textResponse(status, message)
}

async function guestOrAuth (request, ctx, format, primaryId) {
  if (isAuthorised(request, ctx, PLATFORM, ROUTE, primaryId || '')) return { guest: false }
  const g = ctx.config.guest
  if (!g.enabled) {
    return {
      error: errorResponse(format, 401, '未授权：请在链接后加上 ?token=访问钥匙 / Unauthorized: pass ?token=<secret>')
    }
  }
  const rl = await rateLimitHit(ctx, getClientIp(request), g.limit, g.windowSec)
  if (rl.reason === 'no-store') {
    return {
      error: errorResponse(format, 503, '游客模式需要 D1 才能限流，请联系管理员绑定 / guest mode needs a D1 binding')
    }
  }
  if (!rl.allowed) {
    const msg = `游客每 ${Math.round(g.windowSec / 60)} 分钟限 ${g.limit} 次，请 ${rl.resetSec}s 后再试或填入访问钥匙`
    if (format === 'json') {
      return {
        error: new Response(JSON.stringify({ code: 429, message: msg }), {
          status: 429,
          headers: {
            'content-type': 'application/json; charset=utf-8',
            'retry-after': String(rl.resetSec || g.windowSec)
          }
        })
      }
    }
    return {
      error: new Response(msg, {
        status: 429,
        headers: {
          'content-type': 'text/plain; charset=utf-8',
          'retry-after': String(rl.resetSec || g.windowSec)
        }
      })
    }
  }
  return { guest: true }
}

function mediaLinks (ctx, platform, id, guest, min) {
  const ttl = guest ? ctx.config.guest.linkTtlSec : undefined
  const cover = proxyPath(ctx, platform, id, 'cover', ttl)
  if (min?.type === 'image') {
    const download = proxyPath(ctx, platform, id, 'image0', ttl) + '&download=1'
    return { cover, play: null, download }
  }
  const play = proxyPath(ctx, platform, id, 'nwm', ttl)
  return { cover, play, download: `${play}&download=1` }
}

export default async function shareService (request, ctx) {
  const url = new URL(request.url)
  const format = parseFormat(request)
  const textFull = truthy(url.searchParams.get('text_full') ?? '')
  const input = await readShareInput(request)
  const extracted = extractShareUrl(input)
  const hint = url.searchParams.get('text') || url.searchParams.get('url') || extracted || ''

  if (!extracted) {
    return errorResponse(format, 400, '未找到分享链接，请粘贴完整的抖音/TikTok 分享口令')
  }

  const gate = await guestOrAuth(request, ctx, format, hint)
  if (gate.error) return gate.error
  const guest = gate.guest
  // Guests never get raw upstream JSON; the json envelope below is the
  // proxied public shape (same idea as hybrid/video_data + proxy=1).

  let platform, id
  try {
    const resolved = await resolvePlatformId(extracted)
    platform = resolved.platform
    id = resolved.id
  } catch (err) {
    const status = err?.status || 400
    const message = err?.message || '无法解析该链接'
    return errorResponse(format, status, message)
  }

  const link = buildWorkLink(request, ctx, platform, id)
  const ingestP = ingestWork(ctx, request, platform, id, extracted, false)
    .catch((err) => {
      try { console.error('[share] ingest failed', err?.message || err) } catch {}
      return null
    })
  if (ctx.waitUntil) {
    ctx.waitUntil(ingestP.then((r) => (r ? maybeFetchComments(ctx, platform, id) : null)))
  }

  const needMeta = textFull || format === 'json'
  const ingested = needMeta
    ? await raceOrTimeout(ingestP, SHARE_INGEST_WAIT_MS)
    : null
  const min = ingested?.min || null
  const title = (min?.desc || '').trim() || null
  const author = (min?.author?.nickname || '').trim() || null

  if (format === 'redirect') {
    return new Response(null, { status: 302, headers: { location: link } })
  }

  if (format === 'json') {
    const media = mediaLinks(ctx, platform, id, guest, min)
    const body = {
      platform,
      id,
      link,
      title,
      author,
      cover: media.cover,
      play: media.play,
      download: media.download
    }
    if (textFull) body.text = formatShareMessage(title, author, link)
    return jsonResponse(200, body)
  }

  const text = textFull ? formatShareMessage(title, author, link) : link
  return textResponse(200, text)
}
