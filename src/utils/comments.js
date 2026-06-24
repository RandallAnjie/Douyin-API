// Comment ingestion — fetch top comments + one level of replies, normalize,
// and store in D1 (best-effort, async). Douyin + TikTok share the ByteDance
// comment shape. Read side is db.getComments (nested).
import { storeComments, metaGet } from './db.js'
import * as douyin from '../douyin/crawler.js'
import * as tiktokWeb from '../tiktok/web/crawler.js'

const TTL = 6 * 3600 * 1000 // refetch a work's comments at most every 6h
const TOP_REPLY_FETCH = 10 // top comments to fetch full replies for

function mapBD (c, parentId) {
  return {
    comment_id: c.cid,
    parent_id: parentId || null,
    text: c.text,
    author: c.user?.nickname || null,
    author_id: c.user?.sec_uid || (c.user?.uid != null ? String(c.user.uid) : null),
    avatar: c.user?.avatar_thumb?.url_list?.[0] || null,
    likes: c.digg_count ?? 0,
    ctime: c.create_time ?? null
  }
}

async function collect (ctx, platform, id, count) {
  const resp = platform === 'tiktok'
    ? await tiktokWeb.fetchPostComment(ctx, id, 0, count, '')
    : await douyin.fetchVideoComments(ctx, id, 0, count)
  const list = resp?.comments || []
  const out = list.map(c => mapBD(c, null))
  // inline reply previews
  for (const c of list) for (const rc of (c.reply_comment || [])) out.push(mapBD(rc, c.cid))
  // fetch full replies for the top comments that have more than the preview
  for (const c of list.slice(0, TOP_REPLY_FETCH)) {
    if ((c.reply_comment_total ?? 0) > (c.reply_comment?.length || 0)) {
      try {
        const rr = platform === 'tiktok'
          ? await tiktokWeb.fetchPostCommentReply(ctx, id, c.cid, 0, 10, '')
          : await douyin.fetchVideoCommentReplies(ctx, id, c.cid, 0, 10)
        for (const rc of (rr?.comments || [])) out.push(mapBD(rc, c.cid))
      } catch {}
    }
  }
  return out.filter(c => c.comment_id)
}

export async function fetchAndStoreComments (ctx, platform, id, { count = 50 } = {}) {
  try {
    return await storeComments(ctx, platform, id, await collect(ctx, platform, id, count))
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
