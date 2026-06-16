// /api/tiktok/web/* and /api/tiktok/app/* route handlers.
import { HTTPException } from '../utils/http-exception.js'
import { jsonResponse } from '../utils/respond.js'
import { requireAuth } from '../utils/auth.js'
import * as web from '../tiktok/web/crawler.js'
import { getXBogus } from '../sign/xbogus.js'
import { genRandomStr } from '../utils/tokens.js'
import {
  getTiktokAwemeId, getTiktokUniqueId, extractValidUrl
} from '../utils/ids.js'
import { fetchTiktokAwemeCached } from '../utils/meta-cache.js'

const PLATFORM = 'tiktok'
const q = (request, key, dflt = '') => new URL(request.url).searchParams.get(key) ?? dflt
const requireQ = (request, key) => {
  const v = new URL(request.url).searchParams.get(key)
  if (v === null || v === '') throw new HTTPException(400, { message: `Missing query param: ${key}` })
  return v
}
const fakeMsToken = () => genRandomStr(146) + '=='

// Best-effort TikTok secUid resolver: fetch the (resolved) profile page
// and pull "secUid" from the embedded JSON.
async function resolveTiktokSecUid (rawUrl) {
  const url = extractValidUrl(rawUrl)
  if (!url) throw new HTTPException(400, { message: 'Invalid URL' })
  const resp = await fetch(url, {
    redirect: 'follow',
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36' }
  })
  const html = await resp.text()
  const m = html.match(/"secUid":"([^"]+)"/)
  if (!m) throw new HTTPException(404, { message: 'secUid not found on page' })
  return m[1]
}

// TikTok ttwid via POST to tiktok.com/ttwid/check/.
async function genTiktokTtwid (cookie) {
  try {
    const resp = await fetch('https://www.tiktok.com/ttwid/check/', {
      method: 'POST', body: cookie || '', headers: { 'content-type': 'text/plain' }
    })
    const sc = resp.headers.get('set-cookie') || ''
    const m = sc.match(/ttwid=([^;]+)/)
    return m ? m[1] : ''
  } catch {
    return ''
  }
}

