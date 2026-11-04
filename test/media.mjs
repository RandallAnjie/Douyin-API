// Unit tests for playwm -> play normalisation, best-quality bit_rate
// selection, cache-key versioning, and download filenames.
import {
  isWatermarkUrl, toPlayUrl, playUrlFromUri, nwmCandidates, bestNwmUrl,
  compareBitRate, sortedBitRates, videoDimensions,
  downloadFilename, contentDispositionAttachment
} from '../src/utils/media.js'
import { toMinimal, mediaCandidates, resolveKindUrl } from '../src/hybrid/crawler.js'
import { mediaKey, metaKey, CACHE_VERSION } from '../src/utils/r2cache.js'

let failed = 0
const check = (name, cond, extra = '') => {
  if (!cond) failed++
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`)
}

const PLAYWM = 'https://aweme.snssdk.com/aweme/v1/playwm/?video_id=v0200testuri&line=0'
const PLAYWM_LOGO = 'https://aweme.snssdk.com/aweme/v1/play/?video_id=v0200testuri&logo_type=2&line=0'
const SHARE_VIDEO = {
  width: 1920,
  height: 1080,
  play_addr: { uri: 'v0200testuri', url_list: [PLAYWM] }
}

// --- watermark detection / rewrite ---
check('playwm path is watermarked', isWatermarkUrl(PLAYWM))
check('logo_type>0 is watermarked', isWatermarkUrl(PLAYWM_LOGO))
check('plain /play/ is not watermarked', !isWatermarkUrl('https://aweme.snssdk.com/aweme/v1/play/?video_id=x&ratio=1080p&line=0'))
check('toPlayUrl rewrites playwm path', /\/play\/\?/.test(toPlayUrl(PLAYWM)) && !/playwm/i.test(toPlayUrl(PLAYWM)))
check('toPlayUrl strips logo_type', !/logo_type/.test(toPlayUrl(PLAYWM_LOGO)))
check('toPlayUrl asks for 1080p when missing', /ratio=1080p/.test(toPlayUrl(PLAYWM)))
check('toPlayUrl maps radio and upgrades to 1080p', (() => {
  const u = toPlayUrl('https://aweme.snssdk.com/aweme/v1/playwm/?video_id=x&radio=720p')
  return /ratio=1080p/.test(u) && !/radio=/.test(u) && /\/play\/\?/.test(u)
})())
check('toPlayUrl does not append ratio to CDN mp4', toPlayUrl('https://cdn.example/1080.mp4') === 'https://cdn.example/1080.mp4')
check('toPlayUrl keeps a higher existing ratio', /ratio=1080p/.test(toPlayUrl('https://aweme.snssdk.com/aweme/v1/play/?video_id=x&ratio=1080p', '720p')))
check('playUrlFromUri is /play/ 1080p', playUrlFromUri('v0200testuri') === 'https://aweme.snssdk.com/aweme/v1/play/?video_id=v0200testuri&ratio=1080p&line=0')

// --- share-page shape (the live bug): only playwm, no bit_rate ---
const nwm = nwmCandidates(SHARE_VIDEO)
check('share-page nwm candidates are non-empty', nwm.length > 0)
check('share-page nwm never contains playwm', nwm.every(u => !isWatermarkUrl(u) && !/playwm/i.test(u)))
check('share-page nwm prefers constructed 1080p', nwm[0] === playUrlFromUri('v0200testuri', '1080p'))
check('bestNwmUrl is play not playwm', bestNwmUrl(SHARE_VIDEO) && !/playwm/i.test(bestNwmUrl(SHARE_VIDEO)))

const min = toMinimal('douyin', '7372484719365098803', {
  aweme_type: 4,
  desc: 'hello / world',
  author: { nickname: 'Alice' },
  video: SHARE_VIDEO,
  statistics: {},
  text_extra: []
}, { source: 'share' })
check('toMinimal.source is share', min.source === 'share')
check('toMinimal nwm_video_url is play', /\/play\/\?/.test(min.video_data.nwm_video_url) && !/playwm/i.test(min.video_data.nwm_video_url))
check('toMinimal nwm_video_url_HQ is play', /\/play\//.test(min.video_data.nwm_video_url_HQ) && !/playwm/i.test(min.video_data.nwm_video_url_HQ))
check('toMinimal keeps wm as playwm', /playwm/.test(min.video_data.wm_video_url))
check('toMinimal width/height from video', min.video_data.width === 1920 && min.video_data.height === 1080)

const cands = mediaCandidates('douyin', { video: SHARE_VIDEO }, 'nwm')
check('mediaCandidates nwm skips playwm', cands.every(u => !/playwm/i.test(u) && !isWatermarkUrl(u)))
check('mediaCandidates nwm includes 1080p play', cands.includes(playUrlFromUri('v0200testuri', '1080p')))
const wmCands = mediaCandidates('douyin', { video: SHARE_VIDEO }, 'wm')
check('mediaCandidates wm may still include playwm', wmCands.some(u => /playwm/i.test(u)))

const resolved = resolveKindUrl(min, 'nwm')
check('resolveKindUrl nwm is not playwm', resolved.url && !/playwm/i.test(resolved.url))

// --- bit_rate quality ranking ---
const ladder = {
  play_addr: { uri: 'u', url_list: ['https://cdn.example/low.mp4'] },
  bit_rate: [
    { bit_rate: 500000, data_size: 1000, play_addr: { width: 720, height: 1280, data_size: 1000, url_list: ['https://cdn.example/720.mp4'] } },
    { bit_rate: 2000000, data_size: 5000, play_addr: { width: 1080, height: 1920, data_size: 5000, url_list: ['https://cdn.example/1080.mp4'] } },
    { bit_rate: 800000, data_size: 2000, play_addr: { width: 540, height: 960, data_size: 2000, url_list: ['https://cdn.example/540.mp4'] } }
  ]
}
check('sortedBitRates picks 1080 first', sortedBitRates(ladder)[0].play_addr.url_list[0].includes('1080.mp4'))
check('nwmCandidates prefers 1080 bit_rate over play_addr', nwmCandidates(ladder)[0] === 'https://cdn.example/1080.mp4')
check('compareBitRate is descending pixels then size', compareBitRate(ladder.bit_rate[0], ladder.bit_rate[1]) > 0)
check('videoDimensions from bit_rate when video.w/h missing', videoDimensions({ bit_rate: ladder.bit_rate }).width === 1080)

const wmBit = {
  play_addr: { uri: 'u', url_list: [PLAYWM] },
  bit_rate: [
    { play_addr: { width: 1080, height: 1920, url_list: ['https://aweme.snssdk.com/aweme/v1/playwm/?video_id=u&line=0'] } }
  ]
}
check('bit_rate playwm is rewritten before use', nwmCandidates(wmBit).every(u => !/playwm/i.test(u)))
check('rewritten bit_rate still /play/', nwmCandidates(wmBit).some(u => /\/play\//.test(u)))

// --- cache key version ---
check('CACHE_VERSION is v2', CACHE_VERSION === 'v2')
check('mediaKey uses v2 prefix', mediaKey('douyin', '737', 'nwm') === 'media/v2/douyin/737/nwm')
check('metaKey uses v2 prefix', metaKey('douyin', '737') === 'meta/v2/douyin/737.json')
check('mediaKey encodes id', mediaKey('tiktok', 'a/b', 'cover') === 'media/v2/tiktok/a%2Fb/cover')
check('v1 keys are not produced', !mediaKey('douyin', '1', 'nwm').startsWith('media/douyin/'))

// --- download filename ---
const fn = downloadFilename({ author: 'Alice/Bob', desc: 'hello: world?*', id: '7372484719365098803', ext: 'mp4' })
check('filename strips reserved chars', !/[\\/:*?"<>|]/.test(fn) && fn.endsWith('.mp4'))
check('filename keeps author and id', fn.includes('Alice') && fn.includes('7372484719365098803'))
const cd = contentDispositionAttachment('作者-标题-123.mp4')
check('disposition has filename= and filename*', /filename="/.test(cd) && /filename\*=UTF-8''/.test(cd))
check('disposition encodes unicode', cd.includes(encodeURIComponent('作者-标题-123.mp4')))
const injected = contentDispositionAttachment('a"b\nc.mp4')
check('disposition strips CR/LF from filename', !injected.includes('\n') && !injected.includes('\r') && !injected.includes('a"b'))

const imgMin = toMinimal('douyin', '99', {
  aweme_type: 2,
  desc: 'pics',
  author: { nickname: 'N' },
  images: [{ url_list: ['https://p.com/a.jpeg'], download_url_list: ['https://p.com/a-wm.jpeg'] }],
  statistics: {},
  text_extra: []
})
check('image candidates skip video nwm', mediaCandidates('douyin', { images: [{ url_list: ['https://p.com/a.jpeg'] }] }, 'image0')[0] === 'https://p.com/a.jpeg')
check('image type has no video_data', !imgMin.video_data && imgMin.image_data.no_watermark_image_list.length === 1)

console.log(failed === 0 ? '\nAll media tests passed.' : `\n${failed} media test(s) failed.`)
process.exit(failed === 0 ? 0 : 1)
