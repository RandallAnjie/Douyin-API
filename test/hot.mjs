// Hot board: play URLs carry a per-resource HMAC that /proxy accepts,
// never the master token. Bounded nwm warm for the top board videos.
import worker from '../src/worker.js'
import { sign, canonical } from '../src/utils/auth.js'
import { decorateHotBoard, scheduleHotNwmWarm, HOT_NWM_WARM_TOP, HOT_NWM_WARM_CONCURRENCY } from '../src/service/hot.js'
import { buildConfig } from '../src/config.js'
import { mediaKey } from '../src/utils/r2cache.js'

const ID = '7372484719365098803'
const TOKEN = 'secret123'

function fakeD1 (kv = {}) {
  return {
    prepare (sql) {
      return {
        bind (...args) {
          return {
            async all () {
              if (/SELECT v, ts FROM kv_meta/.test(sql)) {
                const row = kv[args[0]]
                return { results: row ? [row] : [] }
              }
              return { results: [] }
            },
            async run () {
              if (/INSERT INTO kv_meta/.test(sql)) kv[args[0]] = { v: args[1], ts: args[2] }
              return { success: true }
            }
          }
        },
        async all () { return { results: [] } },
        async run () { return { success: true } }
      }
    }
  }
}

class FakeR2 {
  constructor () { this.store = new Map(); this.puts = [] }
  async head (k) {
    const v = this.store.get(k)
    return v ? { size: v.body.length, httpMetadata: { contentType: v.ct } } : null
  }
  async put (k, val, opts) {
    let b
    if (val instanceof Uint8Array) b = val
    else b = new Uint8Array(await new Response(val).arrayBuffer())
    this.store.set(k, { body: b, ct: opts?.httpMetadata?.contentType })
    this.puts.push(k)
  }
}

let failed = 0
const ok = (name, cond, extra = '') => {
  if (!cond) failed++
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`)
}

const board = {
  videos: [
    { id: ID, desc: 'hot vid', author: 'a', cover: 'https://p.example/c.jpg', digg: 9, type: 'video', width: 1080, height: 1920 },
    { id: 'img1', desc: 'pics', author: 'b', cover: 'https://p.example/i.jpg', digg: 1, type: 'image' }
  ],
  search: [{ rank: 1, word: 'foo', cover: 'https://p.example/s.jpg' }],
  music: [{ rank: 1, id: 'm1', title: 'song', cover: 'https://p.example/m.jpg' }]
}

const ctx = { config: buildConfig({ DOUYIN_API_TOKEN: TOKEN }) }
const req = new Request('https://x/api/douyin/hot')
const decorated = decorateHotBoard(req, ctx, board)
const vid = decorated.videos[0]
const expected = sign(canonical('proxy', 'douyin', ID), TOKEN)
ok('hot video play is /proxy nwm', typeof vid.play === 'string' && vid.play.startsWith('/proxy?') && vid.play.includes('kind=nwm'))
const playParams = new URLSearchParams(vid.play.split('?')[1])
ok('hot play HMAC is per-resource', playParams.get('auth') === expected)
ok('hot play has no token', !playParams.has('token') && !vid.play.includes(TOKEN))
ok('hot play keeps width/height', vid.width === 1080 && vid.height === 1920)
ok('hot image has no play', decorated.videos[1].play == null)
ok('hot search/music do not get a video play url', decorated.search[0].play == null && decorated.music[0].play == null)
ok('decorate does not leak master token', !JSON.stringify(decorated).includes(TOKEN))

const env = {
  DOUYIN_API_TOKEN: TOKEN,
  DOUYIN_COOKIE: '',
  TIKTOK_COOKIE: '',
  GUEST_ENABLED: '0',
  DOUYIN_D1: fakeD1({ 'hot:douyin:board': { v: JSON.stringify(board), ts: 1700000000000 } })
}
const wctx = { waitUntil () {} }
const r = await worker.fetch(new Request('https://x/api/douyin/hot'), env, wctx)
const body = await r.json()
ok('hot API 200', r.status === 200 && body.code === 200)
ok('hot API video has play', body.videos?.[0]?.play && body.videos[0].play.includes('auth='))
ok('hot API body has no master token', !JSON.stringify(body).includes(TOKEN))
const auth = new URLSearchParams(body.videos[0].play.split('?')[1]).get('auth')
ok('hot API HMAC valid', auth === expected)

const proxy = await worker.fetch(new Request('https://x' + body.videos[0].play), env, wctx)
ok('hot play auth accepted by /proxy', proxy.status !== 401, `status=${proxy.status}`)
try { await proxy.arrayBuffer() } catch {}

const html = await (await worker.fetch(new Request('https://x/hot'), env, wctx)).text()
ok('hot page loads shared ui.js', html.includes('src="/ui.js"'))
ok('hot page does not await parse before play', !html.includes('解析并入库中'))
ok('hot page opens lightbox then ingests', html.includes('onVideoClick') && html.includes('DT.ingest') && html.includes('lb.open'))

const ui = await (await worker.fetch(new Request('https://x/ui.js'), env, wctx)).text()
ok('GET /ui.js is the client module', ui.includes('mountPlayer') && ui.includes('clickToPlay') && ui.includes('playerTransition'))

// Bounded nwm warm: skip images, cap at TOP, concurrency <= 2.
{
  const realFetch = globalThis.fetch
  let inflight = 0
  let maxInflight = 0
  const warmed = []
  globalThis.fetch = async (input) => {
    inflight++
    maxInflight = Math.max(maxInflight, inflight)
    warmed.push(String(input))
    await new Promise((resolve) => setTimeout(resolve, 15))
    inflight--
    return new Response(new Uint8Array(2048), { status: 200, headers: { 'content-type': 'video/mp4' } })
  }
  try {
    const feed = Array.from({ length: 15 }, (_, i) => ({
      aweme_id: 'id' + i,
      aweme_type: i === 0 ? 2 : 4,
      images: i === 0 ? [{}] : undefined,
      video: {
        width: 720,
        height: 1280,
        play_addr: { uri: 'u' + i, url_list: ['https://cdn.example/' + i + '.mp4'] }
      }
    }))
    const bucket = new FakeR2()
    const warmCtx = { config: buildConfig({ DOUYIN_API_TOKEN: TOKEN, DOUYIN_R2: bucket }) }
    await scheduleHotNwmWarm(warmCtx, feed)
    ok('warm skips image and caps at top N', warmed.length === HOT_NWM_WARM_TOP, `n=${warmed.length}`)
    ok('warm concurrency is capped', maxInflight <= HOT_NWM_WARM_CONCURRENCY, `max=${maxInflight}`)
    ok('warm used nwm keys', bucket.puts.every((k) => k.includes('/nwm')), bucket.puts[0] || '')
    ok('warm first video is id1 not image id0', bucket.puts[0] === mediaKey('douyin', 'id1', 'nwm'), bucket.puts[0])
  } finally {
    globalThis.fetch = realFetch
  }
}

console.log(failed === 0 ? '\nAll hot tests passed.' : `\n${failed} hot test(s) failed.`)
process.exit(failed === 0 ? 0 : 1)
