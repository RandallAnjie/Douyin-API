// Offline /proxy streaming contract: first byte is not held for a full
// body buffer; Range returns 206; download=1 still sets Content-Disposition.
import worker from '../src/worker.js'
import { sign, canonical } from '../src/utils/auth.js'
import { serveFromR2 } from '../src/utils/r2cache.js'

const ID = '7372484719365098803'
const SHARE_ITEM = {
  aweme_id: ID,
  desc: 'stream-ok',
  aweme_type: 4,
  video: {
    width: 1920,
    height: 1080,
    play_addr: { uri: 'v0200shareuri', url_list: ['https://aweme.snssdk.com/aweme/v1/playwm/?video_id=v0200shareuri&line=0'] },
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

const env = {
  DOUYIN_API_TOKEN: 'secret123',
  DOUYIN_COOKIE: 'UIFID=UiFidStream; msToken=MsTokStream; s_v_web_id=verify_stream',
  TIKTOK_COOKIE: '',
  GUEST_ENABLED: '0'
}
const pending = []
const ctx = { waitUntil (p) { pending.push(p) } }
const auth = sign(canonical('proxy', 'douyin', ID), 'secret123')
const playUrl = (extra = '') =>
  `https://x/proxy?platform=douyin&id=${ID}&kind=nwm&auth=${auth}${extra}`

let failed = 0
const ok = (name, cond, extra = '') => {
  if (!cond) failed++
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`)
}

const realFetch = globalThis.fetch
const urlOf = (input) => String(input && input.url ? input.url : input)
const rangeOf = (init) => {
  const h = (init && init.headers) || {}
  if (typeof h.get === 'function') return h.get('range') || ''
  return h.range || h.Range || ''
}

function mockUpstream (playFactory) {
  globalThis.fetch = async (input, init) => {
    const url = urlOf(input)
    if (url.includes('/aweme/v1/web/aweme/detail/')) {
      return new Response('Blocked by ArgusSecurityPlugin Uifid Not Found', { status: 403 })
    }
    if (url.includes('/share/video/')) {
      return new Response(SHARE_HTML, { status: 200, headers: { 'content-type': 'text/html' } })
    }
    if (url.includes('/aweme/v1/play')) {
      return playFactory(url, rangeOf(init))
    }
    if (/douyin\.com|bytedance\.com|iesdouyin\.com|amemv\.com|snssdk\.com/.test(url)) {
      return new Response('blocked', { status: 403 })
    }
    return realFetch(input, init)
  }
}

async function drainPending () {
  const jobs = pending.splice(0, pending.length)
  await Promise.race([
    Promise.all(jobs.map((p) => Promise.resolve(p).catch(() => {}))),
    new Promise((resolve) => setTimeout(resolve, 1000))
  ])
}

// (a) hung upstream: headers + first chunk arrive before the rest of the body.
{
  let restReleased = false
  let releaseRest
  const restGate = new Promise((resolve) => { releaseRest = resolve })
  const firstChunk = new Uint8Array(16).fill(7)
  mockUpstream((_url, _range) => {
    const body = new ReadableStream({
      async start (controller) {
        controller.enqueue(firstChunk)
        await restGate
        controller.enqueue(new Uint8Array(12000).fill(9))
        controller.close()
      }
    })
    return new Response(body, {
      status: 200,
      headers: {
        'content-type': 'application/octet-stream',
        'content-length': '12016',
        'content-encoding': 'identity'
      }
    })
  })
  try {
    const started = Date.now()
    const p = worker.fetch(new Request(playUrl()), env, ctx)
    const raced = await Promise.race([
      p.then((resp) => ({ kind: 'resp', resp })),
      new Promise((resolve) => setTimeout(() => resolve({ kind: 'timeout' }), 400))
    ])
    ok('nwm play returns before upstream finishes', raced.kind === 'resp', `kind=${raced.kind} ms=${Date.now() - started}`)
    const r = raced.resp
    if (r) {
      ok('nwm play is 200', r.status === 200, `status=${r.status}`)
      ok('nwm play Accept-Ranges bytes', r.headers.get('accept-ranges') === 'bytes')
      ok('nwm play Content-Type video/mp4', r.headers.get('content-type') === 'video/mp4', r.headers.get('content-type'))
      ok('nwm play Content-Length known', r.headers.get('content-length') === '12016')
      ok('nwm play no Content-Encoding', !r.headers.get('content-encoding'))
      ok('nwm play is not full-body buffer', r.headers.get('x-cache-source') !== 'upstream-buffer', r.headers.get('x-cache-source'))
      ok('nwm play has no Content-Disposition', !r.headers.get('content-disposition'))
      const reader = r.body.getReader()
      const first = await reader.read()
      ok('nwm play first chunk before rest', !restReleased && first.value && first.value.byteLength > 0, `len=${first.value?.byteLength}`)
      restReleased = true
      releaseRest()
      try { await reader.cancel() } catch {}
    }
  } finally {
    if (!restReleased) { restReleased = true; releaseRest() }
    globalThis.fetch = realFetch
    await drainPending()
  }
}

// Same first-byte contract on the R2 tee path (cache write must not hold the user).
{
  class FakeR2 {
    constructor () { this.store = new Map() }
    async head (k) {
      const v = this.store.get(k)
      return v ? { size: v.body.length, httpMetadata: { contentType: v.ct }, uploaded: v.uploaded } : null
    }
    async get (k, opts) {
      const v = this.store.get(k)
      if (!v) return null
      let body = v.body
      if (opts?.range) body = v.body.slice(opts.range.offset, opts.range.offset + opts.range.length)
      return { body: new Response(body).body, uploaded: v.uploaded, async text () { return new TextDecoder().decode(v.body) } }
    }
    async put (k, val, opts) {
      let b
      if (typeof val === 'string') b = new TextEncoder().encode(val)
      else if (val instanceof Uint8Array) b = val
      else b = new Uint8Array(await new Response(val).arrayBuffer())
      this.store.set(k, { body: b, ct: opts?.httpMetadata?.contentType, uploaded: new Date() })
    }
  }
  const bucket = new FakeR2()
  const envR2 = { ...env, DOUYIN_R2: bucket }
  let released = false
  let releaseRest
  const restGate = new Promise((resolve) => { releaseRest = resolve })
  const release = () => { if (!released) { released = true; releaseRest() } }
  mockUpstream(() => {
    const body = new ReadableStream({
      async start (controller) {
        controller.enqueue(new Uint8Array(16).fill(3))
        await restGate
        controller.enqueue(new Uint8Array(12000).fill(4))
        controller.close()
      }
    })
    return new Response(body, {
      status: 200,
      headers: { 'content-type': 'video/mp4', 'content-length': '12016' }
    })
  })
  try {
    const p = worker.fetch(new Request(playUrl()), envR2, ctx)
    const raced = await Promise.race([
      p.then((resp) => ({ kind: 'resp', resp })),
      new Promise((resolve) => setTimeout(() => resolve({ kind: 'timeout' }), 400))
    ])
    ok('R2 tee play returns before upstream finishes', raced.kind === 'resp', `kind=${raced.kind}`)
    if (raced.resp) {
      ok('R2 tee source is not buffer', raced.resp.headers.get('x-cache-source') === 'upstream-tee', raced.resp.headers.get('x-cache-source'))
      const reader = raced.resp.body.getReader()
      const first = await reader.read()
      ok('R2 tee first chunk arrives', first.value && first.value.byteLength > 0)
      release()
      try { await reader.cancel() } catch {}
    }
  } finally {
    release()
    globalThis.fetch = realFetch
    await drainPending()
  }
}

// (b) Range miss: 206 + Content-Range when total size is known.
{
  const TOTAL = 24000
  mockUpstream((_url, range) => {
    const m = String(range || '').trim().match(/^bytes=(\d+)-(\d*)$/i)
    if (!m) {
      return new Response(new Uint8Array(TOTAL).fill(1), {
        status: 200,
        headers: { 'content-type': 'video/mp4', 'content-length': String(TOTAL) }
      })
    }
    const start = Number(m[1])
    const end = m[2] === '' ? TOTAL - 1 : Number(m[2])
    const len = end - start + 1
    return new Response(new Uint8Array(len).fill(1), {
      status: 206,
      headers: {
        'content-type': 'video/mp4',
        'content-length': String(len),
        'content-range': `bytes ${start}-${end}/${TOTAL}`,
        'accept-ranges': 'bytes'
      }
    })
  })
  try {
    const r = await worker.fetch(new Request(playUrl(), { headers: { Range: 'bytes=1000-1999' } }), env, ctx)
    const cr = r.headers.get('content-range') || ''
    ok('range miss is 206', r.status === 206, `status=${r.status}`)
    ok('range miss Content-Range', cr === 'bytes 1000-1999/24000', cr)
    ok('range miss Accept-Ranges', r.headers.get('accept-ranges') === 'bytes')
    ok('range miss Content-Length is slice', r.headers.get('content-length') === '1000')
    ok('range miss Content-Type video/mp4', r.headers.get('content-type') === 'video/mp4')
    ok('range miss source upstream-range', r.headers.get('x-cache-source') === 'upstream-range', r.headers.get('x-cache-source'))
    await r.arrayBuffer()
  } finally {
    globalThis.fetch = realFetch
    await drainPending()
  }
}

// R2 hit still answers Range with 206 (warm cache path).
{
  class FakeR2 {
    constructor () { this.store = new Map() }
    async head (k) {
      const v = this.store.get(k)
      return v ? { size: v.body.length, httpMetadata: { contentType: v.ct }, uploaded: v.uploaded } : null
    }
    async get (k, opts) {
      const v = this.store.get(k)
      if (!v) return null
      let body = v.body
      if (opts?.range) body = v.body.slice(opts.range.offset, opts.range.offset + opts.range.length)
      return { body: new Response(body).body, uploaded: v.uploaded }
    }
    async put (k, val, opts) {
      let b
      if (val instanceof Uint8Array) b = val
      else b = new Uint8Array(await new Response(val).arrayBuffer())
      this.store.set(k, { body: b, ct: opts?.httpMetadata?.contentType, uploaded: new Date() })
    }
  }
  const bucket = new FakeR2()
  const key = 'media/v2/douyin/' + encodeURIComponent(ID) + '/nwm'
  const bytes = new Uint8Array(24000).fill(5)
  await bucket.put(key, bytes, { httpMetadata: { contentType: 'video/mp4' } })
  const hit = await serveFromR2(bucket, new Request('https://x/proxy', { headers: { Range: 'bytes=100-199' } }), key, 'video/mp4', 10000)
  ok('R2 range hit is 206', hit && hit.status === 206, hit && String(hit.status))
  ok('R2 range hit Content-Range', hit && hit.headers.get('content-range') === 'bytes 100-199/24000', hit && hit.headers.get('content-range'))
  ok('R2 range hit source r2', hit && hit.headers.get('x-cache-source') === 'r2')
  if (hit) await hit.arrayBuffer()
}

// (c) download=1 still sets Content-Disposition (and may stream).
{
  const playMp4 = new Uint8Array(12000).fill(1)
  mockUpstream(() => new Response(playMp4, {
    status: 200,
    headers: { 'content-type': 'video/mp4', 'content-length': String(playMp4.length) }
  }))
  try {
    const r = await worker.fetch(new Request(playUrl('&download=1')), env, ctx)
    const disp = r.headers.get('content-disposition') || ''
    ok('download=1 is 200', r.status === 200, `status=${r.status}`)
    ok('download=1 sets attachment', /attachment/.test(disp), disp)
    ok('download=1 filename uses id', disp.includes(ID) && /\.mp4/.test(disp), disp)
    ok('download=1 still streams (no buffer source)', r.headers.get('x-cache-source') !== 'upstream-buffer', r.headers.get('x-cache-source'))
    await r.arrayBuffer()
  } finally {
    globalThis.fetch = realFetch
    await drainPending()
  }
}

console.log(failed === 0 ? '\nAll proxy-stream assertions passed.' : `\n${failed} proxy-stream assertion(s) failed.`)
process.exit(failed === 0 ? 0 : 1)
