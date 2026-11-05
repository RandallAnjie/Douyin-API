// Public 抖音热榜 — 热门视频 (recommend feed) + 热搜榜 + 热歌榜, from the
// app-domain endpoints (unsigned). To avoid abuse, the upstream fetch runs
// ONLY in cron (refreshHotBoard) and stores the board JSON in D1; the public
// API reads D1 only and never hits upstream on a cache miss. Covers are
// served via the R2-backed /img proxy. Words/songs deep-link into our own
// /search; 热门视频 cards play from a same-origin /proxy URL and ingest
// in the background.
import { rawJsonResponse } from '../utils/respond.js'
import { metaGet, metaSet } from '../utils/db.js'
import { imgProxyLink, proxyPath } from '../utils/proxy-link.js'
import { warmUrl, mediaKey } from '../utils/r2cache.js'
import { mediaCandidates } from '../hybrid/crawler.js'
import * as douyinApp from '../douyin/app/crawler.js'

const CACHE_KEY = 'hot:douyin:board'
export const HOT_NWM_WARM_TOP = 10
export const HOT_NWM_WARM_CONCURRENCY = 2

function pickCover (obj) {
  const c = obj?.cover_large || obj?.cover_hd || obj?.cover_medium || obj?.word_cover || obj?.cover_thumb
  return c?.url_list?.[0] || null
}

async function buildBoard (ctx) {
  const [words, music, feed] = await Promise.all([
    douyinApp.fetchHotSearchBoard(ctx).catch(() => []),
    douyinApp.fetchHotMusicBoard(ctx, 50).catch(() => []),
    douyinApp.fetchAppFeed(ctx, 18).catch(() => [])
  ])
  const videos = feed.map(douyinApp.feedCard).filter(x => x.id)
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
  return { board: { search, music: songs, videos }, feed }
}

// After a board refresh, pull nwm for the top N videos into R2 (bounded
// concurrency, waitUntil) so /hot clicks hit cache. Grow ingest already
// warms cover/avatar/nwm for its own feed batch — this covers the board's
// own ranking, which is a separate fetch.
export function scheduleHotNwmWarm (ctx, feed) {
  const bucket = ctx.config.mediaR2
  if (!bucket || !Array.isArray(feed) || !feed.length) return Promise.resolve()
  const items = []
  for (const a of feed) {
    const card = douyinApp.feedCard(a)
    if (!card.id || card.type === 'image') continue
    items.push(a)
    if (items.length >= HOT_NWM_WARM_TOP) break
  }
  if (!items.length) return Promise.resolve()
  const headers = {
    'User-Agent': ctx.config.douyin.userAgent,
    Referer: 'https://www.douyin.com/'
  }
  const job = async () => {
    let i = 0
    const run = async () => {
      while (i < items.length) {
        const a = items[i++]
        const cands = mediaCandidates('douyin', a, 'nwm')
        if (!cands[0]) continue
        try {
          await warmUrl({ config: ctx.config }, bucket, mediaKey('douyin', a.aweme_id, 'nwm'), cands[0], headers, 'video/mp4')
        } catch {}
      }
    }
    const n = Math.min(HOT_NWM_WARM_CONCURRENCY, items.length)
    await Promise.all(Array.from({ length: n }, run))
  }
  const p = job()
  if (ctx.waitUntil) ctx.waitUntil(p)
  return p
}

// Cron-only: fetch the board from upstream and persist it to D1. Returns the
// board (or null on total failure). The public API never calls this path.
export async function refreshHotBoard (ctx) {
  const { board, feed } = await buildBoard(ctx)
  if (!board.search.length && !board.music.length && !board.videos.length) return null
  await metaSet(ctx, CACHE_KEY, JSON.stringify(board))
  scheduleHotNwmWarm(ctx, feed)
  return board
}

// Mint cover + same-origin play (HMAC, never the master token). Search
// and music rows only get a cover — their ids are not video ids.
export function decorateHotBoard (request, ctx, board) {
  const rw = (x, kind) => {
    const cover = x.cover ? imgProxyLink(request, ctx, x.cover) : null
    if (kind !== 'video') return { ...x, cover }
    const play = (x.id && x.type !== 'image') ? proxyPath(ctx, 'douyin', x.id, 'nwm') : null
    return { ...x, cover, play }
  }
  return {
    videos: (board.videos || []).map((x) => rw(x, 'video')),
    search: (board.search || []).map((x) => rw(x, 'search')),
    music: (board.music || []).map((x) => rw(x, 'music'))
  }
}

