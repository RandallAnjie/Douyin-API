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
  urlencode, rawJoin, sessionFromCookie
} from '../utils/params.js'
import { fetchGetJson, buildHeaders, redactUpstreamUrl } from '../utils/base-crawler.js'
import { genFalseMsToken, genRealMsToken, genVerifyFp, genTtwid } from '../utils/tokens.js'
import { DouyinEndpoints as EP, DOUYIN_REFERER } from './endpoints.js'

function cookieOf (ctx) {
  return ctx?.config?.douyin?.cookie || ''
}

// Real msToken from mssdk, cached per isolate so we don't hit the
// report endpoint on every comment/profile call. Falls back to the
// local fake token (same as genFalseMsToken) on any failure.
let cachedRealMs = { value: '', at: 0 }
let inflightRealMs = null
const REAL_MS_TTL_MS = 10 * 60 * 1000

async function realMsTokenCached () {
  const now = Date.now()
  if (cachedRealMs.value && (now - cachedRealMs.at) < REAL_MS_TTL_MS) return cachedRealMs.value
  if (!inflightRealMs) {
    inflightRealMs = genRealMsToken()
      .then((v) => {
        cachedRealMs = { value: v, at: Date.now() }
        return v
      })
      .finally(() => { inflightRealMs = null })
  }
  return inflightRealMs
}

// Cookie jar has UIFID but often no msToken / s_v_web_id. Prefer the
// cookie msToken; otherwise ask mssdk (fake token on failure). Never
// invent a verifyFp — a generated fp next to a real UIFID is Argus
// "Signature Not Found".
export async function resolveMsToken (ctx) {
  const session = sessionFromCookie(cookieOf(ctx))
  if (session.msToken) return session.msToken
  return realMsTokenCached()
}

// Shared BaseRequestModel fill for every www.douyin.com web call:
// uifid from the cookie (UIFID / UIFID_TEMP / uifid), msToken from the
// cookie or genRealMsToken (fake fallback), verifyFp/fp only when
// s_v_web_id is present. Extra keys are appended (pydantic subclass
// field order).
export async function buildDouyinWebParams (ctx, extra = {}) {
  const session = sessionFromCookie(cookieOf(ctx))
  const msToken = session.msToken || await resolveMsToken(ctx)
  return {
    ...baseRequestParams(msToken, { uifid: session.uifid, verifyFp: session.verifyFp, webid: session.webid }),
    ...extra
  }
}

async function douyinHeaders (ctx, msToken) {
  let cookie = cookieOf(ctx)
  if (!cookie) {
    // No operator cookie bound — bootstrap a minimal ttwid cookie so
    // requests at least carry a device token.
    const ttwid = await genTtwid()
    if (ttwid) cookie = `ttwid=${ttwid}`
  }
  const session = sessionFromCookie(cookie)
  // Keep Cookie and query msToken in sync when we had to mint one.
  if (msToken && !session.msToken) {
    cookie = cookie ? `${cookie}; msToken=${msToken}` : `msToken=${msToken}`
  }
  const extra = {
    // MediaCrawler: Argus currently accepts a placeholder x-tt-argus;
    // missing it can surface as Signature Not Found after uifid is set.
    'x-tt-argus': '1'
  }
  // Browser XHRs send uifid as both a query param and a request header.
  if (session.uifid) extra.uifid = session.uifid
  return buildHeaders({
    userAgent: ctx.config.douyin.userAgent,
    referer: DOUYIN_REFERER,
    cookie,
    extra
  })
}

// --- a_bogus endpoints ---

// Assemble the signed URL. Exported so tests can assert the string
// a_bogus signs is byte-identical to the query that goes on the wire.
export function signedABogusUrl (baseUrl, params) {
  const paramStr = urlencode(params)
  const aBogus = getABogus(paramStr, 'GET')
  return {
    paramStr,
    aBogus,
    url: `${baseUrl}?${paramStr}&a_bogus=${encodeURIComponent(aBogus)}`
  }
}

async function aBogusGet (ctx, baseUrl, params) {
  const { url } = signedABogusUrl(baseUrl, params)
  return fetchGetJson(url, await douyinHeaders(ctx, params.msToken))
}

function signedFailReason (data, err) {
  if (err?.message) return redactUpstreamUrl(err.message)
  if (!data) return 'signed endpoint returned nothing'
  const code = data.status_code
  const msg = data.status_msg || data.filter_detail?.filter_reason || ''
  return redactUpstreamUrl(
    `signed endpoint status_code=${code == null ? 'n/a' : code}` +
    (msg ? ` ${msg}` : '') +
    ' (no aweme_detail)'
  )
}

