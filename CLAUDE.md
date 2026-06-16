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
src/lib/sm3.js    pure-JS SM3 (a_bogus needs it; not in node:crypto)
src/utils/        auth, params (urlencode/rawJoin + default param sets),
                  base-crawler (fetch wrapper), ids (redirect resolution),
                  tokens (ttwid/msToken/verify_fp), http-exception, respond
src/douyin/       endpoints + crawler
src/tiktok/web/   endpoints + crawler   (X-Bogus)
src/tiktok/app/   crawler               (api22 feed, no signature)
src/hybrid/       crawler (detect + minimal field mapping)
src/service/      douyin.js / tiktok.js / hybrid.js / docs.js  (route handlers + auth)
```

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

## Conventions

- Cookies/secrets only from env (`DOUYIN_COOKIE`, `TIKTOK_COOKIE`,
  `DOUYIN_API_TOKEN`) — never a config file or disk.
- Code/comments in English; keep ASCII-safe strings (no nested quote
  chars inside template literals).
- No `update_cookie` persistence — stateless worker, returns 501.