export async function tiktokWebService (route, request, ctx) {
  const method = request.method

  if (method === 'GET' && route === 'fetch_one_video') {
    const itemId = requireQ(request, 'itemId')
    requireAuth(request, ctx, PLATFORM, route, itemId)
    return jsonResponse(await web.fetchOneVideo(ctx, itemId), { router: route })
  }
  if (method === 'GET' && route === 'fetch_user_profile') {
    const secUid = q(request, 'secUid', '')
    const uniqueId = q(request, 'uniqueId', '')
    if (!secUid && !uniqueId) throw new HTTPException(400, { message: 'Provide secUid or uniqueId' })
    requireAuth(request, ctx, PLATFORM, route, secUid || uniqueId)
    return jsonResponse(await web.fetchUserProfile(ctx, secUid, uniqueId), { router: route })
  }
  if (method === 'GET' && route === 'fetch_user_post') {
    const secUid = requireQ(request, 'secUid')
    requireAuth(request, ctx, PLATFORM, route, secUid)
    return jsonResponse(await web.fetchUserPost(ctx, secUid, q(request, 'cursor', '0'), q(request, 'count', '35'), q(request, 'coverFormat', '2')), { router: route })
  }
  if (method === 'GET' && route === 'fetch_user_like') {
    const secUid = requireQ(request, 'secUid')
    requireAuth(request, ctx, PLATFORM, route, secUid)
    return jsonResponse(await web.fetchUserLike(ctx, secUid, q(request, 'cursor', '0'), q(request, 'count', '35'), q(request, 'coverFormat', '2')), { router: route })
  }
  if (method === 'GET' && route === 'fetch_user_mix') {
    const mixId = requireQ(request, 'mixId')
    requireAuth(request, ctx, PLATFORM, route, mixId)
    return jsonResponse(await web.fetchUserMix(ctx, mixId, q(request, 'cursor', '0'), q(request, 'count', '30')), { router: route })
  }
  if (method === 'GET' && route === 'fetch_user_play_list') {
    const secUid = requireQ(request, 'secUid')
    requireAuth(request, ctx, PLATFORM, route, secUid)
    return jsonResponse(await web.fetchUserPlayList(ctx, secUid, q(request, 'cursor', '0'), q(request, 'count', '30')), { router: route })
  }
  if (method === 'GET' && route === 'fetch_post_comment') {
    const awemeId = requireQ(request, 'aweme_id')
    requireAuth(request, ctx, PLATFORM, route, awemeId)
    return jsonResponse(await web.fetchPostComment(ctx, awemeId, q(request, 'cursor', '0'), q(request, 'count', '20'), q(request, 'current_region', '')), { router: route })
  }
  if (method === 'GET' && route === 'fetch_post_comment_reply') {
    const itemId = requireQ(request, 'item_id')
    requireAuth(request, ctx, PLATFORM, route, itemId)
    return jsonResponse(await web.fetchPostCommentReply(ctx, itemId, requireQ(request, 'comment_id'), q(request, 'cursor', '0'), q(request, 'count', '20'), q(request, 'current_region', '')), { router: route })
  }
  if (method === 'GET' && route === 'fetch_user_fans') {
    const secUid = requireQ(request, 'secUid')
    requireAuth(request, ctx, PLATFORM, route, secUid)
    return jsonResponse(await web.fetchUserFans(ctx, secUid, q(request, 'count', '30'), q(request, 'maxCursor', '0'), q(request, 'minCursor', '0')), { router: route })
  }
  if (method === 'GET' && route === 'fetch_user_follow') {
    const secUid = requireQ(request, 'secUid')
    requireAuth(request, ctx, PLATFORM, route, secUid)
    return jsonResponse(await web.fetchUserFollow(ctx, secUid, q(request, 'count', '30'), q(request, 'maxCursor', '0'), q(request, 'minCursor', '0')), { router: route })
  }

  // open utilities
  if (method === 'GET' && route === 'generate_real_msToken') {
    return jsonResponse({ msToken: fakeMsToken() }, { router: route })
  }
  if (method === 'GET' && route === 'generate_ttwid') {
    return jsonResponse({ ttwid: await genTiktokTtwid(q(request, 'cookie', ctx.config.tiktok.cookie)) }, { router: route })
  }
  if (method === 'GET' && route === 'generate_xbogus') {
    const url = requireQ(request, 'url')
    const ua = q(request, 'user_agent', ctx.config.tiktok.userAgent)
    const r = getXBogus(url, ua)
    return jsonResponse({ url: r.params, x_bogus: r.xBogus, user_agent: ua }, { router: route })
  }
  if (method === 'GET' && route === 'get_aweme_id') {
    return jsonResponse(await getTiktokAwemeId(requireQ(request, 'url')), { router: route })
  }
  if (method === 'GET' && route === 'get_unique_id') {
    return jsonResponse(await getTiktokUniqueId(requireQ(request, 'url')), { router: route })
  }
  if (method === 'GET' && route === 'get_sec_user_id') {
    return jsonResponse(await resolveTiktokSecUid(requireQ(request, 'url')), { router: route })
  }
  if (method === 'POST' && route === 'get_all_aweme_id') {
    return jsonResponse(await mapUrls(request, getTiktokAwemeId), { router: route })
  }
  if (method === 'POST' && route === 'get_all_unique_id') {
    return jsonResponse(await mapUrls(request, getTiktokUniqueId), { router: route })
  }
  if (method === 'POST' && route === 'get_all_sec_user_id') {
    return jsonResponse(await mapUrls(request, resolveTiktokSecUid), { router: route })
  }

  throw new HTTPException(404, { message: `Unknown tiktok/web route: ${route}` })
}

export async function tiktokAppService (route, request, ctx) {
  if (request.method === 'GET' && route === 'fetch_one_video') {
    const awemeId = requireQ(request, 'aweme_id')
    requireAuth(request, ctx, PLATFORM, 'app_fetch_one_video', awemeId)
    const refresh = ['1', 'true', 'yes', 'on'].includes(String(q(request, 'refresh')).toLowerCase())
    const { data, cached } = await fetchTiktokAwemeCached(ctx, awemeId, refresh)
    return jsonResponse(data, { router: `app/${route}`, headers: { 'x-cache': cached ? 'hit' : 'miss' } })
  }
  throw new HTTPException(404, { message: `Unknown tiktok/app route: ${route}` })
}

async function mapUrls (request, fn) {
  let body
  try { body = await request.json() } catch { throw new HTTPException(400, { message: 'Body must be a JSON array of urls' }) }
  const urls = Array.isArray(body) ? body : (Array.isArray(body?.url) ? body.url : null)
  if (!urls) throw new HTTPException(400, { message: 'Body must be a JSON array of urls' })
  const valid = urls.map(extractValidUrl).filter(Boolean)
  return Promise.all(valid.map(u => fn(u)))
}
