// Temporary D1 diagnostic — token-gated. Probes whether DOUYIN_D1 is
// bound and whether create/insert/upsert/select work on the plane D1.
import { HTTPException } from '../utils/http-exception.js'
import { rawJsonResponse } from '../utils/respond.js'

export async function d1DebugService (request, ctx) {
  const url = new URL(request.url)
  if ((url.searchParams.get('token') || '') !== ctx.config.auth.token) {
    throw new HTTPException(401, { message: 'token required' })
  }
  const db = ctx.config.d1
  const r = { bound: !!db, type: typeof db, hasPrepare: typeof db?.prepare }
  if (!db) return rawJsonResponse(r)

  try { await db.prepare('CREATE TABLE IF NOT EXISTS _probe (id INTEGER PRIMARY KEY, v TEXT, u INTEGER, UNIQUE(v))').run(); r.create = 'ok' } catch (e) { r.create = String(e?.message || e) }
  try { await db.prepare('INSERT INTO _probe (v,u) VALUES (?,?) ON CONFLICT(v) DO UPDATE SET u=?').bind('x', Date.now(), Date.now()).run(); r.upsert = 'ok' } catch (e) { r.upsert = String(e?.message || e) }
  try { const s = await db.prepare('SELECT COUNT(*) AS n FROM _probe').first(); r.count = s?.n } catch (e) { r.selectErr = String(e?.message || e) }
  try { const s = await db.prepare('SELECT COUNT(*) AS n FROM queries').first(); r.queriesCount = s?.n } catch (e) { r.queriesErr = String(e?.message || e) }
  return rawJsonResponse(r)
}
