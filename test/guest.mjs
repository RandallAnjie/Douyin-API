// Guest mode: default unlimited (limit 0, no D1/KV), optional env cap,
// and the remaining output-shape restrictions.
import { buildConfig } from '../src/config.js'
import { rateLimitHit } from '../src/utils/db.js'
import { SHORTCUT_INSTALL_URL } from '../src/service/shortcut.js'
import shareService from '../src/service/share.js'
import worker from '../src/worker.js'

let failed = 0
const ok = (name, cond, extra = '') => {
  if (!cond) failed++
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`)
}

function fakeKv () {
  const store = new Map()
  return {
    async get (k) { return store.has(k) ? store.get(k) : null },
    async put (k, v) { store.set(k, String(v)) }
  }
}

const ID = '7372484719365098803'
const TOKEN = 'secret123'
const SHARE_ITEM = {
  aweme_id: ID,
  desc: '春天的故事',
  aweme_type: 4,
  video: {
    width: 1080,
    height: 1920,
    play_addr: { uri: 'v0200shareuri', url_list: ['https://aweme.snssdk.com/aweme/v1/playwm/?video_id=v0200shareuri&line=0'] },
    cover: { url_list: ['https://example.invalid/c.jpg'] }
  },
  author: { nickname: '小明' },
  music: {},
  statistics: {},
  text_extra: []
}
const SHARE_HTML = '<html><script>window._ROUTER_DATA = ' +
  JSON.stringify({ loaderData: { 'video_(id)/page': { videoInfoRes: { item_list: [SHARE_ITEM] } } } }) +
  '</script></html>'

const realFetch = globalThis.fetch
globalThis.fetch = async (input) => {
  const u = String(input)
  if (u.includes('/share/video/')) {
    return new Response(SHARE_HTML, { status: 200, headers: { 'content-type': 'text/html' } })
  }
  if (/douyin\.com|bytedance\.com|iesdouyin\.com|amemv\.com|snssdk\.com|tiktok\.com/.test(u)) {
    return new Response('blocked', { status: 403 })
  }
  return realFetch(input)
}

try {
  const def = buildConfig({})
  ok('default guest.limit is 0', def.guest.limit === 0)
  ok('default guest.enabled is on', def.guest.enabled === true)
  ok('GUEST_RATE_LIMIT=60 wins', buildConfig({ GUEST_RATE_LIMIT: '60' }).guest.limit === 60)
  ok('GUEST_LIMIT=60 alias', buildConfig({ GUEST_LIMIT: '60' }).guest.limit === 60)
  ok('GUEST_RATE_LIMIT overrides GUEST_LIMIT', buildConfig({ GUEST_RATE_LIMIT: '10', GUEST_LIMIT: '60' }).guest.limit === 10)

  const noStore = { config: { kv: null, d1: null } }
  let rl = await rateLimitHit(noStore, '1.1.1.1', 0, 3600)
  ok('rateLimitHit limit 0 allows without store', rl.allowed === true && rl.reason !== 'no-store')
  rl = await rateLimitHit(noStore, '1.1.1.1', -1, 3600)
  ok('rateLimitHit negative limit is unlimited', rl.allowed === true)
  rl = await rateLimitHit(noStore, '1.1.1.1', 20, 3600)
  ok('rateLimitHit limit>0 without store is no-store', rl.allowed === false && rl.reason === 'no-store')

  const kvCtx = { config: { kv: fakeKv(), d1: null } }
  rl = await rateLimitHit(kvCtx, '9.9.9.9', 2, 3600)
  ok('rateLimitHit 1/2 allowed', rl.allowed === true && rl.count === 1)
  rl = await rateLimitHit(kvCtx, '9.9.9.9', 2, 3600)
  ok('rateLimitHit 2/2 allowed', rl.allowed === true && rl.count === 2)
  rl = await rateLimitHit(kvCtx, '9.9.9.9', 2, 3600)
  ok('rateLimitHit 3/2 blocked', rl.allowed === false && rl.count === 3)

  const envGuest = { DOUYIN_API_TOKEN: TOKEN }
  const ctxGuest = { config: buildConfig(envGuest), env: envGuest, waitUntil () {} }
  const shareUrl = `https://x/api/share?format=text&url=${encodeURIComponent('https://www.douyin.com/video/' + ID)}`

  const burst = []
  for (let i = 0; i < 20; i++) {
    burst.push(shareService(new Request(shareUrl), ctxGuest))
  }
  const burstRes = await Promise.all(burst)
  const burstOk = burstRes.every((r) => r.status === 200)
  const bodies = await Promise.all(burstRes.map((r) => r.text()))
  ok('20 rapid guest /api/share succeed without store',
    burstOk && bodies.every((b) => b === `https://x/work?platform=douyin&id=${ID}`),
    burstRes.map((r) => r.status).join(','))

  const envCappedNoStore = { DOUYIN_API_TOKEN: TOKEN, GUEST_RATE_LIMIT: '2' }
  const ctxCappedNoStore = { config: buildConfig(envCappedNoStore), env: envCappedNoStore, waitUntil () {} }
  let r = await shareService(new Request(shareUrl), ctxCappedNoStore)
  ok('limit>0 without store is 503', r.status === 503 && (await r.text()).includes('D1'))

  const envCapped = { DOUYIN_API_TOKEN: TOKEN, GUEST_LIMIT: '1', DOUYIN_KV: fakeKv() }
  const ctxCapped = { config: buildConfig(envCapped), env: envCapped, waitUntil () {} }
  r = await shareService(new Request(shareUrl), ctxCapped)
  ok('re-enabled limit first call 200', r.status === 200)
  r = await shareService(new Request(shareUrl), ctxCapped)
  const limitedBody = await r.text()
  ok('re-enabled limit second call 429', r.status === 429 && /限 1 次/.test(limitedBody) && r.headers.get('retry-after'))

  r = await shareService(new Request(
    `https://x/api/share?format=json&url=${encodeURIComponent('https://www.douyin.com/video/' + ID)}`
  ), ctxGuest)
  const gj = await r.json()
  const gPlay = new URLSearchParams((gj.play || '').split('?')[1] || '')
  ok('unlimited guest still gets temporary proxy links',
    r.status === 200 && gPlay.has('exp') && gPlay.get('auth') && !JSON.stringify(gj).includes(TOKEN))
  ok('unlimited guest json is not raw aweme',
    gj.play && !JSON.stringify(gj).includes('play_addr') && !JSON.stringify(gj).includes('v0200shareuri'))

  const call = (u, init, env) => worker.fetch(new Request(u, init), env || envGuest, { waitUntil () {} })
  r = await call('https://x/shortcut')
  const html = await r.text()
  ok('shortcut one-tap install is first CTA',
    r.status === 200 &&
    html.includes('一键添加快捷指令') &&
    html.includes(SHORTCUT_INSTALL_URL) &&
    html.indexOf('一键添加快捷指令') < html.indexOf('不想用现成的？手动搭建') &&
    html.indexOf('不想用现成的？手动搭建') < html.indexOf('1. 新建快捷指令'))
  ok('shortcut dropped default-limit + skip-limit token advice',
    !html.includes('可跳过游客限流') && !html.includes('游客有次数上限'))

  r = await call('https://x/docs')
  const docs = await r.text()
  ok('docs /api/share mentions one-tap shortcut install',
    docs.includes('/api/share') && docs.includes('一键添加快捷指令') && docs.includes(SHORTCUT_INSTALL_URL))
  ok('docs no longer claims guests are rate-limited by default',
    !/游客限流且不返回/.test(docs) && docs.includes('默认不限流'))

  r = await call(
    'https://x/api/hybrid/video_data?url=' + encodeURIComponent('https://www.douyin.com/video/' + ID)
  )
  const hy = await r.json()
  ok('hybrid guest without store is not 503', r.status !== 503, `status=${r.status}`)
  ok('hybrid guest is forced minimal+proxy',
    r.status === 200 && hy.params?.guest === true && hy.params?.minimal === true && hy.params?.proxy === true)
  ok('hybrid guest has no refresh and no raw aweme',
    hy.params?.refresh !== true && !JSON.stringify(hy).includes('v0200shareuri'))
} finally {
  globalThis.fetch = realFetch
}

console.log(failed === 0 ? '\nAll guest assertions passed.' : `\n${failed} guest assertion(s) failed.`)
process.exit(failed === 0 ? 0 : 1)
