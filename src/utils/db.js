// D1 query log — records each hybrid/video_data parse so /admin can show
// recent queries and their content. All helpers no-op when no D1 binding
// is bound (ctx.config.d1 === null), so the rest of the app is unaffected.

let schemaReady = false

async function ensureSchema (db) {
  if (schemaReady) return
  await db.prepare(`CREATE TABLE IF NOT EXISTS queries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    platform TEXT NOT NULL,
    video_id TEXT NOT NULL,
    type TEXT,
    author TEXT,
    description TEXT,
    original_url TEXT,
    cover TEXT,
    play TEXT,
    hits INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE(platform, video_id)
  )`).run()
  schemaReady = true
}

// Upsert a query row. Re-parsing the same id bumps hits + updated_at so
// the list shows it again at the top without duplicating. Best-effort:
// any error is swallowed (logging must never break a parse).
export async function logQuery (ctx, row) {
  const db = ctx.config.d1
  if (!db) return
  try {
    await ensureSchema(db)
    const now = Date.now()
    await db.prepare(`INSERT INTO queries
      (platform, video_id, type, author, description, original_url, cover, play, hits, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
      ON CONFLICT(platform, video_id) DO UPDATE SET
        hits = hits + 1, updated_at = ?, type = ?, author = ?,
        description = ?, original_url = ?, cover = ?, play = ?`)
      .bind(
        row.platform, row.video_id, row.type, row.author, row.description,
        row.original_url, row.cover, row.play, now, now,
        now, row.type, row.author, row.description, row.original_url, row.cover, row.play
      )
      .run()
  } catch (e) {
    try { console.error('[d1] logQuery failed', e?.message || e) } catch {}
  }
}

// A page of queries (by last seen) + total count, for /admin paging.
// Returns { rows: [], total: 0 } when no D1 / on error.
export async function recentQueries (ctx, limit = 10, offset = 0) {
  const db = ctx.config.d1
  if (!db) return { rows: [], total: 0 }
  try {
    await ensureSchema(db)
    const res = await db.prepare(
      `SELECT platform, video_id, type, author, description, original_url, cover, play, hits, created_at, updated_at
       FROM queries ORDER BY updated_at DESC LIMIT ? OFFSET ?`
    ).bind(limit, offset).all()
    // Use .all() not .first() — the RandallFlare D1 shim's .first()
    // returns null here, while .all() works.
    const cnt = await db.prepare('SELECT COUNT(*) AS n FROM queries').all()
    return { rows: res?.results || [], total: cnt?.results?.[0]?.n || 0 }
  } catch (e) {
    try { console.error('[d1] recentQueries failed', e?.message || e) } catch {}
    return { rows: [], total: 0 }
  }
}

// Per-IP fixed-window rate limit, backed by D1. Returns { allowed,
// count, limit, resetSec }. When no D1 is bound we cannot enforce a
// limit, so guests are refused ({ allowed:false, reason:'no-store' }).
let rateSchemaReady = false
export async function rateLimitHit (ctx, ip, limit, windowSec) {
  const db = ctx.config.d1
  if (!db) return { allowed: false, reason: 'no-store' }
  try {
    if (!rateSchemaReady) {
      await db.prepare('CREATE TABLE IF NOT EXISTS rate (ip TEXT NOT NULL, bucket INTEGER NOT NULL, n INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(ip, bucket))').run()
      rateSchemaReady = true
    }
    const nowSec = Math.floor(Date.now() / 1000)
    const bucket = Math.floor(nowSec / windowSec)
    await db.prepare('INSERT INTO rate (ip, bucket, n) VALUES (?, ?, 1) ON CONFLICT(ip, bucket) DO UPDATE SET n = n + 1')
      .bind(ip, bucket).run()
    // .all() not .first() — see note in recentQueries.
    const res = await db.prepare('SELECT n FROM rate WHERE ip = ? AND bucket = ?').bind(ip, bucket).all()
    const count = res?.results?.[0]?.n || 1
    return { allowed: count <= limit, count, limit, resetSec: (bucket + 1) * windowSec - nowSec }
  } catch (e) {
    try { console.error('[d1] rateLimitHit failed', e?.message || e) } catch {}
    // On error, fail closed for guests (don't let abuse through).
    return { allowed: false, reason: 'error' }
  }
}
