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

  const tryPut = async (label, k, val, opts) => {
    try {
      await bucket.put(k, val, opts)
      r[label] = 'ok'
    } catch (e) {
      r[label] = String(e?.message || e)
      if (e?.cause) r[label + '_cause'] = String(e.cause?.message || e.cause)
      if (e?.stack) r[label + '_stack'] = String(e.stack).split('\n').slice(0, 3).join(' | ')
    }
  }

  await tryPut('put_str_opts', key, payload, { httpMetadata: { contentType: 'application/json' } })
  await tryPut('put_str_plain', 'debug_plain.txt', 'hello')
  await tryPut('put_ab', 'debug_ab.bin', new TextEncoder().encode('hello').buffer)
  await tryPut('put_root', '_dbg.txt', 'x')

  try {
    if (typeof bucket.list === 'function') {
      const l = await bucket.list({ limit: 3 })
      r.listOk = true
      r.listCount = l?.objects?.length
    } else r.listOk = 'no list fn'
  } catch (e) { r.listErr = String(e?.message || e) }

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
