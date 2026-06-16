// TikTok web crawler — port of crawlers/tiktok/web/web_crawler.py.
// All endpoints sign with X-Bogus via the raw "k=v&k=v" join
// (BogusManager.model_2_endpoint). msToken is the fake 146-char token
// (the upstream's real-token path falls back to this on failure).
import { getXBogus } from '../../sign/xbogus.js'
import { rawJoin } from '../../utils/params.js'
import { fetchGetJson, buildHeaders } from '../../utils/base-crawler.js'
import { genRandomStr } from '../../utils/tokens.js'
import { TikTokWebEndpoints as EP, TIKTOK_WEB_REFERER } from './endpoints.js'

const fakeMsToken = () => genRandomStr(146) + '=='

// web BaseRequestModel field order, with pre-quoted values matching the
// pydantic defaults (browser_version / root_referer / tz_name are
// quote()'d in the source and then raw-joined).
function baseParams (msToken) {
  return {
    WebIdLastTime: String(Math.floor(Date.now() / 1000)),
    aid: '1988',
    app_language: 'en',
    app_name: 'tiktok_web',
    browser_language: 'en-US',
    browser_name: 'Mozilla',
    browser_online: 'true',
    browser_platform: 'Win32',
    browser_version: '5.0%20%28Windows%29',
    channel: 'tiktok_web',
    cookie_enabled: 'true',
    device_id: '7380187414842836523',
    odinId: '7404669909585003563',
    device_platform: 'web_pc',
    focus_state: 'true',
    from_page: 'user',
    history_len: '4',
    is_fullscreen: 'false',
    is_page_visible: 'true',
    language: 'en',
    os: 'windows',
    priority_region: 'US',
    referer: '',
    region: 'US',
    root_referer: 'https%3A%2F%2Fwww.tiktok.com%2F',
    screen_height: '1080',
    screen_width: '1920',
    webcast_language: 'en',
    tz_name: 'America%2FTijuana',
    msToken
  }
}

function headers (ctx) {
  return buildHeaders({
    userAgent: ctx.config.tiktok.userAgent,
    referer: TIKTOK_WEB_REFERER,
    cookie: ctx.config.tiktok.cookie
  })
}

async function xbGet (ctx, baseUrl, params) {
  const paramStr = rawJoin(params)
  const { xBogus } = getXBogus(paramStr, ctx.config.tiktok.userAgent)
  const url = `${baseUrl}?${paramStr}&X-Bogus=${xBogus}`
  return fetchGetJson(url, headers(ctx))
}

export function fetchOneVideo (ctx, itemId) {
  return xbGet(ctx, EP.POST_DETAIL, { ...baseParams(fakeMsToken()), itemId })
}

export function fetchUserProfile (ctx, secUid, uniqueId) {
  return xbGet(ctx, EP.USER_DETAIL, { ...baseParams(fakeMsToken()), secUid, uniqueId })
}

export function fetchUserLike (ctx, secUid, cursor, count, coverFormat) {
  return xbGet(ctx, EP.USER_LIKE, {
    ...baseParams(fakeMsToken()), coverFormat: String(coverFormat), count: String(count), cursor: String(cursor), secUid
  })
}

export function fetchUserMix (ctx, mixId, cursor, count) {
  return xbGet(ctx, EP.USER_MIX, {
    ...baseParams(fakeMsToken()), count: String(count), cursor: String(cursor), mixId
  })
}

export function fetchPostComment (ctx, awemeId, cursor, count, currentRegion) {
  return xbGet(ctx, EP.POST_COMMENT, {
    ...baseParams(fakeMsToken()), aweme_id: awemeId, count: String(count), cursor: String(cursor), current_region: currentRegion
  })
}

export function fetchPostCommentReply (ctx, itemId, commentId, cursor, count, currentRegion) {
  return xbGet(ctx, EP.POST_COMMENT_REPLY, {
    ...baseParams(fakeMsToken()), item_id: itemId, comment_id: commentId, count: String(count), cursor: String(cursor), current_region: currentRegion
  })
}

export function fetchUserFans (ctx, secUid, count, maxCursor, minCursor) {
  return xbGet(ctx, EP.USER_FANS, {
    ...baseParams(fakeMsToken()), secUid, count: String(count), maxCursor: String(maxCursor), minCursor: String(minCursor), scene: '67'
  })
}

export function fetchUserFollow (ctx, secUid, count, maxCursor, minCursor) {
  return xbGet(ctx, EP.USER_FOLLOW, {
    ...baseParams(fakeMsToken()), secUid, count: String(count), maxCursor: String(maxCursor), minCursor: String(minCursor), scene: '21'
  })
}

// fetch_user_post uses a distinct param model (separate from
// BaseRequestModel) with a baked _signature, per the source.
export function fetchUserPost (ctx, secUid, cursor, count, coverFormat) {
  const params = {
    WebIdLastTime: '1714385892',
    aid: '1988',
    app_language: 'zh-Hans',
    app_name: 'tiktok_web',
    browser_language: 'zh-CN',
    browser_name: 'Mozilla',
    browser_online: 'true',
    browser_platform: 'Win32',
    browser_version: '5.0%20%28Windows%29',
    channel: 'tiktok_web',
    cookie_enabled: 'true',
    count: String(count),
    coverFormat: String(coverFormat),
    cursor: String(cursor),
    data_collection_enabled: 'true',
    device_id: '7380187414842836523',
    device_platform: 'web_pc',
    focus_state: 'true',
    from_page: 'user',
    history_len: '3',
    is_fullscreen: 'false',
    is_page_visible: 'true',
    language: 'zh-Hans',
    locate_item_id: '',
    needPinnedItemIds: 'true',
    odinId: '7404669909585003563',
    os: 'windows',
    post_item_list_request_type: '0',
    priority_region: 'US',
    referer: '',
    region: 'US',
    screen_height: '827',
    screen_width: '1323',
    secUid,
    tz_name: 'America%2FLos_Angeles',
    user_is_login: 'true',
    webcast_language: 'zh-Hans',
    msToken: 'SXtP7K0MMFlQmzpuWfZoxAlAaKqt-2p8oAbOHFBw-k3TA2g4jE_FXrFKf3i38lR-xNh_bV1_qfTPRnj4PXbkBfrVD2iAazeUkASIASHT0pu-Bx2_POx7O3nBBHZe2SI7CPsanerdclxHht1hcoUTlg%3D%3D',
    _signature: '_02B4Z6wo000017oyWOQAAIDD9xNhTSnfaDu6MFxAAIlj23'
  }
  return xbGet(ctx, EP.USER_POST, params)
}

export function fetchUserPlayList (ctx, secUid, cursor, count) {
  return xbGet(ctx, EP.USER_PLAY_LIST, {
    ...baseParams(fakeMsToken()), count: String(count), cursor: String(cursor), secUid
  })
}
