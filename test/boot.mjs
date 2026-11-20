// Boot regression test: `apply()` must resolve even when the config editor never
// settles.
//
// This pins the failure that took the host down once: activation awaited a
// config write, the editor hung inside the HMR transaction, `apply()` never
// returned, and the app window never opened. The route takeover now runs on a
// timer, so activation returns immediately.
//
// Run: node test/boot.mjs
import os from 'node:os'
import path from 'node:path'
import { apply } from '../index.js'

let failed = 0
function check(label, condition, detail) {
  if (condition) {
    console.log(`PASS  ${label}`)
    return
  }
  failed += 1
  console.log(`FAIL  ${label}${detail === undefined ? '' : ` -> ${detail}`}`)
}

const disposers = []
const never = () => new Promise(() => {})

const ctx = {
  on: () => () => {},
  effect: (fn) => {
    const disposer = fn()
    if (typeof disposer === 'function') disposers.push(disposer)
    return () => {}
  },
  get: (name) => {
    if (name === 'systemPrompt') return undefined
    if (name === 'configEditor') {
      return {
        entries: () => [{ name: '@deepseek-ai/dsh-llm-pi-ai' }],
        // The exact failure mode: an edit that never settles.
        edit: never,
      }
    }
    return undefined
  },
}

const config = {
  enabled: true,
  listenPort: 18911,
  logFile: path.join(os.tmpdir(), 'dsh-gemini-guard-boot.log'),
  // No network during the test: the probe short-circuits when it is off.
  features: { egressProbe: false },
  targets: { gemini: { enabled: true } },
}

const startedAt = Date.now()
let outcome = 'pending'
const result = await Promise.race([
  apply(ctx, config).then(() => 'resolved', (error) => `threw: ${error?.message ?? error}`),
  new Promise((resolve) => {
    const timer = setTimeout(() => resolve('timeout'), 4000)
    timer.unref?.()
  }),
])
outcome = result
const elapsed = Date.now() - startedAt

check('apply() resolves without waiting for the config editor', outcome === 'resolved', `${outcome} after ${elapsed} ms`)
check('apply() returns promptly (under 2s)', elapsed < 2000, `${elapsed} ms`)

// Give the 1.5s timer a chance to fire and prove it does not throw upward.
await new Promise((resolve) => setTimeout(resolve, 1900))
check('deferred route takeover does not surface an error', true)

for (const dispose of disposers) {
  try {
    dispose()
  } catch {
    // Disposal order is the host's business; this test only asserts boot.
  }
}

console.log(failed === 0 ? '\n全部通过' : `\n失败 ${failed} 项`)
process.exitCode = failed === 0 ? 0 : 1
