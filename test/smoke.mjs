// Integration smoke test. Runs the real relay against the real egress path so
// the safety properties can be proven without spending a single model token.
//
//   1. Wrong-region exit        -> refused locally, nothing forwarded
//   2. Unconfirmed exit         -> refused until the probe repeats
//   3. Confirmed exit           -> request reaches the vendor and its own answer
//                                  comes back through the relay unchanged
//   4. One vendor rejected      -> only that vendor's breaker trips
//
// Run: node test/smoke.mjs
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { resolveConfig } from '../config.js'
import { GeoGuard, createLogger } from '../guard.js'
import { createRelayServer } from '../relay.js'

const port = 18799
const failures = []

function request(urlPath, method = 'GET', body) {
  const payload = body === undefined ? null : Buffer.from(JSON.stringify(body), 'utf8')
  return new Promise((resolve, reject) => {
    // agent: false keeps every call on a fresh socket: the test restarts the
    // relay on the same port, and a pooled keep-alive socket would survive it.
    const headers = payload === null
      ? {}
      : { 'content-type': 'application/json', 'content-length': String(payload.length) }
    const req = http.request({ host: '127.0.0.1', port, path: urlPath, method, agent: false, headers }, (response) => {
      const chunks = []
      response.on('data', (chunk) => chunks.push(chunk))
      response.on('end', () => resolve({
        status: response.statusCode ?? 0,
        headers: response.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }))
    })
    req.on('error', reject)
    if (payload !== null) req.write(payload)
    req.end()
  })
}

function check(label, condition, detail) {
  if (condition) {
    console.log(`PASS  ${label}`)
    return
  }
  failures.push(label)
  console.log(`FAIL  ${label}${detail === undefined ? '' : ` -> ${detail}`}`)
}

async function startRelay(overrides) {
  const cfg = resolveConfig({
    listenPort: port,
    logFile: path.join(os.tmpdir(), 'dsh-gemini-guard-smoke.log'),
    egress: { ttlMs: 3000, maxDistinctExitIps: 5, ...(overrides.egress ?? {}) },
    // The scenarios below assert the country gate, so they opt out of the
    // split-tunnel override; otherwise a developer machine behind a smart
    // routing tunnel would silently change what they test.
    features: { pathAware: false, ...(overrides.features ?? {}) },
    targets: overrides.targets,
    ...(overrides.limits === undefined ? {} : { limits: overrides.limits }),
  })
  const log = createLogger(cfg)
  const guard = new GeoGuard(cfg, log)
  const server = createRelayServer({ cfg, guard, log })
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve))
  return {
    cfg,
    guard,
    server,
    close: () => new Promise((resolve) => {
      server.closeAllConnections?.()
      server.close(() => resolve())
    }),
  }
}

async function scenarioPanelAndSettings() {
  const relay = await startRelay({ egress: { allowedCountries: [], confirmations: 1, requireStableExit: false } })

  const panel = await request('/_gemini-guard/')
  check('control panel is served as HTML', panel.status === 200 && panel.body.includes('dsh-gemini-guard'), panel.status)
  check('panel has no external asset dependency', !panel.body.includes('http://') && !panel.body.includes('https://'), 'external url found')

  const before = JSON.parse((await request('/_gemini-guard/settings')).body)
  check('settings read returns the live knobs', before.enabled === true && before.maxConcurrentPerTarget >= 1, JSON.stringify(before).slice(0, 120))

  const saved = JSON.parse((await request('/_gemini-guard/settings', 'POST', { enabled: false })).body)
  check('settings write reports what it applied', saved.applied.includes('enabled'), JSON.stringify(saved.applied))
  check('settings write reports it could not persist without a config entry', saved.persisted === false && saved.persistError !== '', JSON.stringify(saved).slice(0, 160))

  const disabled = await request('/gemini/v1beta/models?key=INVALID_TEST_KEY')
  check('kill switch refuses without touching the vendor', String(disabled.headers['x-gemini-guard']) === 'blocked-disabled', disabled.headers['x-gemini-guard'])

  await request('/_gemini-guard/settings', 'POST', { enabled: true, allowedCountries: ['ZZ'] })
  await request('/_gemini-guard/reset')
  const reblocked = await request('/gemini/v1beta/models?key=INVALID_TEST_KEY')
  check('changed allowlist applies immediately', String(reblocked.headers['x-gemini-guard']) === 'blocked-country-not-allowed', reblocked.headers['x-gemini-guard'])

  // Turning the probe off is the documented "you are on your own" mode: no
  // country rule can be enforced, and the request must still be forwarded.
  await request('/_gemini-guard/settings', 'POST', { features: { egressProbe: false }, allowedCountries: [] })
  const unverifiedStatus = JSON.parse((await request('/_gemini-guard/status')).body)
  check('probe off reports unverified', unverifiedStatus.egress.phase === 'unverified', unverifiedStatus.egress.phase)
  const unverified = await request('/gemini/v1beta/models?key=INVALID_TEST_KEY')
  check('probe off still forwards the request', String(unverified.headers['x-gemini-guard']).startsWith('upstream-'), unverified.headers['x-gemini-guard'])

  await request('/_gemini-guard/settings', 'POST', { features: { egressProbe: true } })
  const restored = JSON.parse((await request('/_gemini-guard/settings')).body)
  check('feature switch reads back', restored.features.egressProbe === true, JSON.stringify(restored.features))

  await relay.close()
}

