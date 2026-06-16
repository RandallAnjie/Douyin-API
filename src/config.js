// Config builder — turns a worker `env` binding into a structured
// config object. Pure function: same input, same output, no side
// effects, callable per-request (a few object reads).
//
// Cookies live in env (DOUYIN_COOKIE / TIKTOK_COOKIE). Auth uses a
// single HMAC secret (DOUYIN_API_TOKEN), mirroring the sibling
// Meting-API worker.

// Default desktop Chrome UA. The Douyin a_bogus / X-Bogus ua_code
// is baked against this exact string in the upstream project — do
// NOT change it casually, the signatures depend on it.
const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/90.0.4430.212 Safari/537.36'

export function buildConfig (env) {
  env = env || {}
  return {
    http: {
      prefix: env.HTTP_PREFIX || ''
    },
    // HMAC secret shared with callers. `tokenSource` is stamped on
    // responses so we can spot an env-binding flake where a fresh
    // isolate ships with no token bound and silently uses the
    // placeholder 'token' to mint/verify HMACs.
    auth: {
      token: env.DOUYIN_API_TOKEN || 'token',
      tokenSource: env.DOUYIN_API_TOKEN ? 'env' : 'default'
    },
    douyin: {
      cookie: env.DOUYIN_COOKIE || '',
      userAgent: env.DEFAULT_USER_AGENT || DEFAULT_UA
    },
    tiktok: {
      cookie: env.TIKTOK_COOKIE || '',
      userAgent: env.TIKTOK_USER_AGENT || env.DEFAULT_USER_AGENT || DEFAULT_UA
    },
    log: {
      level: env.LOG_LEVEL || 'info'
    },
    rawEnv: env
  }
}

export const DEFAULT_USER_AGENT = DEFAULT_UA

export default buildConfig({})
