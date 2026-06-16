// /api/douyin/web/* route handlers. Auth (meting-style) gates every
// data endpoint; the generate_*/get_* utilities are open.
import { HTTPException } from '../utils/http-exception.js'
import { jsonResponse } from '../utils/respond.js'
import { requireAuth } from '../utils/auth.js'
import * as crawler from '../douyin/crawler.js'
import {
  getAwemeId, getSecUserId, getWebcastId, extractValidUrl
} from '../utils/ids.js'
import {
  genRealMsToken, genTtwid, genVerifyFp, genSVWebId
} from '../utils/tokens.js'
import { getXBogus } from '../sign/xbogus.js'
import { getABogus } from '../sign/abogus.js'
import { urlencode } from '../utils/params.js'

const PLATFORM = 'douyin'
const q = (request, key, dflt = '') => new URL(request.url).searchParams.get(key) ?? dflt
const requireQ = (request, key) => {
  const v = new URL(request.url).searchParams.get(key)
  if (v === null || v === '') throw new HTTPException(400, { message: `Missing query param: ${key}` })
  return v
}

export default async function douyinWebService (route, request, ctx) {
  const method = request.method

  // --- data endpoints (auth-gated) ---
  if (method === 'GET' && route === 'fetch_one_video') {
    const awemeId = requireQ(request, 'aweme_id')
    requireAuth(request, ctx, PLATFORM, route, awemeId)
    return jsonResponse(await crawler.fetchOneVideo(ctx, awemeId), { router: route, params: { aweme_id: awemeId } })
  }
  if (method === 'GET' && route === 'fetch_user_post_videos') {
    const secUserId = requireQ(request, 'sec_user_id')
    requireAuth(request, ctx, PLATFORM, route, secUserId)
    const maxCursor = q(request, 'max_cursor', '0')
    const count = q(request, 'count', '20')
    return jsonResponse(await crawler.fetchUserPostVideos(ctx, secUserId, maxCursor, count), { router: route })
  }
  if (method === 'GET' && route === 'fetch_user_like_videos') {
    const secUserId = requireQ(request, 'sec_user_id')
    requireAuth(request, ctx, PLATFORM, route, secUserId)
    const maxCursor = q(request, 'max_cursor', '0')
    const count = q(request, 'counts', q(request, 'count', '20'))
    return jsonResponse(await crawler.fetchUserLikeVideos(ctx, secUserId, maxCursor, count), { router: route })
  }
  if (method === 'GET' && route === 'fetch_user_mix_videos') {
    const mixId = requireQ(request, 'mix_id')
    requireAuth(request, ctx, PLATFORM, route, mixId)
    const cursor = q(request, 'max_cursor', q(request, 'cursor', '0'))
    const count = q(request, 'counts', q(request, 'count', '20'))
    return jsonResponse(await crawler.fetchUserMixVideos(ctx, mixId, cursor, count), { router: route })
  }
  if (method === 'GET' && route === 'handler_user_profile') {
    const secUserId = requireQ(request, 'sec_user_id')
    requireAuth(request, ctx, PLATFORM, route, secUserId)
    return jsonResponse(await crawler.handlerUserProfile(ctx, secUserId), { router: route })
  }
  if (method === 'GET' && route === 'fetch_video_comments') {
    const awemeId = requireQ(request, 'aweme_id')
    requireAuth(request, ctx, PLATFORM, route, awemeId)
    const cursor = q(request, 'cursor', '0')
    const count = q(request, 'count', '20')
    return jsonResponse(await crawler.fetchVideoComments(ctx, awemeId, cursor, count), { router: route })
  }
  if (method === 'GET' && route === 'fetch_video_comment_replies') {
    const itemId = requireQ(request, 'item_id')
    requireAuth(request, ctx, PLATFORM, route, itemId)
    const commentId = requireQ(request, 'comment_id')
    const cursor = q(request, 'cursor', '0')
    const count = q(request, 'count', '20')
    return jsonResponse(await crawler.fetchVideoCommentReplies(ctx, itemId, commentId, cursor, count), { router: route })
  }
  if (method === 'GET' && route === 'fetch_user_live_videos') {
    const webcastId = requireQ(request, 'webcast_id')
    requireAuth(request, ctx, PLATFORM, route, webcastId)
    return jsonResponse(await crawler.fetchUserLiveVideos(ctx, webcastId), { router: route })
  }
  if (method === 'GET' && route === 'fetch_user_live_videos_by_room_id') {
    const roomId = requireQ(request, 'room_id')
    requireAuth(request, ctx, PLATFORM, route, roomId)
    return jsonResponse(await crawler.fetchUserLiveVideosByRoomId(ctx, roomId), { router: route })
  }
  if (method === 'GET' && route === 'fetch_live_gift_ranking') {
    const roomId = requireQ(request, 'room_id')
    requireAuth(request, ctx, PLATFORM, route, roomId)
    const rankType = q(request, 'rank_type', '30')
    return jsonResponse(await crawler.fetchLiveGiftRanking(ctx, roomId, rankType), { router: route })
  }

  // --- token / fingerprint utilities (open) ---
  if (method === 'GET' && route === 'generate_real_msToken') {
    return jsonResponse({ msToken: await genRealMsToken() }, { router: route })
  }
  if (method === 'GET' && route === 'generate_ttwid') {
    return jsonResponse({ ttwid: await genTtwid() }, { router: route })
  }
  if (method === 'GET' && route === 'generate_verify_fp') {
    return jsonResponse({ verify_fp: genVerifyFp() }, { router: route })
  }
  if (method === 'GET' && route === 'generate_s_v_web_id') {
    return jsonResponse({ s_v_web_id: genSVWebId() }, { router: route })
  }
  if (method === 'GET' && route === 'generate_x_bogus') {
    const url = requireQ(request, 'url')
    const ua = q(request, 'user_agent', ctx.config.douyin.userAgent)
    const r = getXBogus(url, ua)
    return jsonResponse({ url: r.params, x_bogus: r.xBogus, user_agent: ua }, { router: route })
  }
  if (method === 'GET' && route === 'generate_a_bogus') {
    const url = requireQ(request, 'url')
    const ua = q(request, 'user_agent', ctx.config.douyin.userAgent)
    const [endpoint, query = ''] = url.split('?')
    const params = {}
    for (const pair of query.split('&')) {
      if (!pair) continue
      const idx = pair.indexOf('=')
      params[pair.slice(0, idx)] = pair.slice(idx + 1)
    }
    params.msToken = ''
    const paramStr = urlencode(params)
    const aBogus = getABogus(paramStr, 'GET')
    return jsonResponse({
      url: `${endpoint}?${paramStr}&a_bogus=${encodeURIComponent(aBogus)}`,
      a_bogus: aBogus,
      user_agent: ua
    }, { router: route })
  }

  // --- id extraction (open) ---
  if (method === 'GET' && route === 'get_aweme_id') {
    return jsonResponse(await getAwemeId(requireQ(request, 'url')), { router: route })
  }
  if (method === 'GET' && route === 'get_sec_user_id') {
    return jsonResponse(await getSecUserId(requireQ(request, 'url')), { router: route })
  }
  if (method === 'GET' && route === 'get_webcast_id') {
    return jsonResponse(await getWebcastId(requireQ(request, 'url')), { router: route })
  }
  if (method === 'POST' && route === 'get_all_aweme_id') {
    return jsonResponse(await mapUrls(request, getAwemeId), { router: route })
  }
  if (method === 'POST' && route === 'get_all_sec_user_id') {
    return jsonResponse(await mapUrls(request, getSecUserId), { router: route })
  }
  if (method === 'POST' && route === 'get_all_webcast_id') {
    return jsonResponse(await mapUrls(request, getWebcastId), { router: route })
  }

  throw new HTTPException(404, { message: `Unknown douyin/web route: ${route}` })
}

async function mapUrls (request, fn) {
  let body
  try { body = await request.json() } catch { throw new HTTPException(400, { message: 'Body must be a JSON array of urls' }) }
  const urls = Array.isArray(body) ? body : (Array.isArray(body?.url) ? body.url : null)
  if (!urls) throw new HTTPException(400, { message: 'Body must be a JSON array of urls' })
  const valid = urls.map(extractValidUrl).filter(Boolean)
  return Promise.all(valid.map(u => fn(u)))
}
