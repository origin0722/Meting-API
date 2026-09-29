/**
 * Vercel function for the cookie health check.
 *
 * The catch-all rewrite in vercel.json funnels every request into `api/index.js`,
 * which only serves the Meting API -- so `/health` needs its own function plus an
 * identity rewrite placed ahead of the catch-all. Vercel's cron hits this path.
 */
import { runHealthCheck } from '../src/service/health-check.js'

export default async function handler(_request, response) {
  const result = await runHealthCheck('netease')
  response.statusCode = result.ok ? 200 : 503
  response.setHeader('Content-Type', 'application/json; charset=utf-8')
  response.setHeader('Cache-Control', 'no-store')
  response.end(JSON.stringify(result))
}