export async function fetchOneVideo (ctx, awemeId) {
  const params = await buildDouyinWebParams(ctx, { aweme_id: awemeId })
  let data = null
  let primaryErr = null
  try {
    data = await aBogusGet(ctx, EP.POST_DETAIL, params)
  } catch (err) {
    primaryErr = err
  }
  if (data && data.aweme_detail) return { ...data, source: 'signed' }
  // Signed web detail 403s (Argus Uifid / signature) or returns empty
  // aweme_detail — the iesdouyin share page often still embeds the item.
  const signedError = signedFailReason(data, primaryErr)
  try { console.error('[douyin] signed detail failed, trying share fallback', signedError) } catch {}
  const share = await fetchShareDetail(ctx, awemeId)
  if (share.aweme_detail) {
    return {
      ...data,
      aweme_detail: share.aweme_detail,
      filter_detail: share.filter_detail || data?.filter_detail || null,
      source: 'share',
      signed_error: signedError
    }
  }
  if (share.filter_detail && !data?.filter_detail) {
    return {
      ...data,
      aweme_detail: data?.aweme_detail || null,
      filter_detail: share.filter_detail,
      source: 'share',
      signed_error: signedError
    }
  }
  if (primaryErr) throw primaryErr
  return { ...data, source: 'share', signed_error: signedError }
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
  const headers = {
    'User-Agent': SHARE_MOBILE_UA,
    Referer: 'https://www.iesdouyin.com/'
  }
  const cookie = cookieOf(ctx)
  if (cookie) headers.Cookie = cookie
  let html
  try {
    const resp = await fetch(url, { headers })
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

export async function fetchUserPostVideos (ctx, secUserId, maxCursor, count) {
  const params = await buildDouyinWebParams(ctx, {
    max_cursor: String(maxCursor), count: String(count), sec_user_id: secUserId
  })
  return aBogusGet(ctx, EP.USER_POST, params)
}

export async function fetchUserLikeVideos (ctx, secUserId, maxCursor, count) {
  const params = await buildDouyinWebParams(ctx, {
    max_cursor: String(maxCursor), count: String(count), sec_user_id: secUserId
  })
  return aBogusGet(ctx, EP.USER_FAVORITE_A, params)
}

// General keyword search (a_bogus). Returns data.data[] of mixed cards;
// video cards carry aweme_info.aweme_id. Used by cron to turn hot-search
// KEYWORDS into actual videos. Needs the operator cookie; risk-control may
// reject it (caught by the caller).
export async function fetchGeneralSearch (ctx, keyword, offset = 0, count = 10) {
  const params = await buildDouyinWebParams(ctx, {
    search_channel: 'aweme_general',
    enable_history: '1',
    keyword,
    search_source: 'normal_search',
    query_correct_type: '1',
    is_filter_search: '0',
    from_group_id: '',
    offset: String(offset),
    count: String(count),
    need_filter_settings: '1',
    list_type: 'multi'
  })
  return aBogusGet(ctx, EP.GENERAL_SEARCH, params)
}

// --- X-Bogus endpoints ---

// Hot-search board (trending KEYWORDS, not videos). X-Bogus.
export async function fetchHotSearchList (ctx) {
  const params = await buildDouyinWebParams(ctx, { detail_list: '1' })
  return xBogusGet(ctx, EP.HOT_SEARCH, params)
}

async function xBogusGet (ctx, baseUrl, params) {
  const paramStr = rawJoin(params)
  const { xBogus } = getXBogus(paramStr, ctx.config.douyin.userAgent)
  const url = `${baseUrl}?${paramStr}&X-Bogus=${xBogus}`
  return fetchGetJson(url, await douyinHeaders(ctx, params.msToken))
}

export async function handlerUserProfile (ctx, secUserId) {
  const params = await buildDouyinWebParams(ctx, { sec_user_id: secUserId })
  return xBogusGet(ctx, EP.USER_DETAIL, params)
}

export async function fetchUserMixVideos (ctx, mixId, cursor, count) {
  const params = await buildDouyinWebParams(ctx, {
    cursor: String(cursor), count: String(count), mix_id: mixId
  })
  return xBogusGet(ctx, EP.MIX_AWEME, params)
}

export async function fetchVideoComments (ctx, awemeId, cursor, count) {
  const params = await buildDouyinWebParams(ctx, {
    aweme_id: awemeId, cursor: String(cursor), count: String(count),
    item_type: '0', insert_ids: '', whale_cut_token: '', cut_version: '1', rcFT: ''
  })
  return xBogusGet(ctx, EP.POST_COMMENT, params)
}

export async function fetchVideoCommentReplies (ctx, itemId, commentId, cursor, count) {
  const params = await buildDouyinWebParams(ctx, {
    item_id: itemId, comment_id: commentId, cursor: String(cursor),
    count: String(count), item_type: '0'
  })
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

export async function fetchLiveGiftRanking (ctx, roomId, rankType) {
  const params = await buildDouyinWebParams(ctx, {
    webcast_sdk_version: '2450', room_id: String(roomId), rank_type: String(rankType)
  })
  return xBogusGet(ctx, EP.LIVE_GIFT_RANK, params)
}
