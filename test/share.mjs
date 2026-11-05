// URL extraction from Douyin/TikTok share-sheet text, plus /api/share
// output formats. Network is mocked — no live upstream.
import { sign, canonical } from '../src/utils/auth.js'
import { buildConfig } from '../src/config.js'
import shareService, {
  extractShareUrl,
  normalizeShareText,
  formatShareMessage,
  buildWorkLink,
  raceOrTimeout,
  readShareInput
} from '../src/service/share.js'
import worker from '../src/worker.js'

let failed = 0
const ok = (name, cond, extra = '') => {
  if (!cond) failed++
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`)
}

// --- extractShareUrl ---

ok('realistic Douyin share text',
  extractShareUrl('3.05 复制打开抖音，看看【xxx的作品】长按复制此条消息。 https://v.douyin.com/AbCdEf/ F@a.Bc 05/12') ===
  'https://v.douyin.com/AbCdEf/')

ok('trailing ASCII punctuation',
  extractShareUrl('看这个 https://v.douyin.com/AbCdEf/.') === 'https://v.douyin.com/AbCdEf/')

ok('trailing fullwidth ideographic period',
  extractShareUrl('看这个 https://v.douyin.com/AbCdEf/。') === 'https://v.douyin.com/AbCdEf/')

ok('wrapped in Chinese brackets',
  extractShareUrl('口令【https://v.douyin.com/AbCdEf/】结尾') === 'https://v.douyin.com/AbCdEf/')

ok('fullwidth slashes in scheme',
  extractShareUrl('https：／／v.douyin.com／AbCdEf／') === 'https://v.douyin.com/AbCdEf/')

ok('normalizeShareText maps fullwidth ASCII',
  normalizeShareText('https：／／v.douyin.com') === 'https://v.douyin.com')

ok('first of multiple links (tiktok then douyin)',
  extractShareUrl('先看 https://www.tiktok.com/@a/video/111 再看 https://v.douyin.com/AbCdEf/') ===
  'https://www.tiktok.com/@a/video/111')

ok('tiktok web video url',
  extractShareUrl('wow https://www.tiktok.com/@foo/video/7234567890123456789?is_copy_url=1') ===
  'https://www.tiktok.com/@foo/video/7234567890123456789?is_copy_url=1')

ok('iesdouyin share url',
  extractShareUrl('https://www.iesdouyin.com/share/video/7372484719365098803/') ===
  'https://www.iesdouyin.com/share/video/7372484719365098803/')

ok('no url returns null', extractShareUrl('复制打开抖音，看看【xxx的作品】') === null)
ok('empty / non-string', extractShareUrl('') === null && extractShareUrl(null) === null)

ok('formatShareMessage title+author',
  formatShareMessage('你好', '小明', 'https://x/work?platform=douyin&id=1') ===
  '你好 - @小明\nhttps://x/work?platform=douyin&id=1')
ok('formatShareMessage title only',
  formatShareMessage('你好', '', 'https://x/w') === '你好\nhttps://x/w')
ok('formatShareMessage fallback link',
  formatShareMessage('', '', 'https://x/w') === 'https://x/w')

const baseReq = new Request('https://douyin.rapi.rest/api/share')
const baseCtx = { config: buildConfig({ DOUYIN_API_TOKEN: 'secret123' }) }
ok('buildWorkLink uses request host',
  buildWorkLink(baseReq, baseCtx, 'douyin', '7372484719365098803') ===
  'https://douyin.rapi.rest/work?platform=douyin&id=7372484719365098803')

const raced = await raceOrTimeout(new Promise((resolve) => setTimeout(() => resolve('late'), 80)), 15)
ok('raceOrTimeout falls back', raced === undefined)
ok('raceOrTimeout resolves winner', (await raceOrTimeout(Promise.resolve('now'), 80)) === 'now')

const formReq = new Request('https://x/api/share', {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ text: 'hello https://v.douyin.com/Zz/' }).toString()
})
ok('readShareInput form text', (await readShareInput(formReq)) === 'hello https://v.douyin.com/Zz/')

const rawReq = new Request('https://x/api/share?format=text', {
  method: 'POST',
  headers: { 'content-type': 'text/plain; charset=utf-8' },
  body: '3.05 复制打开抖音 https://v.douyin.com/Zz/ F@a.Bc'
})
ok('readShareInput raw POST body', /v\.douyin\.com\/Zz\//.test(await readShareInput(rawReq)))

const qReq = new Request('https://x/api/share?url=https://www.douyin.com/video/1&text=https://www.tiktok.com/@a/video/2')
ok('readShareInput prefers text over url', (await readShareInput(qReq)) === 'https://www.tiktok.com/@a/video/2')

// --- service formats (mock upstream) ---

const ID = '7372484719365098803'
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

function fakeKv () {
  const store = new Map()
  return {
    async get (k) { return store.has(k) ? store.get(k) : null },
    async put (k, v) { store.set(k, String(v)) }
  }
}

const TOKEN = 'secret123'
const envAuthed = { DOUYIN_API_TOKEN: TOKEN, GUEST_ENABLED: '0' }
const ctxAuthed = { config: buildConfig(envAuthed), env: envAuthed, waitUntil () {} }

const envGuest = { DOUYIN_API_TOKEN: TOKEN, DOUYIN_KV: fakeKv() }
const ctxGuest = { config: buildConfig(envGuest), env: envGuest, waitUntil () {} }

const envNoStore = { DOUYIN_API_TOKEN: TOKEN }
const ctxNoStore = { config: buildConfig(envNoStore), env: envNoStore, waitUntil () {} }

const SHARE_TEXT = `3.05 复制打开抖音，看看【xxx的作品】 https://www.douyin.com/video/${ID}/ F@a.Bc 05/12`
const TIKTOK_URL = 'https://www.tiktok.com/@foo/video/7234567890123456789'

try {
  let r = await shareService(new Request('https://douyin.rapi.rest/api/share?format=text&token=' + TOKEN +
    '&url=' + encodeURIComponent(`https://www.douyin.com/video/${ID}`)), ctxAuthed)
  let body = await r.text()
  ok('format=text is text/plain', r.status === 200 && (r.headers.get('content-type') || '').includes('text/plain'))
  ok('format=text is just the work link',
    body === `https://douyin.rapi.rest/work?platform=douyin&id=${ID}`, body)

  r = await shareService(new Request('https://douyin.rapi.rest/api/share?format=text&text_full=1&token=' + TOKEN, {
    method: 'POST',
    headers: { 'content-type': 'text/plain; charset=utf-8' },
    body: SHARE_TEXT
  }), ctxAuthed)
  body = await r.text()
  ok('text_full uses title and author',
    body === `春天的故事 - @小明\nhttps://douyin.rapi.rest/work?platform=douyin&id=${ID}`, body)

  r = await shareService(new Request('https://douyin.rapi.rest/api/share?format=json&token=' + TOKEN +
    '&url=' + encodeURIComponent(`https://www.douyin.com/video/${ID}`)), ctxAuthed)
  const j = await r.json()
  const expectedAuth = sign(canonical('proxy', 'douyin', ID), TOKEN)
  ok('format=json envelope', r.status === 200 && j.code === 200 && j.platform === 'douyin' && j.id === ID)
  ok('format=json link', j.link === `https://douyin.rapi.rest/work?platform=douyin&id=${ID}`)
  ok('format=json title/author from ingest', j.title === '春天的故事' && j.author === '小明')
  ok('format=json play is hot-style /proxy nwm',
    typeof j.play === 'string' && j.play.startsWith('/proxy?') && j.play.includes('kind=nwm'))
  const playParams = new URLSearchParams(j.play.split('?')[1])
  ok('format=json play HMAC, no token', playParams.get('auth') === expectedAuth && !playParams.has('token') && !j.play.includes(TOKEN))
  ok('format=json cover is /proxy cover', j.cover.startsWith('/proxy?') && j.cover.includes('kind=cover'))
  ok('format=json download has download=1', /download=1/.test(j.download) && j.download.startsWith('/proxy?'))
  ok('format=json has no raw aweme', !JSON.stringify(j).includes('v0200shareuri') && !JSON.stringify(j).includes(TOKEN))

  r = await shareService(new Request('https://douyin.rapi.rest/api/share?format=redirect&token=' + TOKEN +
    '&url=' + encodeURIComponent(`https://www.douyin.com/video/${ID}`)), ctxAuthed)
  ok('format=redirect 302', r.status === 302)
  ok('format=redirect Location', r.headers.get('location') === `https://douyin.rapi.rest/work?platform=douyin&id=${ID}`)

  r = await shareService(new Request('https://x/api/share?format=text&token=' + TOKEN +
    '&text=' + encodeURIComponent(TIKTOK_URL)), ctxAuthed)
  body = await r.text()
  ok('tiktok url -> work link',
    body === 'https://x/work?platform=tiktok&id=7234567890123456789', body)

  r = await shareService(new Request('https://x/api/share?format=text&token=' + TOKEN + '&text=没有链接只是中文'), ctxAuthed)
  body = await r.text()
  ok('no link is 400 Chinese text', r.status === 400 && body.includes('未找到分享链接') &&
    (r.headers.get('content-type') || '').includes('text/plain'))

  r = await shareService(new Request('https://x/api/share?format=json&token=' + TOKEN + '&text=没有链接'), ctxAuthed)
  const errJ = await r.json()
  ok('no link json error', r.status === 400 && errJ.code === 400 && /未找到分享链接/.test(errJ.message))

  r = await shareService(new Request('https://x/api/share?format=text&url=' + encodeURIComponent(`https://www.douyin.com/video/${ID}`)), ctxAuthed)
  ok('GUEST_ENABLED=0 without token is 401 text', r.status === 401 && (await r.text()).includes('未授权'))

  r = await shareService(new Request('https://x/api/share?format=json&url=' + encodeURIComponent(`https://www.douyin.com/video/${ID}`)), ctxNoStore)
  const noStore = await r.json()
  ok('guest without store is 503 json', r.status === 503 && noStore.code === 503)

  r = await shareService(new Request('https://x/api/share?format=text&url=' + encodeURIComponent(`https://www.douyin.com/video/${ID}`)), ctxGuest)
  body = await r.text()
  ok('guest format=text works', r.status === 200 && body === `https://x/work?platform=douyin&id=${ID}`, body)

  r = await shareService(new Request('https://x/api/share?format=json&url=' + encodeURIComponent(`https://www.douyin.com/video/${ID}`)), ctxGuest)
  const gj = await r.json()
  const gPlay = new URLSearchParams((gj.play || '').split('?')[1] || '')
  ok('guest json play is temporary HMAC', r.status === 200 && gPlay.has('exp') && gPlay.get('auth') && !JSON.stringify(gj).includes(TOKEN))
  ok('guest json is not raw aweme', gj.play && !JSON.stringify(gj).includes('play_addr') && !JSON.stringify(gj).includes('v0200shareuri'))

  const form = new URLSearchParams({ url: `https://www.iesdouyin.com/share/video/${ID}/` })
  r = await shareService(new Request('https://x/api/share?format=text&token=' + TOKEN, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: form.toString()
  }), ctxAuthed)
  ok('POST form url', r.status === 200 && (await r.text()) === `https://x/work?platform=douyin&id=${ID}`)

  // Worker wiring + CORS
  const call = (u, init) => worker.fetch(new Request(u, init), envAuthed, { waitUntil () {} })
  r = await call('https://x/shortcut')
  const html = await r.text()
  ok('GET /shortcut is html', r.status === 200 && (r.headers.get('content-type') || '').includes('text/html'))
  ok('shortcut guide has 5 steps and Douyin trigger',
    html.includes('抖音转分享链接') && html.includes('获取输入的文本') && html.includes('获取 URL 内容') &&
    html.includes('/api/share?format=text&text_full=1') && html.includes('分享') && html.includes('轻点背面'))
  ok('shortcut CORS open', r.headers.get('access-control-allow-origin') === '*')

  r = await call('https://x/api/share?format=text&token=' + TOKEN + '&url=' + encodeURIComponent(`https://www.douyin.com/video/${ID}`))
  ok('worker GET /api/share', r.status === 200 && (await r.text()).includes(`/work?platform=douyin&id=${ID}`))
} finally {
  globalThis.fetch = realFetch
}

console.log(failed === 0 ? '\nAll share assertions passed.' : `\n${failed} share assertion(s) failed.`)
process.exit(failed === 0 ? 0 : 1)
