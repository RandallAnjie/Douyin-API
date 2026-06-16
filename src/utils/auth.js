// Meting-style auth. A request is authorised if it carries either:
//   - ?token=<secret>            (master key), or
//   - ?auth=<HMAC-SHA1 hex>      where the message is the canonical
//     string "{platform}{route}{primaryId}".
//
// Mirrors Meting-API/src/service/api.js: HMAC-SHA1(secret, message).
import { hmacSha1Hex } from '../lib/sha1.js'
import { HTTPException } from './http-exception.js'

export const sign = (message, secret) => hmacSha1Hex(secret, message)

export const canonical = (platform, route, primaryId = '') =>
  `${platform}${route}${primaryId}`

// Throws HTTPException(401) unless the caller is authorised. Returns
// nothing on success. `primaryId` is the route's main identifier
// (aweme_id / itemId / sec_user_id / url …) — '' when there isn't one.
export function requireAuth (request, ctx, platform, route, primaryId = '') {
  const url = new URL(request.url)
  const queryToken = url.searchParams.get('token') || ''
  const queryAuth = url.searchParams.get('auth') || ''
  const secret = ctx.config.auth.token

  if (queryToken && queryToken === secret) return
  const expected = sign(canonical(platform, route, primaryId), secret)
  if (queryAuth && queryAuth === expected) return

  const sent = queryAuth || queryToken || '(none)'
  throw new HTTPException(401, {
    message: `Unauthorized: bad token/auth for ${platform}/${route}. ` +
      `Pass ?token=<secret> or ?auth=HMAC-SHA1(secret,"${canonical(platform, route, primaryId)}"). ` +
      `Received: ${sent.slice(0, 12)}…`
  })
}
