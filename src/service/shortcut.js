// GET /shortcut — Chinese iOS Shortcut guide. Reuses the /docs page
// chrome (same type, colors, width) so it does not introduce a new
// visual language. Ready-made install link first; hand-built steps
// stay as the fallback.
import { proxyBase } from '../utils/proxy-link.js'

export const SHORTCUT_INSTALL_URL = 'https://www.icloud.com/shortcuts/d8c029c7084e49f78fe9e7735a237ed3'

export default async function shortcutService (request, ctx) {
  const origin = proxyBase(request, ctx)
  const html = PAGE.split('{{ORIGIN}}').join(origin).split('{{INSTALL}}').join(SHORTCUT_INSTALL_URL)
  return new Response(html, {
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8' }
  })
}

const PAGE = `<!doctype html>
<html lang=zh>
<head><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1">
<title>iOS 快捷指令 · 抖音转分享链接</title>
<style>
  body{font:15px/1.6 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:780px;margin:40px auto;padding:0 20px;color:#1c1c1e;background:#fbfbfa}
  h1{font-size:24px;margin-bottom:4px}
  h2{font-size:17px;margin-top:32px;border-bottom:1px solid #e5e3df;padding-bottom:6px}
  code{background:#f0eeea;padding:1px 5px;border-radius:4px;font-size:13px}
  .route{margin:6px 0}
  .m{display:inline-block;width:46px;font-weight:600;color:#8a6d3b}
  small{color:#8a857c}
  a{color:#3b6ea5}
  ol{padding-left:22px}
  li{margin:8px 0}
  .row{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin:8px 0}
  button{font:13px/1.4 inherit;background:#f0eeea;border:1px solid #e5e3df;border-radius:4px;padding:2px 8px;cursor:pointer;color:#3b6ea5}
  button:hover{background:#e5e3df}
  textarea{width:100%;min-height:88px;font:13px/1.5 ui-monospace,Menlo,Consolas,monospace;border:1px solid #e5e3df;border-radius:4px;padding:8px;box-sizing:border-box}
  pre.out{background:#f0eeea;padding:10px 12px;border-radius:4px;white-space:pre-wrap;word-break:break-all;min-height:2.4em}
</style></head>
<body>
<h1>抖音转分享链接</h1>
<small>用 iOS「快捷指令」把抖音 App 分享口令转成本站链接，发给微信 / 信息里的朋友。推荐直接添加现成指令；不想用现成的可以按下面手建。</small>

<h2>一键添加快捷指令</h2>
<p>推荐：点下面打开 iCloud，确认后即可添加到「快捷指令」。不用自己搭步骤。</p>
<div class=row>
  <a href="{{INSTALL}}" target="_blank" rel="noopener">一键添加快捷指令</a>
  <button type=button data-copy="{{INSTALL}}">复制链接</button>
</div>

<h2>不想用现成的？手动搭建</h2>
<p>下面约 5 步，在「快捷指令」里手建同一条指令。</p>

<h2>1. 新建快捷指令</h2>
<ol>
  <li>打开「快捷指令」App → 右上角「+」新建。</li>
  <li>名称填 <code>抖音转分享链接</code>。</li>
  <li>右上角 ⓘ → 打开「在分享表单中显示」。接受的类型勾选 <code>URL</code>、<code>文本</code>，以及 Safari「网页」（有则勾上）。</li>
</ol>

<h2>2. 从输入取文本</h2>
<p>添加操作 <code>获取输入的文本</code>（Get Text from Input），输入来源选 <code>快捷指令输入</code>（Shortcut Input）。抖音分享表单给的是一整段口令，这一步把它收成纯文本。</p>

<h2>3. 请求本站接口</h2>
<p>添加操作 <code>获取 URL 内容</code>（Get Contents of URL）：</p>
<ul>
  <li>URL（推荐 POST，口令里的中文不用自己编码）：</li>
</ul>
<div class=row>
  <code id=posturl>{{ORIGIN}}/api/share?format=text&amp;text_full=1</code>
  <button type=button data-copy="{{ORIGIN}}/api/share?format=text&text_full=1">复制</button>
</div>
<ul>
  <li>方法：<code>POST</code></li>
  <li>请求体：<code>文件</code> / <code>文本</code>，内容选上一步的文本。</li>
  <li>一般不用加 <code>token</code>。只有站点管理员打开了游客限流时，才需要把 <code>&amp;token=你的钥匙</code> 接到 URL 后面。</li>
</ul>
<p>GET 写法（先加一步 <code>URL 编码</code>，再拼到 <code>text=</code> 后面）：</p>
<div class=row>
  <code id=geturl>{{ORIGIN}}/api/share?format=text&amp;text_full=1&amp;text=</code>
  <button type=button data-copy="{{ORIGIN}}/api/share?format=text&text_full=1&text=">复制 GET 前缀</button>
</div>
<p><small><code>text_full=1</code> 会尽量回「标题 - @作者」加换行再加链接，方便直接转发给朋友；解析超过约 8 秒则只回链接。</small></p>

<h2>4. 复制到剪贴板</h2>
<p>添加操作 <code>拷贝到剪贴板</code>（Copy to Clipboard），内容为上一步的响应。</p>

<h2>5. 分享给朋友</h2>
<p>再添加 <code>分享</code>（Share），或 <code>显示通知</code>（Show Notification）。分享会弹出系统分享表，可选微信 / 信息 / 备忘录。</p>

<h2>变体：直接打开作品页</h2>
<p>把第 3 步的 <code>text_full=1</code> 去掉（只要一行链接），第 5 步改成 <code>打开 URL</code>（Open URLs）。或对下面这个地址做 GET，浏览器会 302 到 <code>/work</code>：</p>
<div class=row>
  <code>{{ORIGIN}}/api/share?format=redirect&amp;text=</code>
  <button type=button data-copy="{{ORIGIN}}/api/share?format=redirect&text=">复制</button>
</div>

<h2>从抖音里怎么点</h2>
<ol>
  <li>抖音 App 打开一条作品 → <code>分享</code> → <code>更多</code> → <code>快捷指令</code> → <code>抖音转分享链接</code>。</li>
  <li>跑完后选一个好友发出去。对方打开的是 <code>{{ORIGIN}}/work?platform=douyin&amp;id=…</code>，不是抖音短链。</li>
</ol>
<p>想少点两下：系统设置 → 辅助功能 → 触控 → <code>轻点背面</code>（Back Tap）把这个快捷指令挂上；或把快捷指令放到主屏幕小组件。</p>

<h2>试一下</h2>
<p>把抖音分享口令贴进来，走同一个 <code>/api/share</code>（<code>format=text&amp;text_full=1</code>）。</p>
<textarea id=try placeholder="3.05 复制打开抖音，看看【xxx的作品】 … https://v.douyin.com/AbCdEf/ F@a.Bc 05/12"></textarea>
<div class=row>
  <button type=button id=go>转换</button>
  <small>失败时下面会显示接口返回的原文。</small>
</div>
<pre class=out id=out></pre>

<p><small><a href="/">解析台</a> · <a href="/docs">接口文档</a> · <a href="/hot">热榜</a></small></p>
<script>
(function(){
  function copyText(t, btn){
    var done=function(){if(!btn)return;var o=btn.textContent;btn.textContent='已复制';setTimeout(function(){btn.textContent=o},1200)}
    if(navigator.clipboard&&navigator.clipboard.writeText){
      navigator.clipboard.writeText(t).then(done,function(){})
    }else{
      var ta=document.createElement('textarea');ta.value=t;document.body.appendChild(ta);ta.select()
      try{document.execCommand('copy');done()}catch(e){}
      document.body.removeChild(ta)
    }
  }
  document.querySelectorAll('[data-copy]').forEach(function(btn){
    btn.addEventListener('click',function(){copyText(btn.getAttribute('data-copy')||'',btn)})
  })
  var go=document.getElementById('go')
  var box=document.getElementById('try')
  var out=document.getElementById('out')
  if(go)go.addEventListener('click',function(){
    var text=box.value||''
    out.textContent='请求中…'
    fetch('/api/share?format=text&text_full=1',{
      method:'POST',
      headers:{'content-type':'text/plain; charset=utf-8'},
      body:text
    }).then(function(r){return r.text().then(function(t){out.textContent=t})})
     .catch(function(e){out.textContent=e.message||String(e)})
  })
})();
</script>
</body></html>`
