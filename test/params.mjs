// Unit tests for Douyin web param assembly (uifid / msToken / verifyFp)
// and the share-page fallback when the signed detail endpoint 403s.
// Synthetic cookie values only — never a real jar.
import {
  parseCookie, extractUifid, extractMsToken, extractVerifyFp,
  sessionFromCookie, baseRequestParams, urlencode
} from '../src/utils/params.js'
import { redactUpstreamUrl } from '../src/utils/base-crawler.js'
import { getABogus } from '../src/sign/abogus.js'
import {
  buildDouyinWebParams, signedABogusUrl, fetchOneVideo, fetchShareDetail
} from '../src/douyin/crawler.js'
import { DouyinEndpoints as EP } from '../src/douyin/endpoints.js'
import { fetchDouyinDetailCached } from '../src/utils/meta-cache.js'

let failed = 0
const check = (name, cond, extra = '') => {
  if (!cond) failed++
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`)
}

// --- cookie extraction ---

const jar = 'ttwid=tt1; UIFID=UiFidPrimaryValue; UIFID_TEMP=tempShouldLose; msToken=MsTokFromJar; s_v_web_id=verify_abc_def; other=x=y=z'
check('parseCookie keeps values with =', parseCookie(jar).other === 'x=y=z')
check('extractUifid prefers UIFID over UIFID_TEMP', extractUifid(jar) === 'UiFidPrimaryValue')
check('extractUifid falls back to UIFID_TEMP', extractUifid('foo=1; UIFID_TEMP=TempOnlyValue') === 'TempOnlyValue')
check('extractUifid falls back to lowercase uifid', extractUifid('uifid=lowerOnly') === 'lowerOnly')
check('extractUifid empty cookie is empty', extractUifid('') === '')
check('extractUifid skips empty UIFID for UIFID_TEMP', extractUifid('UIFID=; UIFID_TEMP=TempOnlyValue') === 'TempOnlyValue')
check('extractMsToken', extractMsToken(jar) === 'MsTokFromJar')
check('extractVerifyFp from s_v_web_id', extractVerifyFp(jar) === 'verify_abc_def')
check('sessionFromCookie packs the three', (() => {
  const s = sessionFromCookie(jar)
  return s.uifid === 'UiFidPrimaryValue' && s.msToken === 'MsTokFromJar' && s.verifyFp === 'verify_abc_def'
})())

// --- default param set: uifid sits immediately before msToken ---

const p = baseRequestParams('fixedMs', { uifid: 'UiFidPrimaryValue' })
const keys = Object.keys(p)
check('uifid is in BaseRequestModel', p.uifid === 'UiFidPrimaryValue')
check('msToken is the value passed in', p.msToken === 'fixedMs')
check('uifid immediately precedes msToken', keys[keys.indexOf('msToken') - 1] === 'uifid')
check('no verifyFp when omitted', !('verifyFp' in p) && !('fp' in p))

const pFp = baseRequestParams('fixedMs', { uifid: 'UiFidPrimaryValue', verifyFp: 'verify_abc_def' })
const keysFp = Object.keys(pFp)
check('verifyFp/fp sit between uifid and msToken',
  keysFp.slice(keysFp.indexOf('uifid'), keysFp.indexOf('msToken') + 1).join(',') ===
  'uifid,verifyFp,fp,msToken')

const encoded = urlencode(p)
check('urlencode includes uifid before msToken',
  encoded.includes('uifid=UiFidPrimaryValue') &&
  encoded.indexOf('uifid=') < encoded.indexOf('msToken='))
check('urlencode includes the same msToken', encoded.includes('msToken=fixedMs'))

// Signed string === query string in the URL (a_bogus invariant).
const signed = signedABogusUrl(EP.POST_DETAIL, { ...p, aweme_id: '7372484719365098803' })
check('a_bogus URL query (minus a_bogus) equals signed paramStr',
  signed.url.startsWith(EP.POST_DETAIL + '?' + signed.paramStr + '&a_bogus='))
check('getABogus(paramStr) matches the URL token',
  decodeURIComponent(signed.url.split('a_bogus=')[1]) === signed.aBogus)
check('signed paramStr still carries uifid', signed.paramStr.includes('uifid=UiFidPrimaryValue'))

// Parity reference string (no uifid) still signs to the pinned value —
// this file must not drift the algorithm. Full pin lives in parity.mjs.
const abParams = 'device_platform=webapp&aid=6383&channel=channel_pc_web&aweme_id=7372484719365098803&pc_client_type=1&version_code=290100&version_name=29.1.0&cookie_enabled=true&screen_width=1920&screen_height=1080&browser_language=zh-CN&browser_platform=Win32&browser_name=Chrome&browser_version=130.0.0.0&browser_online=true&engine_name=Blink&engine_version=130.0.0.0&os_name=Windows&os_version=10&cpu_core_num=12&device_memory=8&platform=PC&downlink=10&effective_type=4g&round_trip_time=0&msToken='
check('a_bogus parity pin unchanged',
  getABogus(abParams, 'GET', { random1: 0.1, random2: 0.2, random3: 0.3, startTime: 1700000000000, endTime: 1700000000005 }) ===
  'DfmhQDgDDDDkDD6D56KLfY3q668VYmQI0SVkMD2fW-DOqL39HMYh9exoIBGvXY8jwG/-IeEjy4hbT3ohrQ2y0Hwf9W0L/25ksDSkKl5Q5xSSs1X9eghgJ04qmkt5SMx2RvB-rOXmqhZHKRbp09oHmhK4b1dzFgf3qJLzMj==')

// buildDouyinWebParams reads the cookie on ctx.
const ctx = {
  config: {
    douyin: {
      cookie: jar,
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/90.0.4430.212 Safari/537.36'
    },
    mediaR2: null,
    cache: { metaTtl: 3600 }
  }
}
const assembled = buildDouyinWebParams(ctx, { aweme_id: '7372484719365098803' })
check('buildDouyinWebParams.uifid from cookie', assembled.uifid === 'UiFidPrimaryValue')
check('buildDouyinWebParams.msToken from cookie (not empty)', assembled.msToken === 'MsTokFromJar')
check('buildDouyinWebParams.verifyFp from s_v_web_id', assembled.verifyFp === 'verify_abc_def' && assembled.fp === 'verify_abc_def')
check('buildDouyinWebParams extra keys append', assembled.aweme_id === '7372484719365098803')

const noCookie = buildDouyinWebParams({ config: { douyin: { cookie: '' } } })
check('no cookie -> empty uifid still present', noCookie.uifid === '')
check('no cookie -> generated non-empty msToken', typeof noCookie.msToken === 'string' && noCookie.msToken.length > 0)

check('redactUpstreamUrl hides uifid and msToken', (() => {
  const r = redactUpstreamUrl('https://www.douyin.com/aweme/v1/web/aweme/detail/?aweme_id=1&uifid=SECRETUIFID&msToken=SECRETMS&a_bogus=xx')
  return !r.includes('SECRETUIFID') && !r.includes('SECRETMS') && r.includes('uifid=REDACTED') && r.includes('msToken=REDACTED')
})())

// --- share-page fallback (mock fetch; no live Douyin) ---

const SHARE_ITEM = {
  aweme_id: '7372484719365098803',
  desc: 'share-ok',
  aweme_type: 4,
  video: {
    play_addr: { uri: 'x', url_list: ['https://example.invalid/v.mp4'] },
    cover: { url_list: ['https://example.invalid/c.jpg'] }
  },
  author: { nickname: 't' },
  music: {},
  statistics: {},
  text_extra: []
}
const SHARE_HTML = '<html><script>window._ROUTER_DATA = ' +
  JSON.stringify({ loaderData: { 'video_(id)/page': { videoInfoRes: { item_list: [SHARE_ITEM] } } } }) +
  '</script></html>'

const realFetch = globalThis.fetch
let detailHits = 0
let shareHits = 0
let lastDetailUrl = ''
globalThis.fetch = async (input, init) => {
  const url = String(input)
  if (url.includes('/aweme/v1/web/aweme/detail/')) {
    detailHits++
    lastDetailUrl = url
    return new Response('Blocked by ArgusSecurityPlugin Uifid Not Found', { status: 403 })
  }
  if (url.includes('/share/video/')) {
    shareHits++
    return new Response(SHARE_HTML, { status: 200, headers: { 'content-type': 'text/html' } })
  }
  return realFetch(input, init)
}

try {
  const data = await fetchOneVideo(ctx, '7372484719365098803')
  check('403 detail URL carried uifid', lastDetailUrl.includes('uifid=UiFidPrimaryValue'))
  check('403 detail URL carried cookie msToken', lastDetailUrl.includes('msToken=MsTokFromJar'))
  check('403 detail still hits share fallback', shareHits === 1 && detailHits === 1)
  check('fallback returns share aweme_detail', data?.aweme_detail?.desc === 'share-ok')
  check('error URL redacts uifid if thrown', (() => {
    // Recreate the 403 message the way fetchGetJson would if share failed.
    const sample = redactUpstreamUrl(lastDetailUrl)
    return !sample.includes('UiFidPrimaryValue') && !sample.includes('MsTokFromJar')
  })())

  const cached = await fetchDouyinDetailCached(ctx, '7372484719365098803', true)
  check('meta-cache surfaces share aweme_detail after 403', cached.data?.aweme_detail?.desc === 'share-ok' && cached.cached === false)
} finally {
  // keep mock for the "share miss rethrows" case below
}

// Share miss: still throw the original upstream 403/502, do not swallow.
detailHits = 0
shareHits = 0
globalThis.fetch = async (input, init) => {
  const url = String(input)
  if (url.includes('/aweme/v1/web/aweme/detail/')) {
    detailHits++
    return new Response('Blocked by ArgusSecurityPlugin Uifid Not Found', { status: 403 })
  }
  if (url.includes('/share/video/')) {
    shareHits++
    return new Response('<html>no router data</html>', { status: 200 })
  }
  return realFetch(input, init)
}
try {
  let threw = null
  try { await fetchOneVideo(ctx, '7372484719365098803') } catch (e) { threw = e }
  check('share miss rethrows upstream error', threw?.status === 502 && /ArgusSecurityPlugin/.test(threw.message))
  check('share miss tried both sources', detailHits === 1 && shareHits === 1)
  check('rewrapped error does not echo uifid', threw && !threw.message.includes('UiFidPrimaryValue'))
} finally {
  globalThis.fetch = realFetch
}

// Direct share parser.
globalThis.fetch = async () => new Response(SHARE_HTML, { status: 200 })
try {
  const share = await fetchShareDetail(ctx, '7372484719365098803')
  check('fetchShareDetail parses _ROUTER_DATA item', share.aweme_detail?.aweme_id === '7372484719365098803')
} finally {
  globalThis.fetch = realFetch
}

console.log(failed === 0 ? '\nAll param/fallback tests passed.' : `\n${failed} param/fallback test(s) failed.`)
process.exit(failed === 0 ? 0 : 1)
