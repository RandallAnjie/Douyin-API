# Douyin / TikTok API (RandallFlare worker)

API-only port of [Evil0ctal/Douyin_TikTok_Download_API](https://github.com/Evil0ctal/Douyin_TikTok_Download_API)
to a single [RandallFlare](../randallflare.md) / Cloudflare `workerd` worker.

- **Platforms**: Douyin web, TikTok web, TikTok app, plus the hybrid
  parser and a direct download endpoint. (Bilibili is intentionally
  out of scope.)
- **Cookies live in env** — no config file, no disk.
- **Auth** is meting-style: a master token or a per-request HMAC.
- **Signatures** (`a_bogus`, `X-Bogus`) are ported to pure JS and
  verified byte-for-byte against the upstream Python — see
  `test/parity.mjs`.

## Build

```bash
npm install
npm run build      # -> dist/worker.js  (deploy this to RandallFlare)
npm test           # signature parity vs Python reference
npm run test:e2e   # routing / auth / signature-URL assembly
```

`dist/worker.js` is a standard `export default { fetch }` module. Drop
it into a RandallFlare worker (or `wrangler` project with
`nodejs_compat`).

## Env bindings

| var | meaning | default |
|---|---|---|
| `DOUYIN_API_TOKEN` | HMAC secret / master token | `token` |
| `DOUYIN_COOKIE` | Douyin cookie string | *(empty — a `ttwid` is auto-bootstrapped)* |
| `TIKTOK_COOKIE` | TikTok cookie string | *(empty)* |
| `HTTP_PREFIX` | mount sub-path, e.g. `/v1` | *(empty)* |
| `DEFAULT_USER_AGENT` | override the signing UA (advanced) | Chrome 90 desktop |
| `LOG_LEVEL` | `info` / `debug` / … | `info` |

> The `a_bogus` / `X-Bogus` `ua_code` is baked against the default UA;
> only change `DEFAULT_USER_AGENT` if you know what you're doing.

## Auth

Every data endpoint (🔒 in the docs page) needs **either**:

- `?token=<DOUYIN_API_TOKEN>` — master key, opens everything; or
- `?auth=<hmac>` where
  `hmac = HMAC-SHA1(secret, "{platform}{route}{primaryId}")` in hex.

`primaryId` is the route's main identifier (`aweme_id`, `itemId`,
`sec_user_id`, `mix_id`, `room_id`, or the `url` for hybrid/download).
Token utilities (`generate_*`) and id extractors (`get_*`) are open.

Example:

```bash
# master token
curl 'https://host/api/douyin/web/fetch_one_video?aweme_id=7372484719365098803&token=SECRET'

# per-request HMAC (node)
node -e 'console.log(require("crypto").createHmac("sha1","SECRET").update("douyinfetch_one_video7372484719365098803").digest("hex"))'
```

## Endpoints

Open `/` (the worker root) for a full, live route index. Summary:

- `GET /api/douyin/web/{fetch_one_video,fetch_user_post_videos,fetch_user_like_videos,fetch_user_mix_videos,handler_user_profile,fetch_video_comments,fetch_video_comment_replies,fetch_user_live_videos,fetch_user_live_videos_by_room_id,fetch_live_gift_ranking}` 🔒
- `GET /api/douyin/web/{generate_real_msToken,generate_ttwid,generate_verify_fp,generate_s_v_web_id,generate_x_bogus,generate_a_bogus,get_aweme_id,get_sec_user_id,get_webcast_id}` + `POST get_all_*`
- `GET /api/tiktok/web/{fetch_one_video,fetch_user_profile,fetch_user_post,fetch_user_like,fetch_user_mix,fetch_user_play_list,fetch_post_comment,fetch_post_comment_reply,fetch_user_fans,fetch_user_follow}` 🔒
- `GET /api/tiktok/web/{generate_real_msToken,generate_ttwid,generate_xbogus,get_aweme_id,get_unique_id,get_sec_user_id}` + `POST get_all_*`
- `GET /api/tiktok/app/fetch_one_video` 🔒
- `GET /api/hybrid/video_data?url=&minimal=` 🔒
- `GET /download?url=&with_watermark=` 🔒 — streams the media file

Responses are wrapped as `{ code, router, params, data }`; `data` is
the upstream JSON verbatim (or the unified hybrid schema when
`minimal=true`).

## Notes

- `hybrid/update_cookie` returns 501 — the worker is stateless; rotate
  cookies via the env bindings instead.
- Without `DOUYIN_COOKIE`, the worker bootstraps a `ttwid` per request;
  this is enough for public single-video fetches but set a real cookie
  for anything rate-limited or login-walled.
