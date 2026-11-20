// Route takeover test: what `ensureProviderRoutes` writes into the `llm-pi-ai`
// row. Covers the two ways the takeover has actually gone wrong in practice:
//
//   1. an empty `models: []` left over from the settings UI, which hides every
//      model on a catalog route;
//   2. a baseURL the user set deliberately, which must never be overwritten.
//
// Run: node test/route.mjs
import { resolveConfig } from '../config.js'
import { ensureProviderRoutes } from '../hooks.js'

let failed = 0
function check(label, condition, detail) {
  if (condition) {
    console.log(`PASS  ${label}`)
    return
  }
  failed += 1
  console.log(`FAIL  ${label}${detail === undefined ? '' : ` -> ${detail}`}`)
}

const log = { info: () => {}, warn: () => {}, error: () => {}, recent: () => [] }
const row = { name: '@deepseek-ai/dsh-llm-pi-ai' }

function makeContext(initialProviders) {
  const captured = { value: null, calls: 0 }
  const ctx = {
    get: (name) => (name === 'configEditor'
      ? {
          entries: () => [row],
          edit: async (entry, change) => {
            captured.calls += 1
            captured.value = change({ providers: structuredClone(initialProviders) })
          },
        }
      : undefined),
  }
  return { ctx, captured }
}

const cfg = resolveConfig({ targets: { gemini: { enabled: true } } }, { harnessHome: 'C:\\tmp' })

// 1. Empty models list is dropped, baseURL/apiKeyEnv are filled in.
{
  const { ctx, captured } = makeContext({
    google: {
      displayName: 'Google AI Studio',
      apiKeyEnv: 'GOOGLE_AI_STUDIO_API_KEY',
      baseURL: 'http://127.0.0.1:8799/gemini/v1beta',
      models: [],
    },
  })
  const result = await ensureProviderRoutes(ctx, { cfg, log })
  const written = captured.value?.providers?.google
  check('takeover reports success', result.ok === true, JSON.stringify(result))
  check('empty models list is removed', written !== undefined && !('models' in written), JSON.stringify(written))
  check('relay baseURL is kept', written?.baseURL === 'http://127.0.0.1:8799/gemini/v1beta', written?.baseURL)
  check('credential reference is kept', written?.apiKeyEnv === 'GOOGLE_AI_STUDIO_API_KEY', written?.apiKeyEnv)
}

// 2. A user-set baseURL that is not our relay is left alone.
{
  const { ctx, captured } = makeContext({
    google: {
      apiKeyEnv: 'GOOGLE_AI_STUDIO_API_KEY',
      baseURL: 'https://my-own-gateway.example/v1beta',
    },
  })
  const result = await ensureProviderRoutes(ctx, { cfg, log })
  const written = captured.value?.providers?.google
  check('foreign baseURL is preserved', written?.baseURL === 'https://my-own-gateway.example/v1beta', written?.baseURL)
  check('takeover reports success without writing', result.ok === true && result.written.length === 0, JSON.stringify(result))
}

// 3. A route that does not exist yet is created with the relay URL.
{
  const { ctx, captured } = makeContext({})
  const result = await ensureProviderRoutes(ctx, { cfg, log })
  const written = captured.value?.providers?.google
  check('missing route is created', written?.baseURL === 'http://127.0.0.1:8799/gemini/v1beta', JSON.stringify(written))
  check('created route gets a display name', typeof written?.displayName === 'string' && written.displayName !== '', written?.displayName)
  check('created route records the write', result.written.includes('google'), JSON.stringify(result.written))
}

// 4. No config editor: the caller learns why instead of hanging.
{
  const ctx = { get: () => undefined }
  const result = await ensureProviderRoutes(ctx, { cfg, log })
  check('missing config editor is reported', result.ok === false && result.error === 'configEditor-unavailable', JSON.stringify(result))
}

// 5. A hanging editor is bounded by the timeout instead of hanging the caller.
//    The production timer is unref'd, so keep the loop alive while we wait.
{
  const keepAlive = setInterval(() => {}, 500)
  const ctx = {
    get: (name) => (name === 'configEditor'
      ? { entries: () => [row], edit: () => new Promise(() => {}) }
      : undefined),
  }
  const startedAt = Date.now()
  const result = await ensureProviderRoutes(ctx, { cfg, log })
  const elapsed = Date.now() - startedAt
  clearInterval(keepAlive)
  check('hanging editor times out', result.ok === false && /did not settle/.test(result.error), JSON.stringify(result))
  check('timeout is bounded (11s or less)', elapsed <= 11000, `${elapsed} ms`)
}

console.log(failed === 0 ? '\n全部通过' : `\n失败 ${failed} 项`)
process.exitCode = failed === 0 ? 0 : 1
