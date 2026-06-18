// Internal cron entrypoint: POST /__edge_cron (RandallFlare convention —
// the edge agent calls this on the operator's schedule with an
// X-Edge-Cron-Expression header and NO token). Must respond 2xx.
//
// Since no token is available, this is made safe by being throttled,
// bounded, and idempotent/read-only: every action is a public-video parse
// that we'd serve anyway, just refreshed on a schedule. Jobs:
//   - refresh: re-parse the oldest-refreshed works -> new stats snapshots
//     (feeds the /work line chart) + fresh author follower points.
// Douyin has no reliable public "popular feed" we can mine without an
// app-signed client, so library growth is left to organic parses; the
// Bilibili worker additionally runs a grow job from its popular feed.
import { staleQueries, metaGet, metaSet } from '../utils/db.js'
import { ingestWork } from '../utils/ingest.js'
import { maybeFetchComments } from '../utils/comments.js'

const THROTTLE_MS = 50 * 1000
const REFRESH_BATCH = 8

export async function cronService (request, ctx) {
  const expr = request.headers.get('x-edge-cron-expression') || 'default'
  // Throttle: ignore bursts / external pokes within the window.
  const last = await metaGet(ctx, `cron:last:${expr}`)
  const now = Date.now()
  if (last && (now - last.ts) < THROTTLE_MS) {
    return json({ code: 200, skipped: 'throttled', expr })
  }
  await metaSet(ctx, `cron:last:${expr}`, now)

  if (!ctx.config.d1) {
    return json({ code: 200, skipped: 'no-d1', expr })
  }

  const run = (async () => {
    const stale = await staleQueries(ctx, REFRESH_BATCH)
    let ok = 0
    const errors = []
    for (const w of stale) {
      try {
        await ingestWork(ctx, request, w.platform, w.video_id, w.original_url, true, { warmVideo: false })
        await maybeFetchComments(ctx, w.platform, w.video_id)
        ok++
      } catch (e) {
        errors.push(`${w.platform}:${w.video_id} ${e?.message || e}`)
      }
    }
    await metaSet(ctx, `cron:stats:${expr}`, now)
    return { refreshed: ok, attempted: stale.length, errors: errors.slice(0, 5) }
  })()

  // Respond fast; let the batch finish in the background when possible.
  if (ctx.waitUntil) {
    ctx.waitUntil(run)
    return json({ code: 200, expr, started: true, batch: REFRESH_BATCH })
  }
  const result = await run
  return json({ code: 200, expr, ...result })
}

function json (obj) {
  return new Response(JSON.stringify(obj), {
    status: 200,
    headers: { 'content-type': 'application/json; charset=utf-8' }
  })
}
