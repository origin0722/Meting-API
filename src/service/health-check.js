/**
 * Cookie health check for a Deno Deploy deployment.
 *
 * The upstream CookieMonitor uses `setInterval`, which Deno Deploy does not keep
 * alive: an isolate is frozen between requests, so an interval-based check can go
 * days without running. This module is the piece `Deno.cron` calls instead, and it
 * reuses the repository's own `validateNeteaseCookie()` so the check asks exactly
 * the question the player cares about: does this cookie still unlock playback.
 *
 * Nothing here logs or returns the cookie itself -- only its length and whether the
 * expected field is present. Drop the file in `src/service/health-check.js`.
 */
import store from '../admin/store.js'
import { validateNeteaseCookie } from '../admin/cookie-validator.js'

const CACHE_MS = 60_000

let cached = null
let inflight = null

const readEnv = (key) => {
  try {
    const fromDeno = globalThis?.Deno?.env?.get(key)
    if (fromDeno) return fromDeno
  } catch {
    /* --allow-env not granted */
  }
  return globalThis?.process?.env?.[key] ?? ''
}

/** Never expose the cookie: report only what proves it is present. */
const describeCookie = (cookie) => ({
  length: cookie.length,
  hasMusicU: /(^|;\s*)MUSIC_U=/.test(cookie),
  hasMusicA: /(^|;\s*)MUSIC_A=/.test(cookie),
})

function resolveCookie(platform) {
  try {
    const stored = store.getActiveCookie(platform)
    if (stored?.cookie) return { cookie: stored.cookie, source: 'store' }
  } catch (error) {
    console.error('[health] could not read the cookie store', error)
  }
  // This base reads cookies from the admin dashboard only, so the environment
  // variable is a fallback for other runtimes rather than the documented path.
  const fromEnv = readEnv('NETEASE_COOKIE')
  if (fromEnv) return { cookie: fromEnv, source: 'env' }
  return { cookie: '', source: 'none' }
}

function classify(validation) {
  if (validation?.valid) {
    // NetEase answers 200 and hands back a guest profile for a cookie it does not
    // recognise, so "valid" alone is not proof of a working login.
    if (!validation.userInfo?.userId) return 'not_logged_in'
    return validation.userInfo?.canPlayVip === false ? 'limited' : 'ok'
  }
  const message = String(validation?.error ?? '')
  if (message.includes('过期')) return 'expired'
  if (message.includes('缺少必要')) return 'no_auth_field'
  return 'invalid'
}

async function notify(status, detail) {
  const apiKey = readEnv('RESEND_API_KEY')
  const to = readEnv('ALERT_EMAIL')
  if (!apiKey || !to || status === 'ok') return
  try {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: readEnv('ALERT_FROM') || 'onboarding@resend.dev',
        to: [to],
        subject: `[博客音乐] 网易云 Cookie 状态异常：${status}`,
        text: `检测时间：${new Date().toISOString()}\n状态：${status}\n详情：${JSON.stringify(detail, null, 2)}\n\n请重新登录网易云，复制新 Cookie 后在管理后台更新。`,
      }),
    })
  } catch (error) {
    console.error('[health] alert email failed', error)
  }
}

/**
 * @param {'netease'} platform
 * @param {{ force?: boolean }} [options]
 * @returns {Promise<{status: string, ok: boolean, platform: string, checkedAt: string, cookie: object, detail: object|null}>}
 */
export async function runHealthCheck(platform = 'netease', { force = false } = {}) {
  const now = Date.now()
  if (!force && cached && now - cached.at < CACHE_MS) return cached.result
  if (!force && inflight) return await inflight

  const run = async () => {
    const { cookie, source } = resolveCookie(platform)
    const base = {
      platform,
      checkedAt: new Date().toISOString(),
      cookie: { ...describeCookie(cookie), source },
      detail: null,
    }

    if (!cookie) {
      return { ...base, status: 'no_cookie', ok: false }
    }
    if (platform !== 'netease') {
      return { ...base, status: 'unsupported_platform', ok: false }
    }

    try {
      const validation = await validateNeteaseCookie(cookie)
      const status = classify(validation)
      return {
        ...base,
        status,
        ok: status === 'ok',
        detail: {
          error: validation?.error ?? null,
          userInfo: validation?.userInfo
            ? {
                userId: validation.userInfo.userId,
                nickname: validation.userInfo.nickname,
                vipType: validation.userInfo.vipType,
                isVip: validation.userInfo.isVip,
                canPlayVip: validation.userInfo.canPlayVip,
              }
            : null,
        },
      }
    } catch (error) {
      return {
        ...base,
        status: 'error',
        ok: false,
        detail: { error: String(error?.message ?? error) },
      }
    }
  }

  inflight = run()
  try {
    const result = await inflight
    cached = { at: Date.now(), result }
    const previous = cached?.previousStatus
    if (result.status !== 'ok' && result.status !== previous) {
      await notify(result.status, result.detail)
    }
    if (cached) cached.previousStatus = result.status
    return result
  } finally {
    inflight = null
  }
}

export default { runHealthCheck }
