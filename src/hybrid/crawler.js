// Hybrid parser — port of crawlers/hybrid/hybrid_crawler.py (douyin +
// tiktok branches; bilibili is out of scope). Detects the platform
// from the URL, fetches the (cached) raw metadata, and — when
// minimal=true — maps it into the unified schema the upstream returns.
import { getAwemeId, getTiktokAwemeId } from '../utils/ids.js'
import { fetchDouyinDetailCached, fetchTiktokAwemeCached } from '../utils/meta-cache.js'
import { HTTPException } from '../utils/http-exception.js'
import {
  nwmCandidates, toPlayUrl, playUrlFromUri,
  videoDimensions, isWatermarkUrl
} from '../utils/media.js'

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
// { raw, cached, source, signed_error }.
export async function fetchRawById (ctx, platform, id, refresh = false) {
  if (platform === 'douyin') {
    const { data, cached } = await fetchDouyinDetailCached(ctx, id, refresh)
    const raw = data.aweme_detail
    if (!raw) {
      const reason = data.filter_detail?.filter_reason || ''
      if (/vr|360/i.test(reason)) {
        throw new HTTPException(422, { message: '这是抖音 360°/VR 全景视频，抖音仅允许在 App 内观看，网页 / 分享接口均不返回媒体地址，暂无法解析。' })
      }
      if (reason) {
        const notice = data.filter_detail?.notice || data.filter_detail?.detail_msg || ''
        throw new HTTPException(422, { message: `抖音拒绝返回该作品（${reason}${notice ? '：' + notice : ''}）` })
      }
      throw new HTTPException(502, { message: 'Douyin returned no aweme_detail (bad cookie/signature?)' })
    }
    return {
      raw,
      cached,
      source: data.source || 'signed',
      signed_error: data.signed_error || null
    }
  }
  if (platform === 'tiktok') {
    const { data, cached } = await fetchTiktokAwemeCached(ctx, id, refresh)
    return { raw: data, cached, source: 'app', signed_error: null }
  }
  throw new HTTPException(400, { message: `Unknown platform: ${platform}` })
}

function douyinVideoData (video) {
  const uri = video?.play_addr?.uri || video?.download_addr?.uri || ''
  const nwmList = nwmCandidates(video)
  const nwmHQ = nwmList[0] || (uri ? playUrlFromUri(uri, '1080p') : null)
  const nwm = (uri ? playUrlFromUri(uri, '1080p') : null) || nwmHQ
  const wmList = video?.download_addr?.url_list
  const wmHQ = (Array.isArray(wmList) && wmList[0]) ||
    (Array.isArray(video?.play_addr?.url_list) ? video.play_addr.url_list[0] : null) ||
    (uri ? `https://aweme.snssdk.com/aweme/v1/playwm/?video_id=${uri}&radio=1080p&line=0` : null)
  const dim = videoDimensions(video)
  return {
    wm_video_url: uri
      ? `https://aweme.snssdk.com/aweme/v1/playwm/?video_id=${uri}&radio=1080p&line=0`
      : wmHQ,
    wm_video_url_HQ: wmHQ,
    nwm_video_url: nwm,
    nwm_video_url_HQ: nwmHQ,
    width: dim.width,
    height: dim.height
  }
}

function tiktokVideoData (video) {
  const nwmList = nwmCandidates(video)
  const play0 = video?.play_addr?.url_list?.[0] || null
  const nwmHQ = nwmList[0] || play0
  const wm = video?.download_addr?.url_list?.[0] ?? null
  const dim = videoDimensions(video)
  return {
    wm_video_url: wm,
    wm_video_url_HQ: wm,
    nwm_video_url: play0 || nwmHQ,
    nwm_video_url_HQ: nwmHQ,
    width: dim.width,
    height: dim.height
  }
}

// Pure mapper: raw aweme detail -> unified minimal schema.
// `meta.source` is 'signed' | 'share' | 'app' (kept on the result so
// the UI / cache / debug path can tell which upstream we used).
export function toMinimal (platform, videoId, data, meta = {}) {
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
    hashtags: data.text_extra,
    source: meta.source || data.source || null
  }

  if (platform === 'douyin') {
    if (type === 'video') {
      result.video_data = douyinVideoData(data.video || {})
    } else {
      const nwm = []; const wm = []
      for (const i of (data.images || [])) {
        nwm.push(i.url_list[0])
        wm.push(i.download_url_list[0])
      }
      result.image_data = { no_watermark_image_list: nwm, watermark_image_list: wm }
    }
  } else { // tiktok
    if (type === 'video') {
      result.video_data = tiktokVideoData(data.video || {})
    } else {
      const nwm = []; const wm = []
      for (const i of (data.image_post_info?.images || [])) {
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
  const { raw, source } = await fetchRawById(ctx, platform, id, refresh)
  if (!minimal) return raw
  return toMinimal(platform, id, raw, { source })
}

// Pick a concrete CDN URL from a minimal result for a proxy `kind`.
// kinds: nwm | wm | cover | image<N> | imagewm<N>
export function resolveKindUrl (minimal, kind) {
  const isImageKind = /^image(wm)?\d+$/.test(kind)
  if (kind === 'nwm' || kind === 'wm') {
    const vd = minimal.video_data
    if (!vd) throw new HTTPException(404, { message: 'No video for this resource' })
    let url = kind === 'nwm'
      ? (vd.nwm_video_url_HQ || vd.nwm_video_url)
      : (vd.wm_video_url_HQ || vd.wm_video_url)
    if (kind === 'nwm' && url) url = toPlayUrl(url)
    if (kind === 'nwm' && isWatermarkUrl(url)) {
      throw new HTTPException(502, { message: 'nwm resolved to a watermarked playwm URL' })
    }
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

// All candidate CDN URLs for a proxy `kind`, in priority order. Douyin
// often returns several mirrors (play_addr.url_list + per-bitrate
// play_addr) and some are dead/expired/region-blocked — the proxy tries
// them in turn and uses the first that actually serves media.
export function mediaCandidates (platform, raw, kind) {
  const out = []
  const push = (arr) => { if (Array.isArray(arr)) for (const u of arr) if (typeof u === 'string' && u) out.push(u) }
  const video = raw.video || {}

  if (kind === 'nwm') {
    out.push(...nwmCandidates(video))
  } else if (kind === 'wm') {
    push(video.download_addr?.url_list)
    push(video.play_addr?.url_list)
  } else if (kind === 'cover') {
    push(video.cover?.url_list)
    push(video.origin_cover?.url_list)
    if (platform === 'douyin') push(raw.images?.[0]?.url_list)
    else push(raw.image_post_info?.images?.[0]?.display_image?.url_list)
  } else if (kind === 'avatar') {
    push(raw.author?.avatar_larger?.url_list)
    push(raw.author?.avatar_thumb?.url_list)
  } else if (/^image(wm)?\d+$/.test(kind)) {
    const wm = kind.startsWith('imagewm')
    const idx = Number(kind.replace(/^image(wm)?/, ''))
    if (platform === 'douyin') {
      const im = raw.images?.[idx]
      push(wm ? im?.download_url_list : im?.url_list)
    } else {
      const im = raw.image_post_info?.images?.[idx]
      push(wm ? im?.owner_watermark_image?.url_list : im?.display_image?.url_list)
    }
  }
  // Prefer https, dedup, keep order. nwm is already filtered.
  const https = [...new Set(out.map(u => String(u).replace(/^http:/, 'https:')))]
  if (kind === 'nwm') return https.filter(u => !isWatermarkUrl(u))
  return https
}
