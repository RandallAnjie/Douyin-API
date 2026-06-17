// Hybrid parser — port of crawlers/hybrid/hybrid_crawler.py (douyin +
// tiktok branches; bilibili is out of scope). Detects the platform
// from the URL, fetches the (cached) raw metadata, and — when
// minimal=true — maps it into the unified schema the upstream returns.
import { getAwemeId, getTiktokAwemeId } from '../utils/ids.js'
import { fetchDouyinDetailCached, fetchTiktokAwemeCached } from '../utils/meta-cache.js'
import { HTTPException } from '../utils/http-exception.js'

const URL_TYPE = {
  0: 'video',
  2: 'image', 4: 'video', 68: 'image', // Douyin
  51: 'video', 55: 'video', 58: 'video', 61: 'video', 150: 'image' // TikTok
}

export function detectPlatform (url) {
  if (url.includes('douyin')) return 'douyin'
  if (url.includes('tiktok')) return 'tiktok'
  return null
}

// Resolve a share URL to { platform, id }.
export async function resolvePlatformId (url) {
  // Reject our own result links pasted back in (a /proxy URL contains
  // our host's "douyin" and would otherwise be misdetected + fetched).
  if (/\/proxy\?/.test(url) || /[?&]kind=/.test(url)) {
    throw new HTTPException(400, { message: '这是解析结果链接，请粘贴抖音/TikTok 的原始分享口令' })
  }
  const platform = detectPlatform(url)
  if (platform === 'douyin') return { platform, id: await getAwemeId(url) }
  if (platform === 'tiktok') return { platform, id: await getTiktokAwemeId(url) }
  throw new HTTPException(400, { message: 'Cannot determine platform (expected a douyin or tiktok URL)' })
}

// Fetch the raw aweme detail by platform + id (cached). Returns
// { raw, cached }.
export async function fetchRawById (ctx, platform, id, refresh = false) {
  if (platform === 'douyin') {
    const { data, cached } = await fetchDouyinDetailCached(ctx, id, refresh)
    const raw = data.aweme_detail
    if (!raw) throw new HTTPException(502, { message: 'Douyin returned no aweme_detail (bad cookie/signature?)' })
    return { raw, cached }
  }
  if (platform === 'tiktok') {
    const { data, cached } = await fetchTiktokAwemeCached(ctx, id, refresh)
    return { raw: data, cached }
  }
  throw new HTTPException(400, { message: `Unknown platform: ${platform}` })
}

// Pure mapper: raw aweme detail -> unified minimal schema.
export function toMinimal (platform, videoId, data) {
  const type = URL_TYPE[data.aweme_type] || 'video'
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

export async function hybridParseSingleVideo (ctx, url, minimal = false, refresh = false) {
  const { platform, id } = await resolvePlatformId(url)
  const { raw } = await fetchRawById(ctx, platform, id, refresh)
  if (!minimal) return raw
  return toMinimal(platform, id, raw)
}

// Pick a concrete CDN URL from a minimal result for a proxy `kind`.
// kinds: nwm | wm | cover | image<N> | imagewm<N>
export function resolveKindUrl (minimal, kind) {
  const isImageKind = /^image(wm)?\d+$/.test(kind)
  if (kind === 'nwm' || kind === 'wm') {
    const vd = minimal.video_data
    if (!vd) throw new HTTPException(404, { message: 'No video for this resource' })
    const url = kind === 'nwm'
      ? (vd.nwm_video_url_HQ || vd.nwm_video_url)
      : (vd.wm_video_url_HQ || vd.wm_video_url)
    return { url, contentType: 'video/mp4', ext: 'mp4' }
  }
  if (kind === 'cover') {
    const url = minimal.cover_data?.cover?.url_list?.[0] || minimal.cover_data?.cover
    return { url: pickUrl(url), contentType: 'image/jpeg', ext: 'jpeg' }
  }
  if (isImageKind) {
    const wm = kind.startsWith('imagewm')
    const idx = Number(kind.replace(/^image(wm)?/, ''))
    const list = wm ? minimal.image_data?.watermark_image_list : minimal.image_data?.no_watermark_image_list
    if (!list || !list[idx]) throw new HTTPException(404, { message: `No image at index ${idx}` })
    return { url: list[idx], contentType: 'image/jpeg', ext: 'jpeg' }
  }
  throw new HTTPException(400, { message: `Unknown kind: ${kind}` })
}

const pickUrl = (v) => (typeof v === 'string' ? v : (v?.url_list?.[0] ?? null))
