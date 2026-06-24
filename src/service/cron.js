// Internal cron entrypoint: POST /__edge_cron (RandallFlare convention —
// the edge agent calls this on the operator's schedule with an
// X-Edge-Cron-Expression header and NO token). Must respond 2xx.
//
// Grows the in-site library from what's trending and DOWNLOADS media into
// R2. It does NOT refresh on a fixed schedule, but re-ingesting an item
// that's already cached just updates its info (warmUrl skips the download).
//
//   - TikTok: app trending feed (FYP) → real hot videos.
//   - Douyin: the hot board only returns trending KEYWORDS, so we search
//     each top keyword and take the first few videos.
//
// Throttled + bounded + idempotent.
import { metaGet, metaSet } from '../utils/db.js'
import { ingestWork } from '../utils/ingest.js'
import * as tiktokApp from '../tiktok/app/crawler.js'
import * as douyin from '../douyin/crawler.js'

const THROTTLE_MS = 50 * 1000
const TT_BATCH = 25
const DY_KEYWORDS = 6
const DY_PER_KEYWORD = 8

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

    // Douyin: hot keywords -> search -> top N videos each (off by default —
    // search hits risk-control 2483 without a full logged-in cookie).
    if (ctx.config.cron.douyinHot || sync) try {
      const hot = await douyin.fetchHotSearchList(ctx)
      const words = (hot?.data?.word_list || []).map(w => w.word).filter(Boolean).slice(0, DY_KEYWORDS)
      for (const kw of words) {
        try {
          const sr = await douyin.fetchGeneralSearch(ctx, kw, 0, 10)
          if (sr?.status_code && sr.status_code !== 0) {
            errors.push(`search "${kw}" status_code ${sr.status_code} (risk control?)`)
            continue
          }
          const arr = Array.isArray(sr?.data) ? sr.data : (sr?.data?.data || [])
          const ids = arr
            .map(x => x.aweme_info?.aweme_id || x.aweme?.aweme_id || x.aweme_id)
            .filter(Boolean)
            .slice(0, DY_PER_KEYWORD)
          for (const id of ids) {
            try {
              await ingestWork(ctx, request, 'douyin', id, `https://www.douyin.com/video/${id}`, false)
              dy++
            } catch (e) { errors.push(`douyin ${id} ${e?.message || e}`) }
          }
        } catch (e) { errors.push(`search "${kw}" ${e?.message || e}`) }
      }
    } catch (e) { errors.push(`douyin-hot ${e?.message || e}`) }

    await metaSet(ctx, `cron:hot:${expr}`, now)
    return { tiktok, douyin: dy, errors: errors.slice(0, 6) }
  })()

  // ?sync=1 (master token) awaits the batch and returns the result — for
  // manually checking what the cron actually fetched.
  if (ctx.waitUntil && !sync) {
    ctx.waitUntil(run)
    return json({ code: 200, expr, started: true, ttBatch: TT_BATCH, dyKeywords: DY_KEYWORDS })
  }
  return json({ code: 200, expr, ...(await run) })
}

function json (obj) {
  return new Response(JSON.stringify(obj), { status: 200, headers: { 'content-type': 'application/json; charset=utf-8' } })
}
