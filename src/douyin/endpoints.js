// Douyin web API endpoints (subset we expose). Mirrors
// crawlers/douyin/web/endpoints.py.
const DOUYIN = 'https://www.douyin.com'
const LIVE = 'https://live.douyin.com'
const LIVE2 = 'https://webcast.amemv.com'

export const DouyinEndpoints = {
  POST_DETAIL: `${DOUYIN}/aweme/v1/web/aweme/detail/`,
  USER_POST: `${DOUYIN}/aweme/v1/web/aweme/post/`,
  USER_FAVORITE_A: `${DOUYIN}/aweme/v1/web/aweme/favorite/`,
  USER_DETAIL: `${DOUYIN}/aweme/v1/web/user/profile/other/`,
  MIX_AWEME: `${DOUYIN}/aweme/v1/web/mix/aweme/`,
  POST_COMMENT: `${DOUYIN}/aweme/v1/web/comment/list/`,
  POST_COMMENT_REPLY: `${DOUYIN}/aweme/v1/web/comment/list/reply/`,
  LIVE_INFO: `${LIVE}/webcast/room/web/enter/`,
  LIVE_INFO_ROOM_ID: `${LIVE2}/webcast/room/reflow/info/`,
  LIVE_GIFT_RANK: `${LIVE}/webcast/ranklist/audience/`
}

export const DOUYIN_REFERER = 'https://www.douyin.com/'