export async function hotApiService (request, ctx) {
  const url = new URL(request.url)
  const isAdmin = url.searchParams.get('token') === ctx.config.auth.token
  let board, updated
  const cached = await metaGet(ctx, CACHE_KEY)
  if (cached) {
    try { board = JSON.parse(cached.v); updated = cached.ts } catch {}
  }
  // Cache miss: only an admin (master token) may trigger a live fetch — this
  // is the manual warm path. Public requests get an empty "pending" board so
  // the aggregation endpoints can't be used to hammer upstream.
  if (!board && isAdmin) {
    board = await refreshHotBoard(ctx)
    updated = Date.now()
  }
  if (!board) {
    return rawJsonResponse({ code: 200, pending: true, updated: 0, videos: [], search: [], music: [] })
  }
  const decorated = decorateHotBoard(request, ctx, board)
  return rawJsonResponse({
    code: 200,
    updated,
    videos: decorated.videos,
    search: decorated.search,
    music: decorated.music
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
/* 热门视频 grid */
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:14px}
.card{cursor:pointer;background:var(--panel);border:1px solid var(--line);border-radius:12px;overflow:hidden;transition:border-color .15s}
.card:hover{border-color:var(--teal)}
.thumb{position:relative;width:100%;aspect-ratio:3/4;background:#0e0d12;overflow:hidden}
.thumb img{width:100%;height:100%;object-fit:cover;display:block}
.thumb .badge{position:absolute;left:8px;top:8px;font-family:var(--mono);font-size:10px;background:rgba(20,18,26,.8);color:var(--teal);padding:2px 7px;border-radius:5px}
.thumb .dg{position:absolute;right:8px;top:8px;font-family:var(--mono);font-size:10px;background:rgba(255,93,108,.9);color:#1a0c0f;font-weight:700;padding:2px 7px;border-radius:5px}
.thumb .play{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:34px;color:rgba(255,255,255,.85);opacity:0;transition:opacity .15s}
.card:hover .play{opacity:1}
.cinfo{padding:9px 10px}
.cinfo .who{font-family:var(--mono);font-size:11px;color:var(--teal);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cinfo .cd{font-size:12px;margin-top:3px;line-height:1.35;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;color:var(--muted)}
footer{margin-top:32px;font-family:var(--mono);font-size:11px;color:var(--faint)}
footer a{color:var(--muted)}
/* lightbox */
.lb{position:fixed;inset:0;z-index:50;display:none;align-items:center;justify-content:center;background:rgba(8,7,11,.92);backdrop-filter:blur(6px)}
.lb.on{display:flex}
.lb-stage{position:relative;max-width:min(900px,94vw);max-height:90vh;display:flex;align-items:center;justify-content:center}
.lb-stage video,.lb-stage img{max-width:94vw;max-height:90vh;border-radius:10px;display:block;background:#000}
.lb-msg{font-family:var(--mono);font-size:13px;color:#cdd6e2}
.lb-close{position:fixed;top:16px;right:18px;width:40px;height:40px;border:0;border-radius:50%;background:rgba(255,255,255,.1);color:#fff;font-size:20px;cursor:pointer;line-height:40px}
.lb-close:hover{background:var(--coral);color:#1a0c0f}
.lb-cap{position:fixed;bottom:18px;left:50%;transform:translateX(-50%);max-width:90vw;font-family:var(--mono);font-size:12px;color:#cdd6e2;background:rgba(8,7,11,.6);padding:6px 14px;border-radius:999px;text-align:center}
.lb-cap a{color:var(--teal);text-decoration:none}
</style>
</head>
<body>
<main class=wrap>
  <p class=eyebrow>DOUYIN 热榜</p>
  <h1>此刻在热</h1>
  <p class=sub>抖音此刻最热的视频、热搜与热歌。点开热门视频即自动解析入库；点热搜/热歌搜进我们自己的库里。</p>
  <div class=bar>
    <button class="tab on" data-b=videos id=tabV>热门视频</button>
    <button class=tab data-b=search id=tabS>热搜榜</button>
    <button class=tab data-b=music id=tabM>热歌榜</button>
    <span class=spacer></span>
    <a href="/discover">发现</a>
    <a href="/">← 去解析</a>
  </div>
  <p id=status class=status>加载中…</p>
  <div id=grid class=grid style=display:none></div>
  <div id=list class=list></div>
  <footer>自托管于 RandallFlare · <span id=upd></span> · <a href="/">解析台</a></footer>
</main>
<div id=lb class=lb>
  <button class=lb-close id=lbClose aria-label=关闭>×</button>
  <div class=lb-stage id=lbStage></div>
  <div class=lb-cap id=lbCap></div>
</div>
<script src="/ui.js"></script>
<script>
(function(){
  var DT=window.DT,$=DT.qs,el=DT.el,fmt=DT.fmt
  var list=$('#list'),grid=$('#grid'),statusEl=$('#status')
  var board='videos',data=null
  var lb=DT.bindLightbox({root:'#lb',stage:'#lbStage',close:'#lbClose',cap:'#lbCap'})

  function labelTag(l){if(l===3)return['hot','热'];if(l===1)return['new','新'];if(l===2)return['boom','爆'];return null}

  // --- render ---
  function videoCard(r){
    var c=el('div','card');c.addEventListener('click',function(){onVideoClick(r)})
    var th=el('div','thumb')
    if(r.cover){var im=el('img');im.loading='lazy';im.src=r.cover;im.alt='';th.appendChild(im)}
    th.appendChild(el('span','badge',r.type==='image'?'图集':'视频'))
    th.appendChild(el('span','dg','🔥'+fmt(r.digg)))
    th.appendChild(el('span','play','▶'))
    c.appendChild(th)
    var info=el('div','cinfo')
    info.appendChild(el('div','who',r.author||'未知作者'))
    info.appendChild(el('div','cd',r.desc||'(无标题)'))
    c.appendChild(info)
    return c
  }
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
    list.innerHTML='';grid.innerHTML=''
    var isV=board==='videos'
    grid.style.display=isV?'':'none';list.style.display=isV?'none':''
    var rows=isV?(data.videos||[]):board==='search'?(data.search||[]):(data.music||[])
    if(!rows.length){statusEl.textContent='暂时拉不到这个榜单，待会儿再来';return}
    statusEl.textContent='共 '+rows.length+' 条'+(isV?' · 点开即播，后台入库':'')
    rows.forEach(function(r){
      if(isV)grid.appendChild(videoCard(r))
      else list.appendChild(board==='search'?searchRow(r):musicRow(r))
    })
  }

  // --- data ---
  function fetchBoard(){return DT.getJson('/api/douyin/hot')}
  function load(){
    statusEl.textContent='加载中…'
    fetchBoard().then(function(j){
      data=j
      if(j.updated){var d=new Date(j.updated);$('#upd').textContent='更新于 '+d.getHours()+':'+('0'+d.getMinutes()).slice(-2)}
      if(j.pending){statusEl.textContent='榜单随定时任务刷新，首次生成中，稍后再来';grid.style.display='none';list.style.display='none';return}
      render()
    }).catch(function(e){statusEl.textContent='加载失败：'+e.message})
  }

  // --- events ---
  function slidesFor(r){
    if(r.type==='image'&&r.cover)return[{type:'image',url:r.cover}]
    if(r.play)return[{type:'video',url:r.play,poster:r.cover||'',width:r.width,height:r.height}]
    if(r.cover)return[{type:'image',url:r.cover}]
    return[]
  }
  function onVideoClick(r){
    var ingestP=DT.ingest('douyin',r.id)
    var gen
    function replayFromParse(){
      ingestP.then(function(j){
        if(gen!==lb.generation())return
        var d=j.data||{}
        var src=DT.playSrc(d)
        var imgs=DT.imagesFromParse(d)
        if(d.type==='image'&&imgs[0])lb.replace(imgs.map(function(u){return{type:'image',url:u}}))
        else if(src)lb.replace([{type:'video',url:src,poster:(d.cover_data&&d.cover_data.cover)||r.cover||'',width:d.video_data&&d.video_data.width,height:d.video_data&&d.video_data.height}])
      }).catch(function(e){if(gen===lb.generation())lb.setCaption('解析失败：'+(e.message||e))})
    }
    var slides=slidesFor(r)
    gen=lb.open(slides,{caption:'入库中…',onRetryParse:replayFromParse})
    ingestP.then(function(j){
      if(gen!==lb.generation())return
      var d=j.data||{}
      if(d.type==='image'){
        var imgs=DT.imagesFromParse(d)
        if(imgs[0])lb.replace(imgs.map(function(u){return{type:'image',url:u}}))
      }
      lb.setCaption('已入库 · <a href="'+DT.workUrl('douyin',r.id)+'">查看数据分析 →</a>')
    }).catch(function(){
      if(gen!==lb.generation())return
      lb.setCaption(r.play?'播放中 · 入库稍后再试':'入库失败')
    })
  }
  var tabs={videos:$('#tabV'),search:$('#tabS'),music:$('#tabM')}
  function setBoard(b){if(board===b)return;board=b;for(var k in tabs)tabs[k].classList.toggle('on',k===b);render()}
  for(var k in tabs)(function(b){tabs[b].addEventListener('click',function(){setBoard(b)})})(k)
  load()
})();
</script>
</body>
</html>`
