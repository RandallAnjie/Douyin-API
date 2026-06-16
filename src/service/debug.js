// Temporary cache diagnostic — gated by the master token. Probes the R2
// binding on the live edge: is waitUntil present, can we put/head/get,
// and which read method works. Remove once the cache path is fixed.
import { HTTPException } from '../utils/http-exception.js'
import { rawJsonResponse } from '../utils/respond.js'

export async function cacheDebugService (request, ctx) {
  const url = new URL(request.url)
  if ((url.searchParams.get('token') || '') !== ctx.config.auth.token) {
    throw new HTTPException(401, { message: 'token required' })
  }
  const bucket = ctx.config.mediaR2
  const r = {
    waitUntil: typeof ctx.waitUntil,
    bucketBound: !!bucket,
    bucketType: typeof bucket,
    hasPut: typeof bucket?.put,
    hasGet: typeof bucket?.get,
    hasHead: typeof bucket?.head
  }
  if (!bucket) return rawJsonResponse(r)

  const key = 'meta/_debug.json'
  const payload = JSON.stringify({ t: Date.now(), hello: 'world' })

  try {
    await bucket.put(key, payload, { httpMetadata: { contentType: 'application/json' } })
    r.putOk = true
  } catch (e) { r.putErr = String(e?.message || e) }

  try {
    const head = await bucket.head(key)
    r.headFound = !!head
    r.headSize = head?.size
    r.headUploaded = head?.uploaded ? String(head.uploaded) : null
  } catch (e) { r.headErr = String(e?.message || e) }

  try {
    const obj = await bucket.get(key)
    r.getFound = !!obj
    r.getUploaded = obj?.uploaded ? String(obj.uploaded) : null
    if (obj) {
      try { r.readText = await obj.text() } catch (e) { r.readTextErr = String(e?.message || e) }
      try {
        if (obj.body) r.readBody = await new Response(obj.body).text()
      } catch (e) { r.readBodyErr = String(e?.message || e) }
      try { if (typeof obj.json === 'function') r.readJson = await obj.json() } catch (e) { r.readJsonErr = String(e?.message || e) }
    }
  } catch (e) { r.getErr = String(e?.message || e) }

  return rawJsonResponse(r)
}
