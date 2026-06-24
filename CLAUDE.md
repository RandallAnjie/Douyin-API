# CLAUDE.md

Guidance for Claude Code when working in this repo.

## What this is

API-only port of `Evil0ctal/Douyin_TikTok_Download_API` (Python/FastAPI
crawler) to a single RandallFlare / Cloudflare `workerd` worker. Sibling
of `/root/Meting-API` and follows the same worker conventions: `export
default { fetch }`, env-driven config, esbuild bundle to `dist/worker.js`,
meting-style HMAC auth.

Scope: Douyin web + TikTok web + TikTok app + hybrid + download. **No
Bilibili.**

## Commands

```bash
npm run build      # esbuild -> dist/worker.js (commit this)
npm test           # signature parity vs Python reference values
npm run test:e2e   # routing / auth / signature-URL assembly
npm run lint       # oxlint (dist/ + node_modules ignored)
```

Always `npm run build` after changing `src/` — `dist/worker.js` is the
deployed artifact and is committed.

## Architecture

```
src/worker.js     entry: CORS, buildConfig, hand off to router
src/router.js     path -> service (prefix-aware)
src/config.js     env -> config (token, cookies, UA)
src/middleware/   logger + error handler (JSON envelope, x-error-message)
src/sign/         abogus.js (a_bogus), xbogus.js (X-Bogus), _common.js (rc4/md5/base64)
src/lib/          pure-JS crypto: sm3.js (a_bogus), md5.js (X-Bogus),
                  sha1.js (sha1 + hmacSha1 for auth) — NO node:crypto,
                  so the worker boots without the nodejs_compat flag
src/utils/        auth, params (urlencode/rawJoin + default param sets),
                  base-crawler (fetch wrapper), ids (redirect resolution),
                  tokens (ttwid/msToken/verify_fp), http-exception, respond
src/douyin/       endpoints + crawler
src/tiktok/web/   endpoints + crawler   (X-Bogus)
src/tiktok/app/   crawler               (api22 feed, no signature)
src/hybrid/       crawler (detect + by-id fetch + pure toMinimal mapper + resolveKindUrl)
src/service/      douyin.js / tiktok.js / hybrid.js / proxy.js / app.js (解析台) / admin.js / docs.js
src/utils/db.js   D1 query log (logQuery upsert + recentQueries); no-ops without DOUYIN_D1
src/utils/r2cache.js    R2 bytes (serveFromR2/teeIntoCache/cachePopulateAside) + JSON (getJson/putJson)
src/utils/meta-cache.js cached douyin/tiktok fetchers (meta/{platform}/{id}.json, TTL via R2 uploaded)
src/utils/proxy-link.js rewrite minimal media URLs -> /proxy self-links with per-resource HMAC
```

## Reverse proxy + R2 cache

Optional, gated on the `DOUYIN_R2` binding (config `mediaR2`); when
unbound everything degrades to uncached real-time fetches.

- **Metadata cache**: parsed video info as JSON at `meta/{platform}/{id}.json`,
  TTL `config.cache.metaTtl` (`META_CACHE_TTL`, default 1h), freshness
  from R2's `uploaded` time. Used by `fetch_one_video` (douyin + tiktok
  app), `hybrid/video_data`, `/proxy`. `?refresh=1` bypasses.
- **Media proxy** `/proxy?platform=&id=&kind=`: cache key is the STABLE
  id (`media/{platform}/{id}/{kind}`), NOT the signed CDN URL — so hits
  survive URL rotation. Resolves the live URL from cached metadata on
  miss via `hybrid/crawler.js` `fetchRawById`+`toMinimal`+`resolveKindUrl`.
  Range supported (cachePopulateAside for range misses).
- Proxy auth canonical is `"proxy{platform}{id}"` (kind-independent).
  `video_data?proxy=1` rewrites media URLs to `/proxy?...&auth=` links
  (per-resource HMAC, never the master token).
- `test/r2-live.mjs` exercises this against live Douyin + a fake R2.

## Signatures — the load-bearing part

`a_bogus` and `X-Bogus` are exact ports and **must stay byte-identical**
to the upstream. `test/parity.mjs` pins reference values captured from
the Python implementation with fixed time/random. Run `npm test` after
*any* change under `src/sign/` or `src/lib/sm3.js`.

