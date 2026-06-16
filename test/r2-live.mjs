// Live R2 cache + /proxy test (hits Douyin + a fake in-memory R2). Run: node test/r2-live.mjs
import worker from '../src/worker.js'
class FakeR2 {
  constructor(){ this.store=new Map() }
  async head(k){ const v=this.store.get(k); return v? {size:v.body.length, httpMetadata:{contentType:v.ct}, uploaded:v.uploaded}:null }
  async get(k,opts){ const v=this.store.get(k); if(!v) return null; let body=v.body; if(opts?.range){ body=v.body.slice(opts.range.offset, opts.range.offset+opts.range.length) } return { body:new Response(body).body, uploaded:v.uploaded, async text(){return new TextDecoder().decode(v.body)} } }
  async put(k,val,opts){ let b; if(typeof val==='string') b=new TextEncoder().encode(val); else if(val instanceof Uint8Array) b=val; else b=new Uint8Array(await new Response(val).arrayBuffer()); this.store.set(k,{body:b, ct:opts?.httpMetadata?.contentType, uploaded:new Date()}) }
}
const bucket=new FakeR2()
const env={DOUYIN_API_TOKEN:'t', DOUYIN_R2:bucket}
const pending=[]
const ctx={ waitUntil(p){ pending.push(p) } }
const flush=async()=>{ while(pending.length){ await pending.shift() } }
const call=(u)=>worker.fetch(new Request(u), env, ctx)
const id='7372484719365098803'
let fail=0; const ok=(n,c,x='')=>{ if(!c)fail++; console.log(`${c?'PASS':'FAIL'}  ${n}${x?' — '+x:''}`) }

// 1) fetch_one_video miss then hit
let r=await call(`https://x/api/douyin/web/fetch_one_video?aweme_id=${id}&token=t`)
ok('fetch_one_video #1 miss', r.headers.get('x-cache')==='miss', 'x-cache='+r.headers.get('x-cache'))
await flush()
ok('meta json stored in R2', bucket.store.has(`meta/douyin/${id}.json`))
r=await call(`https://x/api/douyin/web/fetch_one_video?aweme_id=${id}&token=t`)
ok('fetch_one_video #2 hit', r.headers.get('x-cache')==='hit', 'x-cache='+r.headers.get('x-cache'))

// 2) video_data proxy=1 rewrite
r=await call(`https://x/api/hybrid/video_data?minimal=true&proxy=1&token=t&url=${encodeURIComponent('https://www.douyin.com/video/'+id)}`)
let j=await r.json()
const nwm=j.data?.video_data?.nwm_video_url||''
ok('video_data proxy rewrite -> /proxy link', nwm.includes('/proxy?') && nwm.includes('auth='), nwm.slice(0,90))

// 3) proxy auth required
r=await call(`https://x/proxy?platform=douyin&id=${id}&kind=cover`)
ok('proxy no auth -> 401', r.status===401)

// 4) proxy cover: miss streams + caches, then hit from r2
const auth=new URL(nwm).searchParams.get('auth') // same canonical proxy+douyin+id
r=await call(`https://x/proxy?platform=douyin&id=${id}&kind=cover&auth=${auth}`)
ok('proxy cover #1 -> 200', r.status===200, 'src='+r.headers.get('x-cache-source')+' ct='+r.headers.get('content-type'))
await r.arrayBuffer(); await flush()
ok('media bytes cached in R2', bucket.store.has(`media/douyin/${id}/cover`))
r=await call(`https://x/proxy?platform=douyin&id=${id}&kind=cover&auth=${auth}`)
ok('proxy cover #2 -> r2 hit', r.headers.get('x-cache-source')==='r2', 'src='+r.headers.get('x-cache-source'))

console.log(fail===0?'\nALL R2 TESTS PASSED':`\n${fail} FAILED`)
process.exit(fail?1:0)
