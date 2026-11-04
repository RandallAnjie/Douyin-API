// Offline-ish e2e: drives the worker's fetch() handler directly with
// mock Requests. Network-dependent routes are exercised but tolerated
// if upstream is unreachable; routing / auth / signature-URL assembly
// are asserted strictly.
import worker from '../src/worker.js'
import { sign, canonical } from '../src/utils/auth.js'

// GUEST_ENABLED=0 so the no-token hybrid check is a deterministic 401
// (guest mode needs a D1 binding the harness doesn't have).
const env = { DOUYIN_API_TOKEN: 'secret123', DOUYIN_COOKIE: '', TIKTOK_COOKIE: '', GUEST_ENABLED: '0' }
const ctx = { waitUntil () {} }
const call = (url, init) => worker.fetch(new Request(url, init), env, ctx)

let failed = 0
const ok = (name, cond, extra = '') => {
  if (!cond) failed++
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`)
}

// 1) docs
let r = await call('https://x/')
ok('GET / -> 200 html', r.status === 200 && (r.headers.get('content-type') || '').includes('text/html'))

// 2) auth required
r = await call('https://x/api/douyin/web/fetch_one_video?aweme_id=123')
ok('no token -> 401', r.status === 401)

// 3) wrong token -> 401
r = await call('https://x/api/douyin/web/fetch_one_video?aweme_id=123&token=nope')
ok('bad token -> 401', r.status === 401)

// 4) correct HMAC auth passes auth (then hits network; we only assert
//    it's NOT a 401)
const a = sign(canonical('douyin', 'fetch_one_video', '123'), 'secret123')
r = await call(`https://x/api/douyin/web/fetch_one_video?aweme_id=123&auth=${a}`)
ok('valid HMAC -> not 401', r.status !== 401, `status=${r.status}`)

// 5) master token passes auth
r = await call('https://x/api/douyin/web/fetch_one_video?aweme_id=123&token=secret123')
ok('master token -> not 401', r.status !== 401, `status=${r.status}`)

// 6) generate_a_bogus (offline, signs a sample URL)
r = await call('https://x/api/douyin/web/generate_a_bogus?url=' + encodeURIComponent('https://www.douyin.com/aweme/v1/web/aweme/detail/?aweme_id=123&device_platform=webapp'))
let body = await r.json()
ok('generate_a_bogus -> 200 + a_bogus', r.status === 200 && typeof body.data.a_bogus === 'string' && body.data.a_bogus.length > 10, body.data?.a_bogus)

// 7) generate_x_bogus (offline)
r = await call('https://x/api/tiktok/web/generate_xbogus?url=' + encodeURIComponent('aid=1988&itemId=123'))
body = await r.json()
ok('tiktok generate_xbogus -> 200 + x_bogus', r.status === 200 && typeof body.data.x_bogus === 'string' && body.data.x_bogus.length > 5, body.data?.x_bogus)

// 8) unknown route -> 404
r = await call('https://x/api/douyin/web/nope?token=secret123')
ok('unknown route -> 404', r.status === 404)

// 9) hybrid auth required
r = await call('https://x/api/hybrid/video_data?url=https://www.douyin.com/video/123')
ok('hybrid no token -> 401', r.status === 401)

// 10) Douyin web detail: uifid + msToken go on the signed URL; a 403
//     from Argus still returns share-page aweme_detail (no 502).
const SHARE_ITEM = {
  aweme_id: '7372484719365098803',
  desc: 'share-ok',
  aweme_type: 4,
  video: { play_addr: { uri: 'x', url_list: ['https://example.invalid/v.mp4'] }, cover: { url_list: ['https://example.invalid/c.jpg'] } },
  author: { nickname: 't' },
  music: {},
  statistics: {},
  text_extra: []
}
const SHARE_HTML = '<html><script>window._ROUTER_DATA = ' +
  JSON.stringify({ loaderData: { 'video_(id)/page': { videoInfoRes: { item_list: [SHARE_ITEM] } } } }) +
  '</script></html>'
const envCookie = {
  ...env,
  DOUYIN_COOKIE: 'UIFID=UiFidE2eValue; msToken=MsTokE2eValue; s_v_web_id=verify_e2e_fp'
}
const callCookie = (url, init) => worker.fetch(new Request(url, init), envCookie, ctx)
const realFetch = globalThis.fetch
let sawUifid = false
let sawMsToken = false
let sawUifidHeader = false
let leaked = false
globalThis.fetch = async (input, init) => {
  const url = String(input)
  if (url.includes('/aweme/v1/web/aweme/detail/')) {
    sawUifid = url.includes('uifid=UiFidE2eValue')
    sawMsToken = url.includes('msToken=MsTokE2eValue')
    const hdr = (init && init.headers) || {}
    sawUifidHeader = hdr.uifid === 'UiFidE2eValue'
    return new Response('Blocked by ArgusSecurityPlugin Uifid Not Found', { status: 403 })
  }
  if (url.includes('/share/video/')) {
    return new Response(SHARE_HTML, { status: 200, headers: { 'content-type': 'text/html' } })
  }
  // Swallow other upstream calls this path may fire (comments, ttwid).
  if (/douyin\.com|bytedance\.com|iesdouyin\.com|amemv\.com/.test(url)) {
    return new Response('blocked', { status: 403 })
  }
  return realFetch(input, init)
}
try {
  r = await callCookie('https://x/api/douyin/web/fetch_one_video?aweme_id=7372484719365098803&token=secret123')
  body = await r.json()
  const bodyText = JSON.stringify(body)
  leaked = bodyText.includes('UiFidE2eValue') || bodyText.includes('MsTokE2eValue')
  ok('fetch_one_video signed URL carries uifid', sawUifid)
  ok('fetch_one_video signed URL carries msToken', sawMsToken)
  ok('fetch_one_video sends uifid header', sawUifidHeader)
  ok('fetch_one_video 403 falls back to share aweme_detail', r.status === 200 && body?.data?.aweme_detail?.desc === 'share-ok', `status=${r.status}`)
  ok('response body does not echo cookie secrets', !leaked)

  r = await callCookie('https://x/api/hybrid/video_data?url=https://www.douyin.com/video/7372484719365098803&token=secret123')
  body = await r.json()
  ok('hybrid/video_data also survives detail 403 via share', r.status === 200 && body?.data?.desc === 'share-ok', `status=${r.status}`)
} finally {
  globalThis.fetch = realFetch
}

console.log(failed === 0 ? '\nAll e2e assertions passed.' : `\n${failed} e2e assertion(s) failed.`)
process.exit(failed === 0 ? 0 : 1)
