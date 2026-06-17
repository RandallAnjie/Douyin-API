// Temporary cache diagnostic — gated by the master token. Within ONE
// request (same node, awaited, no waitUntil timing): stream-put a key,
// then head + get + read it back. Tells us whether head() or get()
// returns existing objects. Remove once the cache path is fixed.
import { HTTPException } from '../utils/http-exception.js'
import { rawJsonResponse } from '../utils/respond.js'

export async function cacheDebugService (request, ctx) {
  const url = new URL(request.url)
  if ((url.searchParams.get('token') || '') !== ctx.config.auth.token) {
    throw new HTTPException(401, { message: 'token required' })
  }
  const bucket = ctx.config.mediaR2
  const r = { waitUntil: typeof ctx.waitUntil, bucketBound: !!bucket }
  if (!bucket) return rawJsonResponse(r)

  // Read-only probe of an existing key (no put) when ?key= is given.
  const readKey = url.searchParams.get('key')
  if (readKey) {
    r.key = readKey
    try { const h = await bucket.head(readKey); r.headFound = !!h; r.headUploaded = h?.uploaded ? String(h.uploaded) : null } catch (e) { r.headErr = String(e?.message || e) }
    try {
      const o = await bucket.get(readKey)
      r.getFound = !!o
      if (o) {
        r.getUploaded = o.uploaded ? String(o.uploaded) : null
        r.ageSec = o.uploaded ? Math.round((Date.now() - new Date(o.uploaded).getTime()) / 1000) : null
        try { r.bodyLen = (await new Response(o.body).text()).length } catch (e) { r.bodyErr = String(e?.message || e) }
      }
    } catch (e) { r.getErr = String(e?.message || e) }
    return rawJsonResponse(r)
  }

  const key = 'meta/_debug.json'
  const payload = JSON.stringify({ t: Date.now(), hello: 'world' })

  try {
    await bucket.put(key, new Response(payload).body, { httpMetadata: { contentType: 'application/json' } })
    r.streamPut = 'ok'
  } catch (e) { r.streamPut = String(e?.message || e) }

  try {
    const head = await bucket.head(key)
    r.headFound = !!head
    r.headSize = head?.size
  } catch (e) { r.headErr = String(e?.message || e) }

  try {
    const obj = await bucket.get(key)
    r.getFound = !!obj
    if (obj) {
      r.getUploaded = obj.uploaded ? String(obj.uploaded) : null
      try { r.bodyText = obj.body ? await new Response(obj.body).text() : '(no body)' } catch (e) { r.bodyErr = String(e?.message || e) }
    }
  } catch (e) { r.getErr = String(e?.message || e) }

  try {
    if (typeof bucket.list === 'function') {
      const l = await bucket.list({ prefix: 'meta/', limit: 5 })
      r.listKeys = (l?.objects || []).map(o => o.key)
    } else r.list = 'no fn'
  } catch (e) { r.listErr = String(e?.message || e) }

  return rawJsonResponse(r)
}
