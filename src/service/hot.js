// Public 抖音热榜 — 热搜榜 (trending search words) + 热歌榜 (trending music),
// pulled from the app-domain ranking endpoints (unsigned). Cached 5min in
// kv_meta so we don't hammer upstream. Words/songs deep-link into our own
// /search index (the aggregation play: a hot list is a way INTO the library,
// not just a mirror of Douyin's).
import { rawJsonResponse } from '../utils/respond.js'
import { metaGet, metaSet } from '../utils/db.js'
import { imgProxyLink } from '../utils/proxy-link.js'
import * as douyinApp from '../douyin/app/crawler.js'

const CACHE_TTL = 5 * 60 * 1000
const CACHE_KEY = 'hot:douyin:board'

function pickCover (obj) {
  const c = obj?.cover_large || obj?.cover_hd || obj?.cover_medium || obj?.word_cover || obj?.cover_thumb
  return c?.url_list?.[0] || null
}

async function buildBoard (ctx) {
  const [words, music] = await Promise.all([
    douyinApp.fetchHotSearchBoard(ctx).catch(() => []),
    douyinApp.fetchHotMusicBoard(ctx, 50).catch(() => [])
  ])
  const search = words.map((w, i) => ({
    rank: i + 1,
    word: w.word || '',
    hot_value: w.hot_value || 0,
    view_count: w.view_count || 0,
    video_count: w.video_count || 0,
    // label: 1=新 3=热 ...; surface the raw code, the page maps known ones.
    label: w.label || 0,
    cover: pickCover(w)
  })).filter(x => x.word)
  const songs = music.map((m, i) => {
    const mi = m.music_info || m
    return {
      rank: i + 1,
      id: String(mi.id_str || mi.id || ''),
      title: mi.title || '',
      author: mi.author || '',
      user_count: mi.user_count || 0,
      cover: pickCover(mi)
    }
  }).filter(x => x.title)
  return { search, music: songs }
}

export async function hotApiService (request, ctx) {
  const url = new URL(request.url)
  const fresh = url.searchParams.get('refresh') === '1' && url.searchParams.get('token') === ctx.config.auth.token
  let board, updated
  const cached = fresh ? null : await metaGet(ctx, CACHE_KEY)
  if (cached && (Date.now() - cached.ts) < CACHE_TTL) {
    try { board = JSON.parse(cached.v); updated = cached.ts } catch {}
  }
  if (!board) {
    board = await buildBoard(ctx)
    updated = Date.now()
    await metaSet(ctx, CACHE_KEY, JSON.stringify(board))
  }
  // Route cover images through the cached /img proxy (signed).
  const rw = (x) => ({ ...x, cover: x.cover ? imgProxyLink(request, ctx, x.cover) : null })
  return rawJsonResponse({
    code: 200,
    updated,
    search: board.search.map(rw),
    music: board.music.map(rw)
  })
}

export async function hotPageService (request, ctx) {
  return new Response(PAGE, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } })
}

