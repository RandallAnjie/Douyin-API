// Internal cron entrypoint: POST /__edge_cron (RandallFlare convention —
// the edge agent calls this on the operator's schedule with an
// X-Edge-Cron-Expression header and NO token). Must respond 2xx.
//
// Job: pull each platform's hot ranking and ingest + DOWNLOAD (cache media
// into R2) the top items — growing the in-site library from what's
// trending. It does NOT refresh already-stored works.
//
//   - TikTok: the app trending feed (FYP) → real hot videos.
//   - Douyin: its public "hot" endpoint only returns trending KEYWORDS,
//     not videos, and the web has no minable hot-video feed without a
//     fragile search-per-keyword flow — so Douyin growth stays organic
//     (parsed on demand). Logged as skipped.
//
// Safe by being throttled + bounded + idempotent.
import { metaGet, metaSet } from '../utils/db.js'
import { ingestWork } from '../utils/ingest.js'
import * as tiktokApp from '../tiktok/app/crawler.js'

const THROTTLE_MS = 50 * 1000
const HOT_BATCH = 10

export async function cronService (request, ctx) {
  const expr = request.headers.get('x-edge-cron-expression') || 'default'
  const last = await metaGet(ctx, `cron:last:${expr}`)
  const now = Date.now()
  if (last && (now - last.ts) < THROTTLE_MS) {
    return json({ code: 200, skipped: 'throttled', expr })
  }
  await metaSet(ctx, `cron:last:${expr}`, now)
  if (!ctx.config.d1) return json({ code: 200, skipped: 'no-d1', expr })

  const run = (async () => {
    let grown = 0
    const errors = []
    // TikTok trending feed → ingest + download.
    try {
      const feed = await tiktokApp.fetchTrendingFeed(ctx, HOT_BATCH)
      for (const aweme of feed) {
        if (grown >= HOT_BATCH) break
        const id = aweme?.aweme_id
        if (!id) continue
        try {
          await ingestWork(ctx, request, 'tiktok', id, `https://www.tiktok.com/@/video/${id}`, false)
          grown++
        } catch (e) { errors.push(`tiktok ${id} ${e?.message || e}`) }
      }
    } catch (e) { errors.push(`tiktok-feed ${e?.message || e}`) }
    await metaSet(ctx, `cron:hot:${expr}`, now)
    return { grown, douyin: 'skipped (no public hot-video feed)', errors: errors.slice(0, 5) }
  })()

  if (ctx.waitUntil) {
    ctx.waitUntil(run)
    return json({ code: 200, expr, started: true, hotBatch: HOT_BATCH })
  }
  return json({ code: 200, expr, ...(await run) })
}

function json (obj) {
  return new Response(JSON.stringify(obj), { status: 200, headers: { 'content-type': 'application/json; charset=utf-8' } })
}
