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

// Most-recent queries (by last seen). Returns [] when no D1 / on error.
export async function recentQueries (ctx, limit = 60) {
  const db = ctx.config.d1
  if (!db) return []
  try {
    await ensureSchema(db)
    const res = await db.prepare(
      `SELECT platform, video_id, type, author, description, original_url, cover, play, hits, created_at, updated_at
       FROM queries ORDER BY updated_at DESC LIMIT ?`
    ).bind(limit).all()
    return res?.results || []
  } catch (e) {
    try { console.error('[d1] recentQueries failed', e?.message || e) } catch {}
    return []
  }
}