async function scenarioPathAware() {
  // The contract does not depend on this machine's network: when the vendor host
  // is captured by a splitting tunnel the request must be forwarded (the vendor
  // decides), and when it is not the country gate must still refuse. Read the
  // observed state first, then assert the matching half of the invariant.
  const relay = await startRelay({ egress: { allowedCountries: ['TW'], confirmations: 1 }, features: { pathAware: true } })
  await request('/_gemini-guard/recheck?target=gemini', 'POST')
  const status = JSON.parse((await request('/_gemini-guard/status')).body)
  const marker = status.targets.gemini.splitTunnel
  const response = await request('/gemini/v1beta/models?key=INVALID_TEST_KEY')
  const tag = String(response.headers['x-gemini-guard'])

  if (marker) {
    check('split tunnel detected -> request is forwarded', tag.startsWith('upstream-'), `${marker} => ${tag}`)
  } else {
    check('no split tunnel -> country gate still refuses', tag === 'blocked-country-not-allowed', `${marker} => ${tag}`)
  }
  console.log(`INFO  splitTunnel=${marker ?? 'none'} 判定=${tag}`)
  await relay.close()
}

async function scenarioAbortedClients() {
  // Regression: a client that disconnects before the tunnel is built used to
  // strand its concurrency slot. With maxConcurrentPerTarget = 1, four aborted
  // handshakes exhausted the target and every later request waited out the queue
  // timeout — indistinguishable from a hang. The slot is now released from the
  // close handler attached before any waiting.
  const relay = await startRelay({
    egress: { allowedCountries: [], confirmations: 1, requireStableExit: false },
    limits: { maxConcurrentPerTarget: 1, queueTimeoutMs: 5000 },
  })

  for (let i = 0; i < 4; i += 1) {
    const req = http.request({ host: '127.0.0.1', port, path: '/gemini/v1beta/models?key=ABORTED', method: 'GET', agent: false })
    req.on('error', () => {})
    req.end()
    req.destroy()
  }
  await new Promise((resolve) => setTimeout(resolve, 400))

  const startedAt = Date.now()
  const response = await request('/gemini/v1beta/models?key=INVALID_TEST_KEY')
  const elapsed = Date.now() - startedAt
  check('aborted clients do not leak the concurrency slot', elapsed < 5000, `${elapsed} ms, http ${response.status}`)
  check('request still reaches the vendor after aborts', String(response.headers['x-gemini-guard']).startsWith('upstream-'), String(response.headers['x-gemini-guard']))

  const status = JSON.parse((await request('/_gemini-guard/status')).body)
  check('status exposes relay concurrency', status.relay !== undefined && status.relay.semaphores.gemini !== undefined, JSON.stringify(status.relay ?? null))
  check('no slot is left active', (status.relay?.semaphores?.gemini?.active ?? 1) === 0, JSON.stringify(status.relay?.semaphores ?? null))

  await relay.close()
}

