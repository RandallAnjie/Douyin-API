// TikTok app crawler — port of crawlers/tiktok/app/app_crawler.py.
// No signature: a plain GET to the api22 feed endpoint with the app
// query params and an x-ladon header. Returns the first aweme.
import { fetchGetJson, buildHeaders } from '../../utils/base-crawler.js'
import { urlencode } from '../../utils/params.js'
import { HTTPException } from '../../utils/http-exception.js'

const HOME_FEED = 'https://api22-normal-c-alisg.tiktokv.com/aweme/v1/feed/'

// FeedVideoDetail = BaseRequestModel + aweme_id (app/models.py).
function feedParams (awemeId) {
  return {
    iid: '7318518857994389254',
    device_id: '7318517321748022790',
    channel: 'googleplay',
    app_name: 'musical_ly',
    version_code: '300904',
    device_platform: 'android',
    device_type: 'SM-ASUS_Z01QD',
    os_version: '9',
    aweme_id: awemeId
  }
}

// Trending feed (the FYP): the same endpoint without an aweme_id returns
// a batch of recommended/trending videos. Used by cron to grow the library
// from what's hot. Returns the aweme_list (full objects).
export async function fetchTrendingFeed (ctx, count = 12) {
  const params = { ...feedParams(''), count: String(count) }
  delete params.aweme_id
  const url = `${HOME_FEED}?${urlencode(params)}`
  const headers = buildHeaders({
    userAgent: ctx.config.tiktok.userAgent,
    referer: 'https://www.tiktok.com/',
    cookie: ctx.config.tiktok.cookie || 'CykaBlyat=XD',
    extra: { 'x-ladon': 'Hello From Evil0ctal!' }
  })
  const data = await fetchGetJson(url, headers)
  return Array.isArray(data.aweme_list) ? data.aweme_list : []
}

export async function fetchOneVideo (ctx, awemeId) {
  const url = `${HOME_FEED}?${urlencode(feedParams(awemeId))}`
  const headers = buildHeaders({
    userAgent: ctx.config.tiktok.userAgent,
    referer: 'https://www.tiktok.com/',
    cookie: ctx.config.tiktok.cookie || 'CykaBlyat=XD',
    extra: { 'x-ladon': 'Hello From Evil0ctal!' }
  })
  const data = await fetchGetJson(url, headers)
  const list = data.aweme_list
  if (!Array.isArray(list) || list.length === 0) {
    throw new HTTPException(404, { message: `No aweme in feed for ${awemeId}` })
  }
  const aweme = list[0]
  if (aweme.aweme_id !== awemeId) {
    throw new HTTPException(404, { message: `Video ID mismatch (got ${aweme.aweme_id})` })
  }
  return aweme
}
