// Parser front-end — "解析台". A single self-contained page served at
// the worker root: paste a Douyin/TikTok share command, it auto-parses
// (calls /api/hybrid/video_data on this same origin) and returns the
// no-watermark video / image set. The access key (DOUYIN_API_TOKEN) is
// entered once and kept in the browser's localStorage.
//
// Same-origin, so no CORS and the proxied media links Just Work.

export default async function appService (request, ctx) {
  return new Response(PAGE, {
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8' }
  })
}

const PAGE = `<!doctype html>
<html lang=zh>
<head>
<meta charset=utf-8>
<meta name=viewport content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>解析台 · 抖音无水印</title>
<style>
:root{
  --bg:#15141b; --panel:#1d1b25; --panel2:#221f2a; --line:#36313f;
  --ink:#ece7db; --muted:#938da0; --faint:#615b6e;
  --coral:#ff5d6c; --teal:#3fe0c5;
  --serif:"Songti SC","STSong","Noto Serif SC",ui-serif,Georgia,serif;
  --sans:-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",Segoe UI,sans-serif;
  --mono:ui-monospace,"SF Mono",Menlo,Consolas,"Liberation Mono",monospace;
}
*{box-sizing:border-box}
html,body{margin:0}
body{
  background:
    radial-gradient(1200px 600px at 50% -10%, #221f2c 0%, transparent 60%),
    var(--bg);
  color:var(--ink); font-family:var(--sans); line-height:1.55;
  min-height:100dvh; padding:max(20px,5vh) 18px 60px;
  -webkit-font-smoothing:antialiased;
}
.wrap{max-width:760px;margin:0 auto}

/* header */
.eyebrow{font-family:var(--mono);font-size:11px;letter-spacing:.32em;text-transform:uppercase;color:var(--coral);margin:0 0 10px}
h1{font-family:var(--serif);font-weight:600;font-size:clamp(40px,11vw,76px);line-height:.95;margin:0;letter-spacing:.04em}
.sub{color:var(--muted);margin:14px 0 0;font-size:15px}

/* key bar */
.keybar{display:flex;align-items:center;gap:10px;margin:26px 0 22px;flex-wrap:wrap}
.keybar label{font-family:var(--mono);font-size:11px;letter-spacing:.18em;text-transform:uppercase;color:var(--muted)}
.keybar input{
  flex:1;min-width:180px;background:var(--panel);border:1px solid var(--line);color:var(--ink);
  font-family:var(--mono);font-size:13px;padding:11px 13px;border-radius:9px;letter-spacing:.04em;
}
.keybar .hint{font-family:var(--mono);font-size:11px;color:var(--faint)}
input:focus-visible,textarea:focus-visible{outline:2px solid var(--teal);outline-offset:1px;border-color:transparent}

/* drop slot — the signature */
.slot{position:relative;background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:0;overflow:hidden}
.slot::before{
  content:"口令投递口";position:absolute;top:0;left:0;right:0;height:34px;line-height:34px;padding:0 14px;
  font-family:var(--mono);font-size:11px;letter-spacing:.22em;color:var(--muted);
  background:repeating-linear-gradient(45deg,var(--panel2),var(--panel2) 9px,#26222e 9px,#26222e 18px);
  border-bottom:1px dashed var(--line);
}
textarea{
  width:100%;min-height:128px;resize:vertical;border:0;background:transparent;color:var(--ink);
  font-family:var(--mono);font-size:14px;line-height:1.7;padding:46px 15px 56px;display:block;
}
textarea::placeholder{color:var(--faint)}
.slot .go{
  position:absolute;right:12px;bottom:12px;border:0;cursor:pointer;
  background:var(--coral);color:#1a0c0f;font-family:var(--mono);font-weight:700;font-size:13px;
  letter-spacing:.12em;padding:9px 18px;border-radius:8px;
}
.slot .go:active{transform:translateY(1px)}

/* status */
.status{font-family:var(--mono);font-size:12px;letter-spacing:.06em;color:var(--muted);margin:14px 2px;min-height:1.4em}
.status::before{content:"› ";color:var(--faint)}
.status.load{color:var(--teal)} .status.ok{color:var(--teal)}
.status.err{color:var(--coral)} .status.warn{color:#e7b15a}

/* result */
#out{margin-top:6px}
.card{display:flex;gap:20px;background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:16px}
@media(max-width:560px){.card{flex-direction:column}}
.frame{position:relative;flex:0 0 200px;aspect-ratio:9/16;border-radius:10px;overflow:hidden;background:#0e0d12;border:1px solid var(--line)}
.frame img,.frame video{width:100%;height:100%;object-fit:cover;display:block;background:#000}
.badge{position:absolute;left:10px;top:10px;font-family:var(--mono);font-size:11px;letter-spacing:.1em;background:rgba(20,18,26,.78);color:var(--teal);padding:3px 8px;border-radius:6px;backdrop-filter:blur(4px)}
.meta{flex:1;min-width:0;display:flex;flex-direction:column}
.nick{font-family:var(--serif);font-size:20px;letter-spacing:.02em}
.desc{color:var(--muted);font-size:14px;margin:8px 0 0;white-space:pre-wrap;word-break:break-word}
.stats{display:flex;gap:18px;margin:14px 0 0}
.stat{display:flex;flex-direction:column;line-height:1.2}
.stat b{font-family:var(--mono);font-size:16px} .stat i{font-style:normal;font-size:11px;color:var(--faint);letter-spacing:.1em}
.acts{display:flex;flex-wrap:wrap;gap:9px;margin-top:auto;padding-top:16px}
.btn{
  display:inline-block;cursor:pointer;text-decoration:none;border:1px solid var(--coral);
  background:var(--coral);color:#1a0c0f;font-family:var(--mono);font-weight:700;font-size:12px;letter-spacing:.08em;
  padding:9px 14px;border-radius:8px;
}
.btn.ghost{background:transparent;color:var(--ink);border-color:var(--line)}
.btn.ghost:hover{border-color:var(--teal);color:var(--teal)}
.gallery{display:grid;grid-template-columns:repeat(auto-fill,minmax(96px,1fr));gap:8px;margin-top:14px}
.gallery a{display:block}
.gallery img{width:100%;aspect-ratio:.7;object-fit:cover;border-radius:8px;border:1px solid var(--line)}
pre#raw{margin-top:14px;background:#0f0e13;border:1px solid var(--line);border-radius:10px;padding:14px;overflow:auto;font-family:var(--mono);font-size:11.5px;color:var(--muted);max-height:300px}

/* decode flash on render */
@keyframes scan{from{clip-path:inset(0 0 100% 0);opacity:.4}to{clip-path:inset(0 0 0 0);opacity:1}}
.card{animation:scan .42s cubic-bezier(.2,.7,.2,1)}
@media(prefers-reduced-motion:reduce){.card{animation:none}}

footer{margin-top:34px;font-family:var(--mono);font-size:11px;color:var(--faint);letter-spacing:.08em}
footer a{color:var(--muted)}
</style>
</head>
<body>
<main class=wrap>
  <p class=eyebrow>DOUYIN · TIKTOK 解码</p>
  <h1>解析台</h1>
  <p class=sub>粘贴抖音 / TikTok 分享口令，自动取回无水印视频与图集。</p>

  <div class=keybar>
    <label for=key>访问钥匙</label>
    <input id=key type=password autocomplete=off spellcheck=false placeholder="你的 API Token">
    <span class=hint>只存在本机</span>
  </div>

  <div class=slot>
    <textarea id=paste placeholder="把抖音分享口令粘到这里，一粘就解析…&#10;例：7.91 复制打开抖音，看看【作者的作品】 https://v.douyin.com/xxxxxx/"></textarea>
    <button id=go class=go>解析</button>
  </div>

  <p id=status class=status>等待口令</p>
  <div id=out></div>

  <footer>自托管于 RandallFlare · <a href="/admin">档案</a> · <a href="/docs">接口文档</a></footer>
</main>

<script>
(function(){
  var $=function(s){return document.querySelector(s)}
  var KEY='dt_key'
  var keyInput=$('#key'),pasteBox=$('#paste'),statusEl=$('#status'),out=$('#out'),goBtn=$('#go')
  try{var k=localStorage.getItem(KEY);if(k)keyInput.value=k}catch(e){}
  keyInput.addEventListener('input',function(){try{localStorage.setItem(KEY,keyInput.value)}catch(e){}})

  function extractUrl(t){var m=String(t||'').match(/https?:\\/\\/[^\\s]+/);return m?m[0]:''}
  function setStatus(s,kind){statusEl.textContent=s;statusEl.className='status'+(kind?' '+kind:'')}
  function el(tag,cls,txt){var e=document.createElement(tag);if(cls)e.className=cls;if(txt!=null)e.textContent=txt;return e}
  function fmt(n){n=Number(n)||0;return n>=10000?(n/10000).toFixed(1)+'w':String(n)}

  var inflight=0
  async function parse(text){
    var url=extractUrl(text)
    if(!url){setStatus('没找到链接，确认粘的是分享口令','warn');return}
    var key=(keyInput.value||'').trim()
    if(!key){setStatus('先填访问钥匙','warn');keyInput.focus();return}
    var my=++inflight
    setStatus('解码中…','load');out.innerHTML=''
    try{
      var api='/api/hybrid/video_data?minimal=true&proxy=1&token='+encodeURIComponent(key)+'&url='+encodeURIComponent(url)
      var r=await fetch(api)
      var j=await r.json()
      if(my!==inflight)return
      if(r.status!==200){setStatus('失败：'+((j&&j.message)||('HTTP '+r.status)),'err');return}
      render(j.data);setStatus('已解码 · '+(j.data&&j.data.platform||''),'ok')
    }catch(e){if(my===inflight)setStatus('网络错误：'+e.message,'err')}
  }

  function withDownload(href){return href+(href.indexOf('?')>-1?'&':'?')+'download=1'}
  function dlBtn(href,label){var a=el('a','btn',label);a.href=withDownload(href);a.setAttribute('download','');return a}
  function copyBtn(text,label){
    var b=el('button','btn ghost',label)
    b.addEventListener('click',function(){navigator.clipboard.writeText(text).then(function(){var o=b.textContent;b.textContent='已复制';setTimeout(function(){b.textContent=o},1200)})})
    return b
  }
  function stat(label,n){var w=el('span','stat');w.appendChild(el('b',null,fmt(n)));w.appendChild(el('i',null,label));return w}

  function render(d){
    out.innerHTML=''
    if(!d){setStatus('空结果','warn');return}
    var card=el('div','card')
    var frame=el('div','frame')
    var cover=d.cover_data&&d.cover_data.cover?d.cover_data.cover:''
    var firstImg=(d.image_data&&(d.image_data.no_watermark_image_list||[])[0])||''
    if(d.type==='video'&&d.video_data&&d.video_data.nwm_video_url){
      var v=el('video');v.controls=true;v.playsInline=true;v.preload='metadata';v.setAttribute('playsinline','')
      if(cover)v.poster=cover
      v.src=d.video_data.nwm_video_url
      frame.appendChild(v)
    }else{
      var im0=el('img');im0.src=cover||firstImg;im0.alt='预览';im0.loading='lazy';frame.appendChild(im0)
    }
    frame.appendChild(el('span','badge',d.type==='image'?'图集':'视频'))
    card.appendChild(frame)

    var meta=el('div','meta')
    meta.appendChild(el('div','nick',(d.author&&d.author.nickname)||'未知作者'))
    if(d.desc)meta.appendChild(el('p','desc',d.desc))
    if(d.statistics){var s=d.statistics,st=el('div','stats')
      st.appendChild(stat('赞',s.digg_count));st.appendChild(stat('评',s.comment_count))
      st.appendChild(stat('藏',s.collect_count));st.appendChild(stat('转',s.share_count))
      meta.appendChild(st)}

    var acts=el('div','acts')
    if(d.type==='video'&&d.video_data){
      acts.appendChild(dlBtn(d.video_data.nwm_video_url,'下载无水印'))
      acts.appendChild(copyBtn(d.video_data.nwm_video_url,'复制直链'))
    }
    if(d.type==='image'&&d.image_data){
      (d.image_data.no_watermark_image_list||[]).forEach(function(u,i){acts.appendChild(dlBtn(u,'图'+(i+1)))})
    }
    var raw=el('button','btn ghost','原始 JSON')
    raw.addEventListener('click',function(){var p=$('#raw');if(!p){p=el('pre');p.id='raw';out.appendChild(p)}p.textContent=JSON.stringify(d,null,2)})
    acts.appendChild(raw)
    meta.appendChild(acts)
    card.appendChild(meta)
    out.appendChild(card)

    if(d.type==='image'&&d.image_data){
      var g=el('div','gallery')
      ;(d.image_data.no_watermark_image_list||[]).forEach(function(u){var a=el('a');a.href=u;a.target='_blank';a.rel='noopener';var im=el('img');im.src=u;im.loading='lazy';a.appendChild(im);g.appendChild(a)})
      out.appendChild(g)
    }
  }

  pasteBox.addEventListener('paste',function(){setTimeout(function(){parse(pasteBox.value)},0)})
  goBtn.addEventListener('click',function(){parse(pasteBox.value)})
  pasteBox.addEventListener('keydown',function(e){if((e.metaKey||e.ctrlKey)&&e.key==='Enter')parse(pasteBox.value)})

  // Prefill + auto-parse from ?u= (used by the admin "重解" link).
  var pre=new URLSearchParams(location.search).get('u')
  if(pre){pasteBox.value=pre;if((keyInput.value||'').trim())parse(pre)}
})();
</script>
</body>
</html>`
