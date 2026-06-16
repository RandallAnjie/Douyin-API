// Root docs page — a hand-written, plain-HTML index of the API. No
// framework, no template engine; just a string. Lists every route and
// explains the meting-style auth (?token= master key, or ?auth= HMAC).

export default async function docsService (request, ctx) {
  const tokenSource = ctx.config.auth.tokenSource
  const html = renderDocs(tokenSource)
  return new Response(html, {
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8' }
  })
}

function renderDocs (tokenSource) {
  return DOCS_HTML.replace('{{TOKEN_SOURCE}}', tokenSource)
}

const DOCS_HTML = `<!doctype html>
<html lang=zh>
<head><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1">
<title>Douyin / TikTok API</title>
<style>
  body{font:15px/1.6 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:780px;margin:40px auto;padding:0 20px;color:#1c1c1e;background:#fbfbfa}
  h1{font-size:24px;margin-bottom:4px}
  h2{font-size:17px;margin-top:32px;border-bottom:1px solid #e5e3df;padding-bottom:6px}
  code{background:#f0eeea;padding:1px 5px;border-radius:4px;font-size:13px}
  .route{margin:6px 0}
  .m{display:inline-block;width:46px;font-weight:600;color:#8a6d3b}
  .lock{color:#b94a48}
  small{color:#8a857c}
  a{color:#3b6ea5}
</style></head>
<body>
<h1>Douyin / TikTok API</h1>
<small>RandallFlare worker · port of Evil0ctal/Douyin_TikTok_Download_API · token source: <code>{{TOKEN_SOURCE}}</code></small>

<h2>鉴权 / Auth</h2>
<p>带 <span class=lock>锁</span> 的接口需要鉴权，两种方式任选其一（与 Meting-API 一致）：</p>
<ul>
  <li>master key：<code>?token=&lt;DOUYIN_API_TOKEN&gt;</code></li>
  <li>per-request HMAC：<code>?auth=&lt;HMAC-SHA1(secret, "{platform}{route}{primaryId}")&gt;</code>（hex）</li>
</ul>
<p>primaryId 为该接口主标识（如 fetch_one_video 的 aweme_id、tiktok fetch_one_video 的 itemId、hybrid 的 url）。</p>

<h2>Douyin Web <small>/api/douyin/web</small></h2>
<div class=route><span class=m>GET</span><span class=lock>🔒</span> <code>/fetch_one_video?aweme_id=</code></div>
<div class=route><span class=m>GET</span><span class=lock>🔒</span> <code>/fetch_user_post_videos?sec_user_id=&max_cursor=0&count=20</code></div>
<div class=route><span class=m>GET</span><span class=lock>🔒</span> <code>/fetch_user_like_videos?sec_user_id=&max_cursor=0&counts=20</code></div>
<div class=route><span class=m>GET</span><span class=lock>🔒</span> <code>/fetch_user_mix_videos?mix_id=&max_cursor=0&counts=20</code></div>
<div class=route><span class=m>GET</span><span class=lock>🔒</span> <code>/handler_user_profile?sec_user_id=</code></div>
<div class=route><span class=m>GET</span><span class=lock>🔒</span> <code>/fetch_video_comments?aweme_id=&cursor=0&count=20</code></div>
<div class=route><span class=m>GET</span><span class=lock>🔒</span> <code>/fetch_video_comment_replies?item_id=&comment_id=&cursor=0&count=20</code></div>
<div class=route><span class=m>GET</span><span class=lock>🔒</span> <code>/fetch_user_live_videos?webcast_id=</code></div>
<div class=route><span class=m>GET</span><span class=lock>🔒</span> <code>/fetch_user_live_videos_by_room_id?room_id=</code></div>
<div class=route><span class=m>GET</span><span class=lock>🔒</span> <code>/fetch_live_gift_ranking?room_id=&rank_type=30</code></div>
<div class=route><span class=m>GET</span> <code>/generate_real_msToken</code> · <code>/generate_ttwid</code> · <code>/generate_verify_fp</code> · <code>/generate_s_v_web_id</code></div>
<div class=route><span class=m>GET</span> <code>/generate_x_bogus?url=&user_agent=</code> · <code>/generate_a_bogus?url=&user_agent=</code></div>
<div class=route><span class=m>GET</span> <code>/get_aweme_id?url=</code> · <code>/get_sec_user_id?url=</code> · <code>/get_webcast_id?url=</code></div>
<div class=route><span class=m>POST</span> <code>/get_all_aweme_id</code> · <code>/get_all_sec_user_id</code> · <code>/get_all_webcast_id</code> <small>(body: ["url", ...])</small></div>

<h2>TikTok Web <small>/api/tiktok/web</small></h2>
<div class=route><span class=m>GET</span><span class=lock>🔒</span> <code>/fetch_one_video?itemId=</code></div>
<div class=route><span class=m>GET</span><span class=lock>🔒</span> <code>/fetch_user_profile?secUid=&uniqueId=</code></div>
<div class=route><span class=m>GET</span><span class=lock>🔒</span> <code>/fetch_user_post?secUid=&cursor=0&count=35</code></div>
<div class=route><span class=m>GET</span><span class=lock>🔒</span> <code>/fetch_user_like?secUid=&cursor=0&count=35</code></div>
<div class=route><span class=m>GET</span><span class=lock>🔒</span> <code>/fetch_user_mix?mixId=&cursor=0&count=30</code></div>
<div class=route><span class=m>GET</span><span class=lock>🔒</span> <code>/fetch_post_comment?aweme_id=&cursor=0&count=20</code></div>
<div class=route><span class=m>GET</span><span class=lock>🔒</span> <code>/fetch_post_comment_reply?item_id=&comment_id=&cursor=0&count=20</code></div>
<div class=route><span class=m>GET</span><span class=lock>🔒</span> <code>/fetch_user_fans?secUid=&count=30</code> · <code>/fetch_user_follow?secUid=&count=30</code></div>
<div class=route><span class=m>GET</span> <code>/generate_real_msToken</code> · <code>/generate_ttwid?cookie=</code> · <code>/generate_xbogus?url=&user_agent=</code></div>
<div class=route><span class=m>GET</span> <code>/get_aweme_id?url=</code> · <code>/get_sec_user_id?url=</code> · <code>/get_unique_id?url=</code> (+ POST get_all_*)</div>

<h2>TikTok App <small>/api/tiktok/app</small></h2>
<div class=route><span class=m>GET</span><span class=lock>🔒</span> <code>/fetch_one_video?aweme_id=</code></div>

<h2>Hybrid <small>/api/hybrid</small></h2>
<div class=route><span class=m>GET</span><span class=lock>🔒</span> <code>/video_data?url=&minimal=false&refresh=0&proxy=0</code> <small>自动识别 douyin/tiktok</small></div>
<small>minimal=true 返回统一精简结构；proxy=1（需 minimal=true）把媒体直链改写成下面的 /proxy 缓存链接；refresh=1 跳过元数据缓存强刷。</small>

<h2>Download</h2>
<div class=route><span class=m>GET</span><span class=lock>🔒</span> <code>/download?url=&with_watermark=false</code> <small>直接 stream 视频/图片</small></div>

<h2>反代 + R2 缓存 <small>/proxy</small></h2>
<div class=route><span class=m>GET</span><span class=lock>🔒</span> <code>/proxy?platform=douyin|tiktok&id=&kind=nwm&download=0&refresh=0</code></div>
<small>
按 ID 稳定缓存的媒体反代：worker 用正确的 Referer 拉取 CDN 字节并存入 R2（key = <code>media/{platform}/{id}/{kind}</code>），签名 url 过期也照样命中；支持 Range（视频拖动）。<br>
kind: <code>nwm</code>（无水印视频 HQ）· <code>wm</code>（有水印视频）· <code>cover</code>（封面）· <code>image0/1/…</code>（无水印图）· <code>imagewm0/1/…</code>（有水印图）。<br>
鉴权签名串为 <code>"proxy{platform}{id}"</code>（与 kind 无关，一个 auth 覆盖该作品所有 kind）。video_data?proxy=1 重写出的链接已自带 <code>&auth=</code>，可直接当播放器 src。<br>
元数据（解析后的视频信息）以 JSON 文件缓存在 R2 <code>meta/{platform}/{id}.json</code>，默认 1 小时（env <code>META_CACHE_TTL</code> 可调，<code>?refresh=1</code> 强刷）。需要绑定 R2：env <code>DOUYIN_R2</code>（未绑定则全部退化为不缓存、实时直连）。
</small>

</body></html>`
