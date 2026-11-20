// Config test: the bundle patch's config must resolve cleanly, and typos must be
// rejected instead of silently dropped.
//
// Run: node test/config.mjs
import { resolveConfig } from '../config.js'

let failed = 0
function check(label, condition, detail) {
  if (condition) {
    console.log(`PASS  ${label}`)
    return
  }
  failed += 1
  console.log(`FAIL  ${label}${detail === undefined ? '' : ` -> ${detail}`}`)
}

// Mirrors cordis.patch.yml.
const patchConfig = {
  enabled: true,
  listenHost: '127.0.0.1',
  listenPort: 8799,
  egress: {
    proxy: '',
    allowedCountries: ['TW'],
    requireStableExit: true,
    stabilityWindowMs: 3600000,
    maxDistinctExitIps: 2,
    rejectHosting: 'warn',
    rejectProxyFlag: 'warn',
    timeZoneConsistency: 'warn',
    confirmations: 1,
  },
  environment: {
    region: 'TW',
    timeZone: 'Asia/Taipei',
    locale: 'en-US',
    device: 'Windows 11 (x64)',
  },
  targets: {
    gemini: { enabled: true },
    openai: { enabled: false },
    anthropic: { enabled: false },
    grok: { enabled: false },
  },
}

const cfg = resolveConfig(patchConfig, { harnessHome: 'C:\\Users\\xyfan\\.dsh' })
check('patch config resolves', cfg.listenPort === 8799)
check('all four vendor targets exist', Object.keys(cfg.targets).join(',') === 'gemini,openai,anthropic,grok', Object.keys(cfg.targets).join(','))
check('only gemini is enabled by default', cfg.enabledTargets.map((t) => t.id).join(',') === 'gemini', cfg.enabledTargets.map((t) => t.id).join(','))
check('gemini relay base url carries /v1beta', cfg.targets.gemini.relayBaseUrl === 'http://127.0.0.1:8799/gemini/v1beta', cfg.targets.gemini.relayBaseUrl)
check('openai relay base url carries /v1', cfg.targets.openai.relayBaseUrl === 'http://127.0.0.1:8799/openai/v1', cfg.targets.openai.relayBaseUrl)
check('anthropic base url leaves the version to the SDK', cfg.targets.anthropic.relayBaseUrl === 'http://127.0.0.1:8799/anthropic', cfg.targets.anthropic.relayBaseUrl)
check('grok route is the pi-ai catalog name', cfg.targets.grok.route === 'xai', cfg.targets.grok.route)
check('anthropic keeps its own auth headers', cfg.targets.anthropic.headers.forwardHeaders.includes('x-api-key'), JSON.stringify(cfg.targets.anthropic.headers.forwardHeaders))
check('log path lands under the harness home', cfg.logFile.endsWith('gemini-guard.log'), cfg.logFile)

// A config schema materialises array defaults as [], which used to overwrite the
// vendor's auth-header list and silently turned every request anonymous (the
// vendor answers 403, which reads like a key problem).
{
  const guarded = resolveConfig({
    targets: {
      gemini: { enabled: true, headers: { forwardHeaders: [] } },
      anthropic: { enabled: true, headers: { forwardHeaders: [] } },
    },
  }, {})
  check('empty forwardHeaders falls back to the vendor default (gemini)',
    guarded.targets.gemini.headers.forwardHeaders.includes('x-goog-api-key'),
    JSON.stringify(guarded.targets.gemini.headers.forwardHeaders))
  check('empty forwardHeaders falls back to the vendor default (anthropic)',
    guarded.targets.anthropic.headers.forwardHeaders.includes('x-api-key'),
    JSON.stringify(guarded.targets.anthropic.headers.forwardHeaders))
  check('an explicit list is preserved',
    resolveConfig({ targets: { gemini: { enabled: true, headers: { forwardHeaders: ['x-custom'] } } } }, {})
      .targets.gemini.headers.forwardHeaders.join(',') === 'x-custom')
}

const failures = []
try {
  resolveConfig({
    ...patchConfig,
    listenPort: 70000,
    bogusKey: 1,
    features: { nope: true },
    targets: { gemini: { enabled: true, nope: true } },
  }, {})
} catch (error) {
  failures.push(error.message)
}
check('invalid config is rejected with every problem listed',
  failures.length === 1 && /listenPort/.test(failures[0]) && /bogusKey/.test(failures[0])
    && /features.nope/.test(failures[0]) && /nope/.test(failures[0]),
  failures[0])
check('all feature switches default to on', Object.values(cfg.features).every((value) => value === true), JSON.stringify(cfg.features))

console.log(failed === 0 ? '\n全部通过' : `\n失败 ${failed} 项`)
process.exitCode = failed === 0 ? 0 : 1
