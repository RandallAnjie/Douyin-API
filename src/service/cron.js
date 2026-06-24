// Internal cron entrypoint: POST /__edge_cron (RandallFlare convention —
// the edge agent calls this on the operator's schedule with an
// X-Edge-Cron-Expression header and NO token). Must respond 2xx.
//
// Grows the in-site library from what's trending and DOWNLOADS media into
// R2. It does NOT refresh on a fixed schedule, but re-ingesting an item
// that's already cached just updates its info (warmUrl skips the download).
//
//   - TikTok: app trending feed (FYP) → real hot videos.
//   - Douyin: the app-domain recommend feed (aweme.snssdk.com/aweme/v1/feed)
//     → real hot videos, unsigned. This replaces the old web-search path,
//     which only yielded keywords and hit risk-control 2483.
//
// Throttled + bounded + idempotent.
import { metaGet, metaSet } from '../utils/db.js'
import { ingestWork } from '../utils/ingest.js'
import * as tiktokApp from '../tiktok/app/crawler.js'
import * as douyinApp from '../douyin/app/crawler.js'

const THROTTLE_MS = 50 * 1000
const TT_BATCH = 25
const DY_BATCH = 25

export async function cronService (request, ctx) {
  const url = new URL(request.url)
  const sync = url.searchParams.get('sync') === '1' && url.searchParams.get('token') === ctx.config.auth.token
  const expr = request.headers.get('x-edge-cron-expression') || 'default'
  const last = await metaGet(ctx, `cron:last:${expr}`)
  const now = Date.now()
  if (last && (now - last.ts) < THROTTLE_MS && !sync) {
    return json({ code: 200, skipped: 'throttled', expr })
  }
  await metaSet(ctx, `cron:last:${expr}`, now)
  if (!ctx.config.d1) return json({ code: 200, skipped: 'no-d1', expr })

  const run = (async () => {
    let tiktok = 0
    let dy = 0
    const errors = []

    // TikTok trending feed (off by default — static device id gets 429).
    if (ctx.config.cron.tiktokHot || sync) try {
      const feed = await tiktokApp.fetchTrendingFeed(ctx, TT_BATCH)
      for (const aweme of feed) {
        if (tiktok >= TT_BATCH) break
        const id = aweme?.aweme_id
        if (!id) continue
        try {
          // Ingest the feed object directly — no per-id re-fetch (avoids 429).
          await ingestWork(ctx, request, 'tiktok', id, `https://www.tiktok.com/@/video/${id}`, false, { raw: aweme })
          tiktok++
        } catch (e) { errors.push(`tiktok ${id} ${e?.message || e}`) }
      }
    } catch (e) { errors.push(`tiktok-feed ${e?.message || e}`) }

    // Douyin: app-domain recommend feed -> real hot videos, unsigned. The
    // feed returns full aweme objects, so we ingest them directly (no per-id
    // re-fetch), the same way the TikTok FYP path does.
    try {
      const feed = await douyinApp.fetchAppFeed(ctx, DY_BATCH)
      for (const aweme of feed) {
        if (dy >= DY_BATCH) break
        const id = aweme?.aweme_id
        if (!id) continue
        try {
          await ingestWork(ctx, request, 'douyin', id, `https://www.douyin.com/video/${id}`, false, { raw: aweme })
          dy++
        } catch (e) { errors.push(`douyin ${id} ${e?.message || e}`) }
      }
    } catch (e) { errors.push(`douyin-feed ${e?.message || e}`) }

    await metaSet(ctx, `cron:hot:${expr}`, now)
    return { tiktok, douyin: dy, errors: errors.slice(0, 6) }
  })()

  // ?sync=1 (master token) awaits the batch and returns the result — for
  // manually checking what the cron actually fetched.
  if (ctx.waitUntil && !sync) {
    ctx.waitUntil(run)
    return json({ code: 200, expr, started: true, ttBatch: TT_BATCH, dyBatch: DY_BATCH })
  }
  return json({ code: 200, expr, ...(await run) })
}

function json (obj) {
  return new Response(JSON.stringify(obj), { status: 200, headers: { 'content-type': 'application/json; charset=utf-8' } })
}
