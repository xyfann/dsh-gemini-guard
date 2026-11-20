// Unit tests for the pure risk logic: exit judgment and upstream failure
// classification. No network, no DSH.
//
// Run: node test/risk.mjs
import { classifyUpstreamError, assessEgress, ExitHistory } from '../risk.js'

let failed = 0
function check(label, condition, detail) {
  if (condition) {
    console.log(`PASS  ${label}`)
    return
  }
  failed += 1
  console.log(`FAIL  ${label}${detail === undefined ? '' : ` -> ${detail}`}`)
}

const cfg = {
  egress: {
    rejectHosting: 'warn',
    rejectProxyFlag: 'warn',
    timeZoneConsistency: 'warn',
    requireStableExit: true,
    stabilityWindowMs: 3600000,
    maxDistinctExitIps: 2,
    maxLatencyMs: 1200,
  },
  environment: { timeZone: 'Asia/Taipei' },
}

const geo = (over = {}) => ({
  ok: true,
  ip: '1.2.3.4',
  countryCode: 'TW',
  country: 'Taiwan',
  region: 'Taipei',
  city: 'Taipei',
  timeZone: 'Asia/Taipei',
  isp: 'Chunghwa',
  asn: 'AS3462',
  latencyMs: 90,
  hosting: false,
  proxyFlag: false,
  ...over,
})

// --- exit judgment -------------------------------------------------------
{
  const verdict = assessEgress(cfg, geo(), new ExitHistory(3600000))
  check('clean exit passes with no reasons', verdict.blocked === false && verdict.reasons.length === 0, JSON.stringify(verdict.reasons))
}
{
  const strict = { ...cfg, egress: { ...cfg.egress, rejectHosting: 'block' } }
  const verdict = assessEgress(strict, geo({ hosting: true }), new ExitHistory(3600000))
  check('hosting exit blocks when policy says block', verdict.blocked === true && verdict.reasons[0].code === 'hosting-exit', JSON.stringify(verdict.reasons))
}
{
  const verdict = assessEgress(cfg, geo({ hosting: true }), new ExitHistory(3600000))
  check('hosting exit only warns by default', verdict.blocked === false && verdict.reasons.some((r) => r.code === 'hosting-exit' && r.severity === 'warn'))
}
{
  const strict = { ...cfg, egress: { ...cfg.egress, timeZoneConsistency: 'block' } }
  const verdict = assessEgress(strict, geo({ timeZone: 'Asia/Tokyo' }), new ExitHistory(3600000))
  check('timezone mismatch blocks when policy says block', verdict.blocked === true && verdict.reasons.some((r) => r.code === 'timezone-mismatch'), JSON.stringify(verdict.reasons))
}
{
  const history = new ExitHistory(3600000)
  const now = Date.now()
  history.record('1.1.1.1', now - 3000)
  history.record('2.2.2.2', now - 2000)
  history.record('3.3.3.3', now - 1000)
  const verdict = assessEgress(cfg, geo(), history, now)
  check('three exit IPs in the window blocks as flapping', verdict.blocked === true && verdict.reasons.some((r) => r.code === 'exit-ip-flapping'), JSON.stringify(verdict.reasons))
}
{
  const history = new ExitHistory(3600000)
  const now = Date.now()
  history.record('1.1.1.1', now - 7200000)
  history.record('2.2.2.2', now - 7000000)
  history.record('3.3.3.3', now - 6800000)
  const verdict = assessEgress(cfg, geo(), history, now)
  check('old IPs outside the window do not block', verdict.blocked === false, JSON.stringify(verdict.reasons))
}
{
  const verdict = assessEgress(cfg, geo({ ok: false, reason: 'country-not-allowed', detail: 'x' }), new ExitHistory(3600000))
  check('failed probe blocks', verdict.blocked === true)
}

// --- upstream failure classification -------------------------------------
const cases = [
  ['gemini region refusal (400)', 400, '{"error":{"message":"User location is not supported for the API use."}}', 'geo'],
  ['openai unsupported country', 403, '{"error":{"message":"Country, region, or territory not supported"}}', 'geo'],
  ['gemini bad key (400)', 400, '{"error":{"message":"API key not valid. Please pass a valid API key.","details":[{"reason":"API_KEY_INVALID"}]}}', 'auth'],
  ['openai bad key', 401, '{"error":{"message":"Incorrect API key provided"}}', 'auth'],
  ['anthropic bad key', 401, '{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}', 'auth'],
  ['openai rate limit', 429, '{"error":{"message":"Rate limit reached for gpt-5"}}', 'rate-limit'],
  ['anthropic overloaded', 529, '{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}', 'overloaded'],
  ['openai quota', 429, '{"error":{"code":"insufficient_quota","message":"You exceeded your current quota"}}', 'quota'],
  ['gemini 500', 500, '{"error":{"message":"Internal error"}}', 'server'],
  ['gemini 503 high demand', 503, '{"error":{"code":503,"message":"This model is currently experiencing high demand. Spikes in demand are usually temporary. Please try again later."}}', 'overloaded'],
  ['generic overloaded wording', 503, '{"error":{"message":"The service is temporarily unavailable"}}', 'overloaded'],
  ['gemini bad request', 400, '{"error":{"message":"Invalid JSON payload received"}}', 'client'],
]

for (const [label, status, body, expected] of cases) {
  const verdict = classifyUpstreamError(status, body, {})
  check(`classify ${label} -> ${expected}`, verdict.kind === expected, verdict.kind)
}

{
  const verdict = classifyUpstreamError(429, '{"error":{"message":"Rate limit"}}', { 'retry-after': '42' })
  check('retry-after header becomes milliseconds', verdict.retryAfterMs === 42000, String(verdict.retryAfterMs))
}

console.log(failed === 0 ? '\n全部通过' : `\n失败 ${failed} 项`)
process.exitCode = failed === 0 ? 0 : 1
