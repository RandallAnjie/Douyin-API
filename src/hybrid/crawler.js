// Hybrid parser — port of crawlers/hybrid/hybrid_crawler.py (douyin +
// tiktok branches; bilibili is out of scope). Detects the platform
// from the URL, calls the right crawler, and — when minimal=true —
// maps the result into the unified schema the upstream returns.
import { getAwemeId, getTiktokAwemeId } from '../utils/ids.js'
import * as douyin from '../douyin/crawler.js'
import * as tiktokApp from '../tiktok/app/crawler.js'
import { HTTPException } from '../utils/http-exception.js'

const URL_TYPE = {
  0: 'video',
  2: 'image', 4: 'video', 68: 'image', // Douyin
  51: 'video', 55: 'video', 58: 'video', 61: 'video', 150: 'image' // TikTok
}

export async function hybridParseSingleVideo (ctx, url, minimal = false) {
  let platform, videoId, data, awemeType

  if (url.includes('douyin')) {
    platform = 'douyin'
    videoId = await getAwemeId(url)
    const resp = await douyin.fetchOneVideo(ctx, videoId)
    data = resp.aweme_detail
    if (!data) throw new HTTPException(502, { message: 'Douyin returned no aweme_detail (bad cookie/signature?)' })
    awemeType = data.aweme_type
  } else if (url.includes('tiktok')) {
    platform = 'tiktok'
    videoId = await getTiktokAwemeId(url)
    // 2024-09-14 upstream switched TikTok to the app crawler.
    data = await tiktokApp.fetchOneVideo(ctx, videoId)
    awemeType = data.aweme_type
  } else {
    throw new HTTPException(400, { message: 'Cannot determine platform (expected a douyin or tiktok URL)' })
  }

  if (!minimal) return data

  const type = URL_TYPE[awemeType] || 'video'
  const result = {
    type,
    platform,
    video_id: videoId,
    desc: data.desc,
    create_time: data.create_time,
    author: data.author,
    music: data.music,
    statistics: data.statistics,
    cover_data: {
      cover: data.video?.cover,
      origin_cover: data.video?.origin_cover,
      dynamic_cover: data.video?.dynamic_cover
    },
    hashtags: data.text_extra
  }

  if (platform === 'douyin') {
    if (type === 'video') {
      const uri = data.video.play_addr.uri
      const wmHQ = data.video.play_addr.url_list[0]
      result.video_data = {
        wm_video_url: `https://aweme.snssdk.com/aweme/v1/playwm/?video_id=${uri}&radio=1080p&line=0`,
        wm_video_url_HQ: wmHQ,
        nwm_video_url: `https://aweme.snssdk.com/aweme/v1/play/?video_id=${uri}&ratio=1080p&line=0`,
        nwm_video_url_HQ: wmHQ.replace('playwm', 'play')
      }
    } else {
      const nwm = []; const wm = []
      for (const i of data.images) {
        nwm.push(i.url_list[0])
        wm.push(i.download_url_list[0])
      }
      result.image_data = { no_watermark_image_list: nwm, watermark_image_list: wm }
    }
  } else { // tiktok
    if (type === 'video') {
      const wm = data.video?.download_addr?.url_list?.[0] ?? null
      result.video_data = {
        wm_video_url: wm,
        wm_video_url_HQ: wm,
        nwm_video_url: data.video.play_addr.url_list[0],
        nwm_video_url_HQ: data.video.bit_rate[0].play_addr.url_list[0]
      }
    } else {
      const nwm = []; const wm = []
      for (const i of data.image_post_info.images) {
        nwm.push(i.display_image.url_list[0])
        wm.push(i.owner_watermark_image.url_list[0])
      }
      result.image_data = { no_watermark_image_list: nwm, watermark_image_list: wm }
    }
  }

  return result
}
