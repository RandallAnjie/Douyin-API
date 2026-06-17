// Admin — /admin shows recent queries from the D1 log. /api/admin/recent
// returns the rows as JSON (master-token gated). Same dark "解析台"
// aesthetic as the front page.
import { HTTPException } from '../utils/http-exception.js'
import { rawJsonResponse } from '../utils/respond.js'
import { recentQueries } from '../utils/db.js'

export async function adminRecentService (request, ctx) {
  const url = new URL(request.url)
  if ((url.searchParams.get('token') || '') !== ctx.config.auth.token) {
    throw new HTTPException(401, { message: 'token required' })
  }
  const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit')) || 60))
  const rows = await recentQueries(ctx, limit)
  return rawJsonResponse({ code: 200, count: rows.length, data: rows })
}

export async function adminPageService (request, ctx) {
  return new Response(ADMIN_HTML, {
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8' }
  })
}

const ADMIN_HTML = `<!doctype html>
<html lang=zh>
<head>
<meta charset=utf-8>
<meta name=viewport content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>档案 · 近期解码</title>
<style>
:root{
  --bg:#15141b;--panel:#1d1b25;--panel2:#221f2a;--line:#36313f;
  --ink:#ece7db;--muted:#938da0;--faint:#615b6e;--coral:#ff5d6c;--teal:#3fe0c5;
  --serif:"Songti SC","STSong","Noto Serif SC",ui-serif,Georgia,serif;
  --sans:-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",Segoe UI,sans-serif;
  --mono:ui-monospace,"SF Mono",Menlo,Consolas,monospace;
}
*{box-sizing:border-box}
body{margin:0;background:radial-gradient(1200px 600px at 50% -10%,#221f2c 0%,transparent 60%),var(--bg);color:var(--ink);font-family:var(--sans);padding:max(20px,4vh) 18px 60px;-webkit-font-smoothing:antialiased}
.wrap{max-width:920px;margin:0 auto}
.eyebrow{font-family:var(--mono);font-size:11px;letter-spacing:.32em;text-transform:uppercase;color:var(--coral);margin:0 0 8px}
h1{font-family:var(--serif);font-weight:600;font-size:clamp(34px,9vw,60px);line-height:.95;margin:0;letter-spacing:.04em}
.bar{display:flex;gap:10px;align-items:center;margin:22px 0 18px;flex-wrap:wrap}
.bar input{flex:1;min-width:180px;background:var(--panel);border:1px solid var(--line);color:var(--ink);font-family:var(--mono);font-size:13px;padding:10px 13px;border-radius:9px}
.bar a,.bar button{font-family:var(--mono);font-size:12px;letter-spacing:.08em;text-decoration:none;cursor:pointer;border:1px solid var(--line);background:transparent;color:var(--ink);padding:10px 14px;border-radius:8px}
.bar a:hover,.bar button:hover{border-color:var(--teal);color:var(--teal)}
input:focus-visible{outline:2px solid var(--teal);outline-offset:1px}
.status{font-family:var(--mono);font-size:12px;color:var(--muted);margin:0 2px 16px;min-height:1.3em}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:14px}
.item{display:flex;gap:12px;background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:12px}
.thumb{flex:0 0 64px;width:64px;height:96px;border-radius:8px;object-fit:cover;background:#0e0d12;border:1px solid var(--line)}
.info{min-width:0;display:flex;flex-direction:column;gap:4px}
.info .top{display:flex;gap:8px;align-items:center}
.tag{font-family:var(--mono);font-size:10px;letter-spacing:.1em;color:var(--teal);border:1px solid var(--line);border-radius:5px;padding:1px 6px}
.who{font-family:var(--serif);font-size:15px}
.dsc{color:var(--muted);font-size:12.5px;line-height:1.4;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.row{margin-top:auto;display:flex;gap:10px;align-items:center;flex-wrap:wrap;font-family:var(--mono);font-size:11px;color:var(--faint)}
.row a{color:var(--muted);text-decoration:none}
.row a:hover{color:var(--teal)}
footer{margin-top:30px;font-family:var(--mono);font-size:11px;color:var(--faint)}
footer a{color:var(--muted)}
</style>
</head>
<body>
<main class=wrap>
  <p class=eyebrow>DOUYIN · TIKTOK 档案</p>
  <h1>近期解码</h1>
  <div class=bar>
    <input id=key type=password autocomplete=off placeholder="访问钥匙 (API Token)">
    <button id=refresh>刷新</button>
    <a href="/">← 解析台</a>
  </div>
  <p id=status class=status>输入钥匙后自动加载</p>
  <div id=grid class=grid></div>
  <footer>自托管于 RandallFlare · 最近 60 条 · 重复解析合并计次</footer>
</main>
<script>
(function(){
  var $=function(s){return document.querySelector(s)}
  var KEY='dt_key'
  var keyInput=$('#key'),statusEl=$('#status'),grid=$('#grid')
  try{var k=localStorage.getItem(KEY);if(k)keyInput.value=k}catch(e){}
  function el(t,c,x){var e=document.createElement(t);if(c)e.className=c;if(x!=null)e.textContent=x;return e}
  function ago(ms){var s=Math.floor((Date.now()-ms)/1000);if(s<60)return s+'秒前';if(s<3600)return Math.floor(s/60)+'分前';if(s<86400)return Math.floor(s/3600)+'时前';return Math.floor(s/86400)+'天前'}
  async function load(){
    var key=(keyInput.value||'').trim()
    if(!key){statusEl.textContent='先填访问钥匙';return}
    try{localStorage.setItem(KEY,key)}catch(e){}
    statusEl.textContent='加载中…';grid.innerHTML=''
    try{
      var r=await fetch('/api/admin/recent?limit=60&token='+encodeURIComponent(key))
      if(r.status!==200){statusEl.textContent='加载失败 HTTP '+r.status;return}
      var j=await r.json();var rows=j.data||[]
      statusEl.textContent=rows.length?('共 '+j.count+' 条'):'还没有查询记录'
      rows.forEach(function(row){grid.appendChild(card(row))})
    }catch(e){statusEl.textContent='网络错误：'+e.message}
  }
  function card(row){
    var it=el('div','item')
    var im=el('img','thumb');im.loading='lazy';if(row.cover)im.src=row.cover;im.alt='';it.appendChild(im)
    var info=el('div','info')
    var top=el('div','top');top.appendChild(el('span','tag',(row.platform||'')+' · '+(row.type==='image'?'图集':'视频')));info.appendChild(top)
    info.appendChild(el('div','who',row.author||'未知作者'))
    if(row.description)info.appendChild(el('div','dsc',row.description))
    var rowEl=el('div','row')
    rowEl.appendChild(el('span',null,'×'+(row.hits||1)+' · '+ago(row.updated_at)))
    var re=el('a',null,'重解');re.href='/?u='+encodeURIComponent(row.original_url||'');rowEl.appendChild(re)
    if(row.play){var p=el('a',null,'看视频');p.href=row.play;p.target='_blank';p.rel='noopener';rowEl.appendChild(p)}
    if(row.original_url){var o=el('a',null,'原链');o.href=row.original_url;o.target='_blank';o.rel='noopener';rowEl.appendChild(o)}
    info.appendChild(rowEl)
    it.appendChild(info)
    return it
  }
  $('#refresh').addEventListener('click',load)
  keyInput.addEventListener('keydown',function(e){if(e.key==='Enter')load()})
  if(keyInput.value)load()
})();
</script>
</body>
</html>`
