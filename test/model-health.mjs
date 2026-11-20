// Per-model health test.
//
// Industry gateways track health per deployment (model + credential), not per
// provider: LiteLLM cools a deployment, Envoy ejects a host, New-API disables a
// channel. This pins that behaviour: a saturated model must cool alone, while a
// genuine rate limit still cools the whole route.
//
// Run: node test/model-health.mjs
import { resolveConfig } from '../config.js'
import { GeoGuard, createLogger } from '../guard.js'

let failed = 0
function check(label, condition, detail) {
  if (condition) {
    console.log(`PASS  ${label}`)
    return
  }
  failed += 1
  console.log(`FAIL  ${label}${detail === undefined ? '' : ` -> ${detail}`}`)
}

const cfg = resolveConfig({
  logFile: '',
  features: { egressProbe: false },
  breaker: { modelCooldownMs: 20000 },
  targets: { gemini: { enabled: true } },
}, {})
const log = createLogger(cfg)
const guard = new GeoGuard(cfg, log)

// A saturated model cools alone.
guard.recordOutcome('gemini', { model: 'gemini-3.7-flash', kind: 'overloaded' })
const same = await guard.admit('gemini', 'gemini-3.7-flash')
check('the saturated model is refused', same.ok === false && same.reason === 'model-cooling', JSON.stringify(same))
check('the refusal names the model', same.model === 'gemini-3.7-flash', String(same.model))

const sibling = await guard.admit('gemini', 'gemini-3.5-flash-lite')
check('a sibling model stays usable', sibling.ok === true, JSON.stringify(sibling))

const snapshot = guard.snapshot()
check('status lists the cooling model',
  Object.keys(snapshot.targets.gemini.models).includes('gemini-3.7-flash'),
  JSON.stringify(snapshot.targets.gemini.models))

// A real rate limit still cools the whole route.
guard.recordOutcome('gemini', { model: 'gemini-3.5-flash-lite', kind: 'rate-limit' })
const other = await guard.admit('gemini', 'gemini-4-argon')
check('a 429 cools the whole route', other.ok === false && other.reason === 'upstream-cooldown', JSON.stringify(other))

// Reset clears both layers.
await guard.reset()
const afterReset = await guard.admit('gemini', 'gemini-3.7-flash')
check('reset clears model cooling', afterReset.ok === true, JSON.stringify(afterReset))

// Quota is a route-level concern and must not be mistaken for model cooling.
guard.recordOutcome('gemini', { model: 'gemini-4-argon', kind: 'quota' })
const quota = await guard.admit('gemini', 'gemini-3.5-flash-lite')
check('quota cools the route, not just the model', quota.ok === false && quota.reason === 'upstream-cooldown', JSON.stringify(quota))

// A soft latch (bad key, satuation) is released by "check the exit again"; a hard
// geo stop is not, because that one needs a human decision.
await guard.reset()
guard.recordOutcome('gemini', { model: 'gemini-3.7-flash', kind: 'auth' })
const latched = await guard.admit('gemini', 'gemini-3.7-flash')
check('an auth rejection trips the route', latched.ok === false, JSON.stringify(latched))
const released = guard.releaseSoftBreakers()
const afterRecheck = await guard.admit('gemini', 'gemini-3.7-flash')
check('recheck releases a soft latch', released.includes('gemini') && afterRecheck.ok === true, `${JSON.stringify(released)} ${JSON.stringify(afterRecheck)}`)

await guard.reset()
guard.forceHardStop('test', 'hard stop fixture')
const hard = await guard.admit('gemini', 'gemini-3.7-flash')
guard.releaseSoftBreakers()
const stillHard = await guard.admit('gemini', 'gemini-3.7-flash')
check('recheck keeps a hard stop', hard.ok === false && stillHard.ok === false && stillHard.reason === 'hard-stopped', JSON.stringify(stillHard))

console.log(failed === 0 ? '\n全部通过' : `\n失败 ${failed} 项`)
process.exitCode = failed === 0 ? 0 : 1
