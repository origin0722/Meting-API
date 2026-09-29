/**
 * Deno Deploy entry point.
 *
 * The repository's own `deno.js` still calls
 * `https://deno.land/std/http/server.ts`, which no longer runs on Deno Deploy.
 * This replaces it with `Deno.serve` and registers the daily cookie check as a
 * `Deno.cron` job: the upstream CookieMonitor uses `setInterval`, and an isolate is
 * frozen between requests, so an interval can silently stop running.
 *
 * The `/health` route itself lives in `app.js`, so every runtime shares it.
 * Copy this over `deno.js` in the fork (Deno Deploy's entrypoint is `deno.js`).
 */
import app from './app.js'
import { runHealthCheck } from './src/service/health-check.js'

if (typeof Deno?.cron === 'function') {
  Deno.cron('cookie-health-check', '0 1 * * *', async () => {
    const result = await runHealthCheck('netease', { force: true })
    console.log(
      `[health] cron status=${result.status} detail=${JSON.stringify(result.detail)}`,
    )
  })
} else {
  console.log('[health] Deno.cron unavailable locally; open /health to check manually')
}

Deno.serve(app.fetch)
