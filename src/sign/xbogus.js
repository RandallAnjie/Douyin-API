// X-Bogus generator — port of crawlers/douyin/web/xbogus.py
// (originally for Douyin web, still used by TikTok web and a few
// Douyin live/mix endpoints). MD5 + RC4 + a custom base64.
//
// Verified byte-for-byte against the Python reference for a fixed
// (url_path, user_agent, timer) — see test/parity.mjs.
import { rc4, strToBytes, bytesToStr, md5HexOfBytes } from './_common.js'

const CHARACTER = 'Dkdpgh4ZKsQB80/Mfvw36XI1R25-WUAlEi7NLboqYTOPuzmFjJnryx9HVGcaStCe='
const UA_KEY = [0x00, 0x01, 0x0c]

// hex-char-code -> nibble lookup (mirrors python's sparse Array list).
const HEX = new Array(128).fill(null)
for (let i = 0; i < 10; i++) HEX['0'.charCodeAt(0) + i] = i
for (let i = 0; i < 6; i++) HEX['a'.charCodeAt(0) + i] = 10 + i
for (let i = 0; i < 6; i++) HEX['A'.charCodeAt(0) + i] = 10 + i

function md5StrToArray (s) {
  if (typeof s === 'string' && s.length > 32) {
    const out = new Array(s.length)
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i)
    return out
  }
  const out = []
  for (let idx = 0; idx < s.length; idx += 2) {
    out.push((HEX[s.charCodeAt(idx)] << 4) | HEX[s.charCodeAt(idx + 1)])
  }
  return out
}

function md5 (input) {
  let arr
  if (typeof input === 'string') arr = md5StrToArray(input)
  else arr = input
  return md5HexOfBytes(arr)
}

const md5Encrypt = (urlPath) =>
  md5StrToArray(md5(md5StrToArray(md5(urlPath))))

function encodingConversion (a, b, c, e, d, t, f, r, n, o, i, _, x, u, s, l, v, h, p) {
  const y = [a, Math.floor(i), b, _, c, x, e, u, d, s, t, l, f, v, r, h, n, p, o]
  return bytesToStr(y)
}

const encodingConversion2 = (a, b, c) =>
  String.fromCharCode(a) + String.fromCharCode(b) + c

function calculation (character, a1, a2, a3) {
  const x1 = (a1 & 255) << 16
  const x2 = (a2 & 255) << 8
  const x3 = x1 | x2 | a3
  return (
    character[(x3 & 16515072) >> 18] +
    character[(x3 & 258048) >> 12] +
    character[(x3 & 4032) >> 6] +
    character[x3 & 63]
  )
}

// Returns { params, xBogus }. timer is unix seconds (injectable for
// tests); defaults to now.
export function getXBogus (urlPath, userAgent, timer) {
  const ua = userAgent ||
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36 Edg/122.0.0.0'
  if (timer === undefined) timer = Math.floor(Date.now() / 1000)

  // base64 of rc4(ua_key, ua_bytes) -> md5 string -> array
  const rc4ua = rc4(UA_KEY, strToBytes(ua))
  const b64 = (typeof btoa === 'function')
    ? btoa(bytesToStr(rc4ua))
    : globalThis.Buffer.from(rc4ua.map(b => b & 0xFF)).toString('base64')
  const array1 = md5StrToArray(md5(b64))

  const array2 = md5StrToArray(md5(md5StrToArray('d41d8cd98f00b204e9800998ecf8427e')))
  const urlPathArray = md5Encrypt(urlPath)

  const ct = 536919696
  const newArray = [
    64, 0.00390625, 1, 12,
    urlPathArray[14], urlPathArray[15], array2[14], array2[15], array1[14], array1[15],
    (timer >> 24) & 255, (timer >> 16) & 255, (timer >> 8) & 255, timer & 255,
    (ct >> 24) & 255, (ct >> 16) & 255, (ct >> 8) & 255, ct & 255
  ]

  let xor = newArray[0]
  for (let i = 1; i < newArray.length; i++) {
    let b = newArray[i]
    if (!Number.isInteger(b)) b = Math.floor(b)
    xor ^= b
  }
  newArray.push(xor)

  const array3 = []
  const array4 = []
  for (let idx = 0; idx < newArray.length; idx += 2) {
    array3.push(newArray[idx])
    if (idx + 1 < newArray.length) array4.push(newArray[idx + 1])
  }
  const mergeArray = array3.concat(array4)

  const garbled = encodingConversion2(
    2, 255,
    bytesToStr(rc4([255], strToBytes(encodingConversion(...mergeArray))))
  )

  let xb = ''
  for (let idx = 0; idx < garbled.length; idx += 3) {
    xb += calculation(
      CHARACTER,
      garbled.charCodeAt(idx),
      garbled.charCodeAt(idx + 1),
      garbled.charCodeAt(idx + 2)
    )
  }
  return { params: `${urlPath}&X-Bogus=${xb}`, xBogus: xb }
}