const PAGE = `<!doctype html>
<html lang=zh>
<head>
<meta charset=utf-8>
<meta name=viewport content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>热榜 · 抖音解析</title>
<style>
:root{
  --bg:#15141b;--panel:#1d1b25;--panel2:#221f2a;--line:#36313f;
  --ink:#ece7db;--muted:#938da0;--faint:#615b6e;--coral:#ff5d6c;--teal:#3fe0c5;--gold:#f5c451;
  --serif:"Songti SC","STSong","Noto Serif SC",ui-serif,Georgia,serif;
  --sans:-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",Segoe UI,sans-serif;
  --mono:ui-monospace,"SF Mono",Menlo,Consolas,monospace;
}
*{box-sizing:border-box}
body{margin:0;background:radial-gradient(1200px 600px at 50% -10%,#221f2c 0%,transparent 60%),var(--bg);color:var(--ink);font-family:var(--sans);padding:max(20px,4vh) 18px 60px;-webkit-font-smoothing:antialiased}
.wrap{max-width:760px;margin:0 auto}
.eyebrow{font-family:var(--mono);font-size:11px;letter-spacing:.32em;text-transform:uppercase;color:var(--coral);margin:0 0 8px}
h1{font-family:var(--serif);font-weight:600;font-size:clamp(36px,9vw,64px);line-height:.95;margin:0;letter-spacing:.04em}
.sub{color:var(--muted);font-size:14px;margin:12px 0 0}
.bar{display:flex;gap:8px;align-items:center;margin:22px 0 18px;flex-wrap:wrap}
.tab{font-family:var(--mono);font-size:12px;letter-spacing:.1em;cursor:pointer;border:1px solid var(--line);background:transparent;color:var(--muted);padding:8px 16px;border-radius:999px}
.tab.on{border-color:var(--coral);color:var(--coral)}
.spacer{flex:1}
.bar a{font-family:var(--mono);font-size:11px;color:var(--faint);text-decoration:none}
.bar a:hover{color:var(--teal)}
.status{font-family:var(--mono);font-size:12px;color:var(--muted);margin:0 2px 16px;min-height:1.3em}
.list{display:flex;flex-direction:column;gap:2px}
.row{display:flex;align-items:center;gap:14px;text-decoration:none;color:inherit;padding:11px 12px;border-radius:10px;transition:background .12s}
.row:hover{background:var(--panel)}
.rank{font-family:var(--serif);font-size:22px;font-weight:600;width:34px;text-align:center;color:var(--faint);flex:none}
.row:nth-child(1) .rank,.row:nth-child(2) .rank,.row:nth-child(3) .rank{color:var(--coral)}
.cv{width:46px;height:46px;border-radius:8px;object-fit:cover;background:#0e0d12;flex:none}
.cv.sq{border-radius:50%}
.mid{flex:1;min-width:0}
.ttl{font-size:15px;line-height:1.3;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.meta{font-family:var(--mono);font-size:11px;color:var(--muted);margin-top:4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.tag{display:inline-block;font-family:var(--mono);font-size:9px;font-weight:700;padding:1px 5px;border-radius:4px;margin-left:6px;vertical-align:middle}
.tag.hot{background:rgba(255,93,108,.18);color:var(--coral)}
.tag.new{background:rgba(63,224,197,.16);color:var(--teal)}
.tag.boom{background:rgba(245,196,81,.18);color:var(--gold)}
.heat{font-family:var(--mono);font-size:12px;color:var(--gold);flex:none;text-align:right;min-width:62px}
footer{margin-top:32px;font-family:var(--mono);font-size:11px;color:var(--faint)}
footer a{color:var(--muted)}
</style>
</head>
<body>
<main class=wrap>
  <p class=eyebrow>DOUYIN 热榜</p>
  <h1>此刻在热</h1>
  <p class=sub>抖音此刻的热搜与热歌——点任意一条，搜进我们自己的库里。</p>
  <div class=bar>
    <button class="tab on" data-b=search id=tabS>热搜榜</button>
    <button class=tab data-b=music id=tabM>热歌榜</button>
    <span class=spacer></span>
    <a href="/discover">发现</a>
    <a href="/">← 去解析</a>
  </div>
  <p id=status class=status>加载中…</p>
  <div id=list class=list></div>
  <footer>自托管于 RandallFlare · <span id=upd></span> · <a href="/">解析台</a></footer>
</main>
<script>
(function(){
  var $=function(s){return document.querySelector(s)}
  var list=$('#list'),statusEl=$('#status'),board='search',data=null
  function el(t,c,x){var e=document.createElement(t);if(c)e.className=c;if(x!=null)e.textContent=x;return e}
  function fmt(n){n=Number(n)||0;if(n>=1e8)return (n/1e8).toFixed(1)+'亿';if(n>=1e4)return (n/1e4).toFixed(1)+'万';return String(n)}
  function labelTag(l){if(l===3)return['hot','热'];if(l===1)return['new','新'];if(l===2)return['boom','爆'];return null}
  function searchRow(r){
    var a=el('a','row');a.href='/search?q='+encodeURIComponent(r.word)
    a.appendChild(el('div','rank',r.rank))
    if(r.cover){var im=el('img','cv');im.loading='lazy';im.src=r.cover;im.alt='';a.appendChild(im)}
    var mid=el('div','mid')
    var t=el('div','ttl');t.appendChild(document.createTextNode(r.word))
    var tg=labelTag(r.label);if(tg){var s=el('span','tag '+tg[0],tg[1]);t.appendChild(s)}
    mid.appendChild(t)
    mid.appendChild(el('div','meta',fmt(r.view_count)+' 浏览 · '+fmt(r.video_count)+' 视频'))
    a.appendChild(mid)
    a.appendChild(el('div','heat','🔥'+fmt(r.hot_value)))
    return a
  }
  function musicRow(r){
    var a=el('a','row');a.href='/search?q='+encodeURIComponent(r.title)
    a.appendChild(el('div','rank',r.rank))
    if(r.cover){var im=el('img','cv sq');im.loading='lazy';im.src=r.cover;im.alt='';a.appendChild(im)}
    var mid=el('div','mid')
    mid.appendChild(el('div','ttl',r.title))
    mid.appendChild(el('div','meta',(r.author||'未知')+' · '+fmt(r.user_count)+' 人用'))
    a.appendChild(mid)
    a.appendChild(el('div','heat','♪ '+fmt(r.user_count)))
    return a
  }
  function render(){
    list.innerHTML=''
    var rows=board==='search'?(data.search||[]):(data.music||[])
    if(!rows.length){statusEl.textContent='暂时拉不到这个榜单，待会儿再来';return}
    statusEl.textContent='共 '+rows.length+' 条'
    rows.forEach(function(r){list.appendChild(board==='search'?searchRow(r):musicRow(r))})
  }
  async function load(){
    statusEl.textContent='加载中…'
    try{
      var j=await (await fetch('/api/douyin/hot')).json()
      data=j
      if(j.updated){var d=new Date(j.updated);$('#upd').textContent='更新于 '+d.getHours()+':'+('0'+d.getMinutes()).slice(-2)}
      render()
    }catch(e){statusEl.textContent='加载失败：'+e.message}
  }
  function setBoard(b){if(board===b)return;board=b;$('#tabS').classList.toggle('on',b==='search');$('#tabM').classList.toggle('on',b==='music');render()}
  $('#tabS').addEventListener('click',function(){setBoard('search')})
  $('#tabM').addEventListener('click',function(){setBoard('music')})
  load()
})();
</script>
</body>
</html>`
