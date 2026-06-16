// Token / fingerprint generators — ports of Douyin's TokenManager and
// VerifyFpManager (crawlers/douyin/web/utils.py). ttwid / real msToken
// require a network call (fetch); verify_fp / fake msToken are local.

const RANDOM_BASE = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+-'

export function genRandomStr (len) {
  let s = ''
  for (let i = 0; i < len; i++) {
    s += RANDOM_BASE[Math.floor(Math.random() * RANDOM_BASE.length)]
  }
  return s
}

// Fake msToken: 126 random chars + '=='. The upstream falls back to
// this whenever the mssdk call fails, which is the common case.
export const genFalseMsToken = () => genRandomStr(126) + '=='

// verify_fp / s_v_web_id. Port of VerifyFpManager.gen_verify_fp.
const VFP_BASE = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
export function genVerifyFp () {
  const t = VFP_BASE.length
  let ms = Date.now()
  let base36 = ''
  while (ms > 0) {
    const rem = ms % 36
    base36 = (rem < 10 ? String(rem) : String.fromCharCode(97 + rem - 10)) + base36
    ms = Math.floor(ms / 36)
  }
  const o = new Array(36).fill('')
  o[8] = o[13] = o[18] = o[23] = '_'
  o[14] = '4'
  for (let i = 0; i < 36; i++) {
    if (!o[i]) {
      let n = Math.floor(Math.random() * t)
      if (i === 19) n = (3 & n) | 8
      o[i] = VFP_BASE[n]
    }
  }
  return 'verify_' + base36 + '_' + o.join('')
}

export const genSVWebId = () => genVerifyFp()

// ttwid via POST to bytedance — reads the ttwid cookie from the
// Set-Cookie response header. Returns '' on failure.
const TTWID_URL = 'https://ttwid.bytedance.com/ttwid/union/register/'
const TTWID_DATA = '{"region":"cn","aid":1768,"needFid":false,"service":"www.ixigua.com","migrate_info":{"ticket":"","source":"node"},"cbUrlProtocol":"https","union":true}'
export async function genTtwid () {
  try {
    const resp = await fetch(TTWID_URL, {
      method: 'POST',
      body: TTWID_DATA,
      headers: { 'content-type': 'text/plain;charset=UTF-8' }
    })
    const setCookie = resp.headers.get('set-cookie') || ''
    const m = setCookie.match(/ttwid=([^;]+)/)
    return m ? m[1] : ''
  } catch {
    return ''
  }
}

// Real msToken via mssdk. Returns the fake token on any failure.
const MSTOKEN_URL = 'https://mssdk.bytedance.com/web/report'
const MSTOKEN_PAYLOAD = {
  magic: 538969122,
  version: 1,
  dataType: 8,
  strData: '',
  tspFromClient: 0
}
export async function genRealMsToken () {
  try {
    const payload = { ...MSTOKEN_PAYLOAD, tspFromClient: Date.now() }
    const resp = await fetch(MSTOKEN_URL, {
      method: 'POST',
      body: JSON.stringify(payload),
      headers: { 'content-type': 'application/json' }
    })
    const setCookie = resp.headers.get('set-cookie') || ''
    const m = setCookie.match(/msToken=([^;]+)/)
    if (m && (m[1].length === 120 || m[1].length === 128)) return m[1]
    return genFalseMsToken()
  } catch {
    return genFalseMsToken()
  }
}