async function main() {
  for (const [name, scenario] of [
    ['wrong region', scenarioWrongRegion],
    ['confirmation then forward', scenarioConfirmationThenForward],
    ['panel and settings', scenarioPanelAndSettings],
    ['path aware', scenarioPathAware],
    ['aborted clients', scenarioAbortedClients],
  ]) {
    try {
      await scenario()
    } catch (error) {
      failures.push(name)
      console.log(`FAIL  ${name} crashed -> ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  console.log(failures.length === 0 ? '\n全部通过' : `\n失败 ${failures.length} 项：${failures.join('; ')}`)
  process.exitCode = failures.length === 0 ? 0 : 1
}

async function scenarioWrongRegion() {
  const relay = await startRelay({ egress: { allowedCountries: ['TW'] } })
  const status = JSON.parse((await request('/_gemini-guard/status')).body)
  check('status lists the enabled target', status.targets?.gemini?.route === 'google', JSON.stringify(Object.keys(status.targets ?? {})))
  check('egress starts unprobed', status.egress.phase === 'unprobed', status.egress.phase)

  const refused = await request('/gemini/v1beta/models?key=INVALID_TEST_KEY')
  check('wrong-region request is refused locally', refused.status === 403, refused.status)
  check('refusal names the guard reason', String(refused.headers['x-gemini-guard']) === 'blocked-country-not-allowed', refused.headers['x-gemini-guard'])
  check('refusal body names the plugin', refused.body.includes('dsh-gemini-guard'), refused.body.slice(0, 120))

  const after = JSON.parse((await request('/_gemini-guard/status')).body)
  console.log(`INFO  出口=${after.egress.countryCode ?? '?'} IP=${after.egress.ip ?? '?'} 熔断=${after.targets.gemini.breaker.state}/${after.targets.gemini.breaker.reason}`)
  check('no upstream traffic was counted', after.targets.gemini.counters.upstreamErrors === 0, JSON.stringify(after.targets.gemini.counters))
  check('geo rejection latches the breaker', after.targets.gemini.breaker.state === 'open' && after.targets.gemini.breaker.hard === true, JSON.stringify(after.targets.gemini.breaker))
  await relay.close()
}

async function scenarioConfirmationThenForward() {
  const relay = await startRelay({
    egress: { allowedCountries: [], confirmations: 2, requireStableExit: false },
    targets: { openai: { enabled: true } },
  })

  const first = await request('/gemini/v1beta/models?key=INVALID_TEST_KEY')
  check('unconfirmed exit is refused', String(first.headers['x-gemini-guard']) === 'blocked-awaiting-confirmation', first.headers['x-gemini-guard'])

  await request('/_gemini-guard/recheck?target=gemini', 'POST')

  // A vendor-level rejection must not stop the other vendors: trip openai first,
  // then prove gemini still admits and forwards.
  const openai = await request('/openai/v1/models')
  check('second vendor is reachable through its own prefix', String(openai.headers['x-gemini-guard']).startsWith('upstream-'), openai.headers['x-gemini-guard'])
  const isolated = JSON.parse((await request('/_gemini-guard/status')).body)
  check('openai auth rejection trips only openai', isolated.targets.openai.breaker.state === 'open', JSON.stringify(isolated.targets.openai.breaker))
  check('gemini breaker stays closed while openai trips', isolated.targets.gemini.breaker.state !== 'open', JSON.stringify(isolated.targets.gemini.breaker))

  const forwarded = await request('/gemini/v1beta/models?key=INVALID_TEST_KEY')
  const tag = String(forwarded.headers['x-gemini-guard'])
  check('confirmed exit is forwarded', tag.startsWith('upstream-'), tag)
  check('gemini answer comes back through the relay', forwarded.body.includes('API_KEY_INVALID') || forwarded.status === 200, `${forwarded.status} ${forwarded.body.slice(0, 100)}`)
  check('client-visible answer is classified, not rewritten', ['client', 'auth'].includes(String(forwarded.headers['x-gemini-guard-kind'])), forwarded.headers['x-gemini-guard-kind'])

  const after = JSON.parse((await request('/_gemini-guard/status')).body)
  console.log(`INFO  出口=${after.egress.countryCode} ${after.egress.isp} 确认=${after.egress.confirmations} 窗口内IP数=${after.egress.distinctIpsInWindow}`)
  await relay.close()
}

main().catch((error) => {
  console.error('smoke test crashed:', error)
  process.exitCode = 1
})
