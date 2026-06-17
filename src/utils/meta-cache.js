// Cached metadata fetchers. The parsed video info from Douyin / TikTok
// is stored as a JSON file in R2 (meta/{platform}/{id}.json) and reused
// for the TTL window, so repeated requests for the same id don't burn
// cookie/signature budget on the upstream. `refresh` bypasses + repops.
import { getJson, putJson, metaKey } from './r2cache.js'
import * as douyin from '../douyin/crawler.js'
import * as tiktokApp from '../tiktok/app/crawler.js'

// Douyin: caches the full fetch_one_video response (with aweme_detail).
export async function fetchDouyinDetailCached (ctx, awemeId, refresh = false) {
  const bucket = ctx.config.mediaR2
  const key = metaKey('douyin', awemeId)
  if (bucket && !refresh) {
    const cached = await getJson(bucket, key, ctx.config.cache.metaTtl)
    if (cached) return { data: cached, cached: true }
  }
  const data = await douyin.fetchOneVideo(ctx, awemeId)
  if (!data.aweme_detail) {
    // Web detail endpoint returned nothing — try the share-page fallback.
    const share = await douyin.fetchShareDetail(ctx, awemeId)
    if (share.aweme_detail) data.aweme_detail = share.aweme_detail
    else if (!data.filter_detail && share.filter_detail) data.filter_detail = share.filter_detail
  }
  // Don't poison the cache with an empty/filtered response.
  if (data.aweme_detail) putJson(bucket, ctx, key, data)
  return { data, cached: false }
}

// TikTok app: caches the aweme object.
export async function fetchTiktokAwemeCached (ctx, awemeId, refresh = false) {
  const bucket = ctx.config.mediaR2
  const key = metaKey('tiktok', awemeId)
  if (bucket && !refresh) {
    const cached = await getJson(bucket, key, ctx.config.cache.metaTtl)
    if (cached) return { data: cached, cached: true }
  }
  const data = await tiktokApp.fetchOneVideo(ctx, awemeId)
  putJson(bucket, ctx, key, data)
  return { data, cached: false }
}
