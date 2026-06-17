// Douyin web crawler — port of crawlers/douyin/web/web_crawler.py.
//
// Signature split mirrors the source exactly:
//   a_bogus : fetch_one_video, fetch_user_post_videos, fetch_user_like_videos
//   X-Bogus : everything else (mix / profile / comments / live / gift rank)
//
// a_bogus path uses urlencode(params) (quote_plus) and signs that exact
// string; X-Bogus path uses raw "k=v&k=v" joins (BogusManager).
import { getABogus } from '../sign/abogus.js'
import { getXBogus } from '../sign/xbogus.js'
import {
  baseRequestParams, baseLiveParams, baseLive2Params,
  urlencode, rawJoin
} from '../utils/params.js'
import { fetchGetJson, buildHeaders } from '../utils/base-crawler.js'
import { genFalseMsToken, genVerifyFp, genTtwid } from '../utils/tokens.js'
import { DouyinEndpoints as EP, DOUYIN_REFERER } from './endpoints.js'

async function douyinHeaders (ctx) {
  let cookie = ctx.config.douyin.cookie
  if (!cookie) {
    // No operator cookie bound — bootstrap a minimal ttwid cookie so
    // requests at least carry a device token.
    const ttwid = await genTtwid()
    if (ttwid) cookie = `ttwid=${ttwid}`
  }
  return buildHeaders({
    userAgent: ctx.config.douyin.userAgent,
    referer: DOUYIN_REFERER,
    cookie
  })
}

// --- a_bogus endpoints ---

async function aBogusGet (ctx, baseUrl, params) {
  const paramStr = urlencode(params)
  const aBogus = getABogus(paramStr, 'GET')
  const url = `${baseUrl}?${paramStr}&a_bogus=${encodeURIComponent(aBogus)}`
  return fetchGetJson(url, await douyinHeaders(ctx))
}

export function fetchOneVideo (ctx, awemeId) {
  const params = { ...baseRequestParams(''), aweme_id: awemeId }
  return aBogusGet(ctx, EP.POST_DETAIL, params)
}

// Fallback source: the iesdouyin mobile share page embeds the full aweme
// item in `window._ROUTER_DATA`. When the signed web detail endpoint
// returns no aweme_detail (transient errors, some region/age gates), this
// often still serves it. Returns { aweme_detail, filter_detail } in the
// same shape the detail endpoint uses. 360/VR videos are filtered here
// too (filter_reason 360_vr_*), so this surfaces the real reason.
const SHARE_MOBILE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1'

export async function fetchShareDetail (ctx, awemeId) {
  const url = `https://www.iesdouyin.com/share/video/${awemeId}/`
  let html
  try {
    const resp = await fetch(url, { headers: { 'User-Agent': SHARE_MOBILE_UA, Referer: 'https://www.iesdouyin.com/' } })
    html = await resp.text()
  } catch {
    return { aweme_detail: null }
  }
  const m = html.match(/window\._ROUTER_DATA\s*=\s*(\{.+?\})<\/script>/s)
  if (!m) return { aweme_detail: null }
  let data
  try { data = JSON.parse(m[1]) } catch { return { aweme_detail: null } }
  const page = data.loaderData && data.loaderData['video_(id)/page']
  const res = page && page.videoInfoRes
  return {
    aweme_detail: (res && res.item_list && res.item_list[0]) || null,
    filter_detail: (res && res.filter_list && res.filter_list[0]) || null
  }
}

export function fetchUserPostVideos (ctx, secUserId, maxCursor, count) {
  const params = { ...baseRequestParams(''), max_cursor: String(maxCursor), count: String(count), sec_user_id: secUserId }
  return aBogusGet(ctx, EP.USER_POST, params)
}

export function fetchUserLikeVideos (ctx, secUserId, maxCursor, count) {
  const params = { ...baseRequestParams(''), max_cursor: String(maxCursor), count: String(count), sec_user_id: secUserId }
  return aBogusGet(ctx, EP.USER_FAVORITE_A, params)
}

// --- X-Bogus endpoints ---

async function xBogusGet (ctx, baseUrl, params) {
  const paramStr = rawJoin(params)
  const { xBogus } = getXBogus(paramStr, ctx.config.douyin.userAgent)
  const url = `${baseUrl}?${paramStr}&X-Bogus=${xBogus}`
  return fetchGetJson(url, await douyinHeaders(ctx))
}

export function handlerUserProfile (ctx, secUserId) {
  const params = { ...baseRequestParams(genFalseMsToken()), sec_user_id: secUserId }
  return xBogusGet(ctx, EP.USER_DETAIL, params)
}

export function fetchUserMixVideos (ctx, mixId, cursor, count) {
  const params = { ...baseRequestParams(genFalseMsToken()), cursor: String(cursor), count: String(count), mix_id: mixId }
  return xBogusGet(ctx, EP.MIX_AWEME, params)
}

export function fetchVideoComments (ctx, awemeId, cursor, count) {
  const params = {
    ...baseRequestParams(genFalseMsToken()),
    aweme_id: awemeId, cursor: String(cursor), count: String(count),
    item_type: '0', insert_ids: '', whale_cut_token: '', cut_version: '1', rcFT: ''
  }
  return xBogusGet(ctx, EP.POST_COMMENT, params)
}

export function fetchVideoCommentReplies (ctx, itemId, commentId, cursor, count) {
  const params = {
    ...baseRequestParams(genFalseMsToken()),
    item_id: itemId, comment_id: commentId, cursor: String(cursor), count: String(count), item_type: '0'
  }
  return xBogusGet(ctx, EP.POST_COMMENT_REPLY, params)
}

export function fetchUserLiveVideos (ctx, webcastId) {
  const params = { ...baseLiveParams(), web_rid: webcastId, room_id_str: '' }
  return xBogusGet(ctx, EP.LIVE_INFO, params)
}

export function fetchUserLiveVideosByRoomId (ctx, roomId) {
  const params = { ...baseLive2Params(genVerifyFp(), genFalseMsToken()), room_id: roomId }
  return xBogusGet(ctx, EP.LIVE_INFO_ROOM_ID, params)
}

export function fetchLiveGiftRanking (ctx, roomId, rankType) {
  const params = {
    ...baseRequestParams(genFalseMsToken()),
    webcast_sdk_version: '2450', room_id: String(roomId), rank_type: String(rankType)
  }
  return xBogusGet(ctx, EP.LIVE_GIFT_RANK, params)
}
