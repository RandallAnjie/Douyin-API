// TikTok web API endpoints. Mirrors crawlers/tiktok/web/endpoints.py.
const T = 'https://www.tiktok.com'

export const TikTokWebEndpoints = {
  USER_DETAIL: `${T}/api/user/detail/`,
  USER_POST: `${T}/api/post/item_list/`,
  USER_LIKE: `${T}/api/favorite/item_list/`,
  USER_COLLECT: `${T}/api/user/collect/item_list/`,
  USER_PLAY_LIST: `${T}/api/user/playlist/`,
  USER_MIX: `${T}/api/mix/item_list/`,
  USER_FOLLOW: `${T}/api/user/list/`,
  USER_FANS: `${T}/api/user/list/`,
  POST_DETAIL: `${T}/api/item/detail/`,
  POST_COMMENT: `${T}/api/comment/list/`,
  POST_COMMENT_REPLY: `${T}/api/comment/list/reply/`
}

export const TIKTOK_WEB_REFERER = 'https://www.tiktok.com/'
