// No-watermark URL selection for Douyin (and TikTok bit_rate ranking).
//
// The iesdouyin share-page fallback often only returns
//   aweme.snssdk.com/aweme/v1/playwm/?...
// with no bit_rate / download_addr. Serving that URL as kind=nwm is how
// parsed videos grew a watermark. Every 'nwm' URL we emit must be a
// /play/ (not /playwm/) address, preferably the highest available ratio.

const RATIO_NUM = (v) => {
  const m = String(v || '').match(/(\d{3,4})/)
  return m ? Number(m[1]) : 0
}

export function isWatermarkUrl (url) {
  if (typeof url !== 'string' || !url) return false
  try {
    const u = new URL(url.replace(/^http:/i, 'https:'))
    if (/\/playwm(?:\/|$)/i.test(u.pathname)) return true
    const logo = u.searchParams.get('logo_type')
    if (logo != null && logo !== '' && logo !== '0') return true
    if (u.searchParams.get('watermark') === '1') return true
    if (u.searchParams.get('with_watermark') === '1') return true
  } catch {
    return /\/playwm(?:\/|\?|$)/i.test(url) || /[?&]logo_type=/i.test(url)
  }
  return false
}

// Rewrite a (possibly watermarked) play URL into the no-watermark
// variant and ask for `ratio` when the URL doesn't already request a
// higher one. Never throws; unparseable strings get a surgical replace.
export function toPlayUrl (url, ratio = '1080p') {
  if (typeof url !== 'string' || !url) return url
  let u
  try { u = new URL(url.replace(/^http:/i, 'https:')) } catch {
    return url.replace(/playwm/gi, 'play')
  }
  u.pathname = u.pathname.replace(/\/playwm(?=\/|$)/gi, '/play')
  u.searchParams.delete('logo_type')
  u.searchParams.delete('logo_name')
  u.searchParams.delete('watermark')
  u.searchParams.delete('with_watermark')
  // ratio/radio only apply to the aweme play endpoints — don't append
  // them onto an already-resolved CDN .mp4 URL.
  if (/\/play(?:wm)?(?:\/|$)/i.test(u.pathname)) {
    const radio = u.searchParams.get('radio')
    if (radio && !u.searchParams.get('ratio')) u.searchParams.set('ratio', radio)
    u.searchParams.delete('radio')
    const want = RATIO_NUM(ratio)
    const have = RATIO_NUM(u.searchParams.get('ratio'))
    if (want && want > have) u.searchParams.set('ratio', ratio)
  }
  return u.toString()
}

export function playUrlFromUri (uri, ratio = '1080p', host = 'aweme.snssdk.com') {
  if (!uri) return null
  return `https://${host}/aweme/v1/play/?video_id=${uri}&ratio=${ratio}&line=0`
}

function playAddrOf (entry) {
  return entry?.play_addr || entry || {}
}

export function bitRateQuality (entry) {
  const pa = playAddrOf(entry)
  const w = Number(pa.width || entry?.width) || 0
  const h = Number(pa.height || entry?.height) || 0
  return {
    pixels: w * h,
    width: w,
    height: h,
    size: Number(entry?.data_size || pa.data_size) || 0,
    br: Number(entry?.bit_rate || entry?.bitrate) || 0,
    ratio: RATIO_NUM(entry?.gear_name || entry?.quality_type || pa.url_key)
  }
}

export function compareBitRate (a, b) {
  const qa = bitRateQuality(a)
  const qb = bitRateQuality(b)
  if (qb.pixels !== qa.pixels) return qb.pixels - qa.pixels
  if (qb.size !== qa.size) return qb.size - qa.size
  if (qb.br !== qa.br) return qb.br - qa.br
  return qb.ratio - qa.ratio
}

export function sortedBitRates (video) {
  const list = Array.isArray(video?.bit_rate) ? video.bit_rate.filter(Boolean) : []
  return [...list].sort(compareBitRate)
}

export function videoDimensions (video) {
  const w0 = Number(video?.width) || 0
  const h0 = Number(video?.height) || 0
  if (w0 > 0 && h0 > 0) return { width: w0, height: h0 }
  const pa = video?.play_addr || {}
  const w1 = Number(pa.width) || 0
  const h1 = Number(pa.height) || 0
  if (w1 > 0 && h1 > 0) return { width: w1, height: h1 }
  const best = sortedBitRates(video)[0]
  const w2 = Number(best?.play_addr?.width) || 0
  const h2 = Number(best?.play_addr?.height) || 0
  if (w2 > 0 && h2 > 0) return { width: w2, height: h2 }
  return { width: 0, height: 0 }
}

function pushNwm (out, url) {
  if (typeof url !== 'string' || !url) return
  const n = toPlayUrl(url)
  if (!n || isWatermarkUrl(n)) return
  out.push(n.replace(/^http:/i, 'https:'))
}

// Ordered no-watermark candidate URLs, highest quality first. Never
// includes a playwm URL. Used by toMinimal + mediaCandidates + proxy.
export function nwmCandidates (video) {
  const out = []
  const rates = sortedBitRates(video)
  for (const b of rates) {
    const list = b?.play_addr?.url_list
    if (Array.isArray(list)) for (const u of list) pushNwm(out, u)
  }
  const uri = video?.play_addr?.uri || video?.download_addr?.uri || rates[0]?.play_addr?.uri || ''
  // Constructed 1080p/720p play URLs beat a leftover 540p playwm rewrite
  // when the share page gave us no bit_rate ladder.
  if (uri) {
    pushNwm(out, playUrlFromUri(uri, '1080p'))
    pushNwm(out, playUrlFromUri(uri, '720p'))
    pushNwm(out, playUrlFromUri(uri, '1080p', 'www.iesdouyin.com'))
  }
  const list = video?.play_addr?.url_list
  if (Array.isArray(list)) for (const u of list) pushNwm(out, u)
  return [...new Set(out)]
}

export function bestNwmUrl (video) {
  return nwmCandidates(video)[0] || null
}

// RFC 5987 Content-Disposition. ASCII filename= fallback + UTF-8
// filename* so Chinese author/desc names survive. Strips CR/LF/" so
// the header cannot be split.
export function downloadFilename ({ author = '', desc = '', id = '', ext = 'mp4' } = {}) {
  const stripCtrl = (s) => {
    let out = ''
    for (const ch of s) {
      const c = ch.codePointAt(0)
      if (c >= 32 && c !== 127) out += ch
    }
    return out
  }
  const clean = (s, max) => stripCtrl(String(s || ''))
    .replace(/[\\/:*?"<>|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/g, '')
    .slice(0, max)
  const a = clean(author, 32) || 'unknown'
  const d = clean(desc, 40) || 'video'
  const ident = String(id || '').replace(/[^\w.-]/g, '').slice(0, 24) || 'id'
  const e = String(ext || 'mp4').replace(/[^\w]/g, '') || 'mp4'
  return `${a}-${d}-${ident}.${e}`
}

export function contentDispositionAttachment (filename) {
  const safe = String(filename || 'download').replace(/[\r\n"]/g, '_')
  const ascii = safe.replace(/[^\x20-\x7E]/g, '_') || 'download'
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(safe)}`
}