Critical invariants (already handled — don't regress):

- **Signature split mirrors the source exactly.** Douyin: only
  `fetch_one_video` / `fetch_user_post_videos` / `fetch_user_like_videos`
  use `a_bogus`; everything else uses `X-Bogus`. TikTok web is all
  `X-Bogus`; TikTok app is unsigned.
- **a_bogus path** signs `urlencode(params)` (quote_plus) and puts that
  *same* string in the URL. **X-Bogus path** signs the raw `k=v&k=v`
  join (no escaping) — `params.js` exposes both `urlencode` and
  `rawJoin`; use the right one per path.
- **a_bogus internals**: RC4 plaintext/ciphertext code points can exceed
  255 (timestamp high bytes), so they are NOT masked to 8 bits; large
  timestamp shifts use division+modulo (JS `>>` is 32-bit). Param order
  mirrors pydantic field order.
- The signing UA (`config.douyin.userAgent`, default Chrome 90) is what
  the baked `ua_code` corresponds to.

## Auth

`src/utils/auth.js`: authorized if `?token` == secret (master) or
`?auth` == `HMAC-SHA1(secret, "{platform}{route}{primaryId}")`. Mirror of
`Meting-API/src/service/api.js`. Data endpoints call `requireAuth`;
`generate_*` / `get_*` are open.

### Guest mode

`/api/hybrid/video_data` (the parser path) additionally allows
unauthenticated guests: `isAuthorised()` false → guest branch in
`service/hybrid.js`. Guests are forced to `minimal=true` + `proxy=1` +
no `refresh` (never raw JSON), get TEMPORARY proxy links (`proxyLink`
with `expSec` → `&exp=` + HMAC over `proxy{platform}{id}{exp}`, checked
by `requireProxyAuth`), and are IP rate-limited (`rateLimitHit` prefers
`DOUYIN_KV`, falls back to `DOUYIN_D1`; no store → 503) and respect
`GUEST_ENABLED`. The raw per-platform `/api/douyin|tiktok/*` endpoints
and `/admin` stay token-only.

## Aggregation platform (D1-backed, public reads)

Beyond parsing, the worker is an in-site content index. All read pages
are public (no token); only parsing/writes use guest+auth.

- `/discover` + `/api/discover` — recently parsed works (hot/recent).
- `/work?platform=&id=` + `/api/work` — one work: author, publish time,
  tags (话题 chips), BGM, stats KPIs, a stats line chart from
  `stats_history`, and 热门评论 (`/api/comments`).
- `/search?q=` + `/api/search` — LIKE over description/author/tags.
- `/author?platform=&id=` + `/api/author` — profile, follower trend
  (`author_stats_history`), and the author's works grid.
- `/api/comments?platform=&id=` — cached comments (D1); lazily populated
  (rate-limited) on first read, and refreshed async on every parse (6h TTL).

D1 schema lives in `src/utils/db.js` `ensureSchema` (queries + authors +
stats_history + author_stats_history + comments + kv_meta). `ingest.js` is
the single fetch→map→logQuery path shared by the parser and cron.

### Cron (`POST /__edge_cron`)

RandallFlare convention: the edge agent POSTs `/__edge_cron` with an
`X-Edge-Cron-Expression` header and **no token** (see memory
`project_bigrandall_cron_convention`). Configure the schedule in the
worker backend. The handler is throttled (50s/expr), bounded (8 works/run)
and idempotent: it re-parses the oldest works to append fresh
`stats_history` snapshots (grows the line charts) + refreshes comments.
Library growth: the Douyin **app-domain recommend feed**
(`aweme.snssdk.com/aweme/v1/feed/`, unsigned — see `src/douyin/app/`)
yields ~25 real hot videos per run, and the TikTok FYP feed grows the
TikTok side. The old web-search growth path is gone (it only returned
keywords and hit risk-control 2483).

Admins can trigger a run by hand for testing: `GET /api/admin/cron?token=`
(master token) runs synchronously, bypasses the throttle, and returns the
batch result. `?only=hot` refreshes just the 热榜 board, `?only=grow` just
the library growth.

### 热榜 (`/hot` + `/api/douyin/hot`)

热门视频 (recommend feed) + 热搜榜 + 热歌榜, from the unsigned app-domain
endpoints (`feed`, `hot/search/list`, `chart/music/list`). **Upstream
fetch is cron-only** (`refreshHotBoard` stores the board in `kv_meta`);
the public API reads D1 only and returns `{pending:true}` on a cold miss
(master `?token=` may warm it live). 热门视频 cards parse + store on click
(guest path → lightbox); 热搜/热歌 deep-link into our own `/search`
(Douyin exposes no per-topic video list). Covers via the `/img` proxy.

## Conventions

- Cookies/secrets only from env (`DOUYIN_COOKIE`, `TIKTOK_COOKIE`,
  `DOUYIN_API_TOKEN`) — never a config file or disk.
- Code/comments in English; keep ASCII-safe strings (no nested quote
  chars inside template literals).
- No `update_cookie` persistence — stateless worker, returns 501.
