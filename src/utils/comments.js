// Comment ingestion — fetch top comments from upstream, normalize, and
// store in D1 (best-effort, async). Douyin + TikTok share the ByteDance
// comment shape. Read side is db.getComments.
import { storeComments, metaGet } from './db.js'
import * as douyin from '../douyin/crawler.js'
import * as tiktokWeb from '../tiktok/web/crawler.js'

const TTL = 6 * 3600 * 1000 // refetch a work's comments at most every 6h

function normalize (resp) {
  const list = resp?.comments || []
  return list.map(c => ({
    comment_id: c.cid,
    parent_id: null,
    text: c.text,
    author: c.user?.nickname || null,
    author_id: c.user?.sec_uid || (c.user?.uid != null ? String(c.user.uid) : null),
    avatar: c.user?.avatar_thumb?.url_list?.[0] || null,
    likes: c.digg_count ?? 0,
    ctime: c.create_time ?? null
  })).filter(c => c.comment_id)
}

async function fetchRaw (ctx, platform, id, count) {
  if (platform === 'tiktok') return tiktokWeb.fetchPostComment(ctx, id, 0, count, '')
  return douyin.fetchVideoComments(ctx, id, 0, count)
}

export async function fetchAndStoreComments (ctx, platform, id, { count = 50 } = {}) {
  try {
    const resp = await fetchRaw(ctx, platform, id, count)
    return await storeComments(ctx, platform, id, normalize(resp))
  } catch (e) {
    try { console.error('[comments] fetch failed', platform, id, e?.message || e) } catch {}
    return 0
  }
}

// Fetch only if we haven't fetched this work's comments within the TTL.
export async function maybeFetchComments (ctx, platform, id) {
  const m = await metaGet(ctx, `cmt:${platform}:${id}`)
  if (m && (Date.now() - m.ts) < TTL) return 0
  return fetchAndStoreComments(ctx, platform, id)
}
