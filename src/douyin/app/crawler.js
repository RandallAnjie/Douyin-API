// Douyin app-domain crawler — the public ranking + recommend endpoints on
// aweme.snssdk.com / webcast.amemv.com. Unlike the web endpoints (which
// need a_bogus / X-Bogus and still hit risk-control 2483 without a full
// logged-in cookie), these only want the app query params + an okhttp UA.
// No signature, no cookie. This is what makes Douyin library-growth viable.
import { fetchGetJson, buildHeaders } from '../../utils/base-crawler.js'
import { urlencode } from '../../utils/params.js'

const FEED_URL = 'https://aweme.snssdk.com/aweme/v1/feed/'
const HOT_SEARCH_URL = 'https://aweme.snssdk.com/aweme/v1/hot/search/list/'
const HOT_MUSIC_URL = 'https://aweme.snssdk.com/aweme/v1/chart/music/list/'
// The "热歌榜" chart id (from RandallAnjie/douyin-hot-hub-music).
const HOT_MUSIC_CHART_ID = '6853972723954146568'

// Minimal app identity. aid=1128 is Douyin; the version is what the public
// ranking endpoints expect. No device registration is needed for these.
function appParams (extra = {}) {
  return {
    device_platform: 'android',
    version_name: '13.2.0',
    version_code: '130200',
    aid: '1128',
    ...extra
  }
}

function appHeaders () {
  return buildHeaders({ userAgent: 'okhttp3' })
}

// The recommend feed (FYP) — a batch of fresh, fully-playable awemes
// (video.play_addr, author, statistics, music, text_extra). Returns the
// raw aweme objects so cron can ingest them WITHOUT a per-id re-fetch.
export async function fetchAppFeed (ctx, count = 12) {
  const url = `${FEED_URL}?${urlencode(appParams({ count: String(count), type: '0', max_cursor: '0' }))}`
  const data = await fetchGetJson(url, appHeaders())
  return Array.isArray(data.aweme_list) ? data.aweme_list : []
}

// Map a feed aweme to the minimal card fields the 热门 board needs (cover,
// author, desc, like count). Full parsing happens on click, by id.
export function feedCard (a) {
  const v = a.video || {}
  return {
    id: a.aweme_id,
    desc: (a.desc || '').slice(0, 90),
    author: a.author?.nickname || '',
    cover: v.cover?.url_list?.[0] || v.origin_cover?.url_list?.[0] || a.cover?.url_list?.[0] || null,
    digg: a.statistics?.digg_count || 0,
    type: (a.aweme_type === 2 || a.aweme_type === 68 || Array.isArray(a.images)) ? 'image' : 'video'
  }
}

// 热搜榜 — trending search words with heat / view / video counts + a cover.
// Returns word_list (no associated videos; for display, not growth).
export async function fetchHotSearchBoard (ctx) {
  const url = `${HOT_SEARCH_URL}?${urlencode(appParams({ detail_list: '1' }))}`
  const data = await fetchGetJson(url, appHeaders())
  return Array.isArray(data?.data?.word_list) ? data.data.word_list : []
}

// 热歌榜 — trending music with a playable mp3 (play_url), cover, author and
// a use-count. Returns music_list.
export async function fetchHotMusicBoard (ctx, count = 50) {
  const url = `${HOT_MUSIC_URL}?${urlencode(appParams({ chart_id: HOT_MUSIC_CHART_ID, count: String(count) }))}`
  const data = await fetchGetJson(url, appHeaders())
  return Array.isArray(data.music_list) ? data.music_list : []
}
