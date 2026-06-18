// Shared ingest: fetch a work's raw detail by id, map to minimal, and log
// it into the D1 aggregation layer (queries/authors/stats_history). Used
// by the live parser (service/hybrid.js) and the cron refresher
// (service/cron.js) so both produce identical rows + stats snapshots.
import { fetchRawById, toMinimal, mediaCandidates } from '../hybrid/crawler.js'
import { proxyLink } from './proxy-link.js'
import { logQuery } from './db.js'
import { warmUrl, mediaKey } from './r2cache.js'

// Proactively warm a parsed work's media into R2 so discover/search/work
// resources are served from cache, not the source CDN. Best-effort +
// deduped; pass warmVideo=false (cron) to skip the heavy video download.
function warmMedia (ctx, platform, id, raw, min, warmVideo) {
  const bucket = ctx.config.mediaR2
  if (!bucket) return
  const headers = {
    'User-Agent': platform === 'douyin' ? ctx.config.douyin.userAgent : ctx.config.tiktok.userAgent,
    Referer: platform === 'douyin' ? 'https://www.douyin.com/' : 'https://www.tiktok.com/'
  }
  const kinds = ['cover', 'avatar']
  if (min.type === 'image' && min.image_data) {
    min.image_data.no_watermark_image_list.forEach((_, i) => kinds.push(`image${i}`))
  } else if (warmVideo) {
    kinds.push('nwm')
  }
  for (const kind of kinds) {
    const cands = mediaCandidates(platform, raw, kind)
    const ct = (kind === 'nwm') ? 'video/mp4' : 'image/jpeg'
    if (cands.length) warmUrl(ctx, bucket, mediaKey(platform, id, kind), cands[0], headers, ct)
  }
}

export async function ingestWork (ctx, request, platform, id, target, refresh = false, opts = {}) {
  const { raw, cached } = await fetchRawById(ctx, platform, id, refresh)
  const min = toMinimal(platform, id, raw)
  const a = min.author || {}
  const s = min.statistics || {}
  await logQuery(ctx, {
    platform,
    video_id: id,
    type: min.type,
    author: a.nickname || null,
    authorInfo: (a.sec_uid || a.uid)
      ? {
          id: a.sec_uid || String(a.uid),
          name: a.nickname || null,
          avatar: proxyLink(request, ctx, platform, id, 'avatar'),
          extra: { follower: a.follower_count, signature: a.signature, uid: a.uid, sec_uid: a.sec_uid }
        }
      : null,
    create_time: min.create_time || null,
    stats: {
      play: s.play_count, digg: s.digg_count, comment: s.comment_count,
      share: s.share_count, collect: s.collect_count
    },
    tags: Array.isArray(raw.text_extra)
      ? raw.text_extra.map(t => t.hashtag_name).filter(Boolean)
      : null,
    music: raw.music ? { id: raw.music.id, title: raw.music.title, author: raw.music.author } : null,
    description: min.desc || null,
    original_url: target,
    cover: proxyLink(request, ctx, platform, id, 'cover'),
    play: min.type === 'video' ? proxyLink(request, ctx, platform, id, 'nwm') : null,
    duration: raw.duration ? Math.round(raw.duration / 1000) : null,
    extra: {
      stats: min.statistics || null,
      images: min.type === 'image' && min.image_data
        ? min.image_data.no_watermark_image_list.map((_, i) => proxyLink(request, ctx, platform, id, `image${i}`))
        : undefined
    }
  })
  // Proactively cache the work's media into R2 (best-effort, background).
  warmMedia(ctx, platform, id, raw, min, opts.warmVideo !== false)
  return { raw, min, cached }
}
