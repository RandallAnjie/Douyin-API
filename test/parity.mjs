// Signature parity tests. Reference values were captured from the
// upstream Python implementation (Evil0ctal/Douyin_TikTok_Download_API)
// with time/random pinned. Run: `node test/parity.mjs`.
import { sm3Hash } from '../src/lib/sm3.js'
import { getXBogus } from '../src/sign/xbogus.js'
import { getABogus } from '../src/sign/abogus.js'

let failed = 0
const enc = s => Array.from(Buffer.from(s, 'utf8'))
const check = (name, got, exp) => {
  const ok = got === exp
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`)
  if (!ok) console.log(`  got: ${got}\n  exp: ${exp}`)
}

// 1) SM3 — official vectors.
check('sm3("abc")', sm3Hash(enc('abc')),
  '66c7f0f462eeedd9d1f2d46bdc10e4e24167c4875cf2f7a2297da02b8f4ba8e0')
check('sm3("abcd"*16)', sm3Hash(enc('abcd'.repeat(16))),
  'debe9ff92275b8a138604889c18e5a4d6fdb70e5387e5765293dcba39c0c5732')

// 2) X-Bogus — fixed UA + timer=1700000000.
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/90.0.4430.212 Safari/537.36'
const xbPath = 'device_platform=webapp&aid=6383&channel=channel_pc_web&aweme_id=7372484719365098803&pc_client_type=1&version_code=290100&version_name=29.1.0'
check('X-Bogus', getXBogus(xbPath, UA, 1700000000).xBogus, 'DFSzswVYHRGANGVRtmWx-e9WX7nQ')

// 3) a_bogus — fixed start/end time + random.
const abParams = 'device_platform=webapp&aid=6383&channel=channel_pc_web&aweme_id=7372484719365098803&pc_client_type=1&version_code=290100&version_name=29.1.0&cookie_enabled=true&screen_width=1920&screen_height=1080&browser_language=zh-CN&browser_platform=Win32&browser_name=Chrome&browser_version=130.0.0.0&browser_online=true&engine_name=Blink&engine_version=130.0.0.0&os_name=Windows&os_version=10&cpu_core_num=12&device_memory=8&platform=PC&downlink=10&effective_type=4g&round_trip_time=0&msToken='
check('a_bogus', getABogus(abParams, 'GET', { random1: 0.1, random2: 0.2, random3: 0.3, startTime: 1700000000000, endTime: 1700000000005 }),
  'DfmhQDgDDDDkDD6D56KLfY3q668VYmQI0SVkMD2fW-DOqL39HMYh9exoIBGvXY8jwG/-IeEjy4hbT3ohrQ2y0Hwf9W0L/25ksDSkKl5Q5xSSs1X9eghgJ04qmkt5SMx2RvB-rOXmqhZHKRbp09oHmhK4b1dzFgf3qJLzMj==')

console.log(failed === 0 ? '\nAll parity tests passed.' : `\n${failed} test(s) failed.`)
process.exit(failed === 0 ? 0 : 1)
