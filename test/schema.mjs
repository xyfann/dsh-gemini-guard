// Schema export test.
//
// The `Config` export is deliberately two-mode: present when this package is
// installed as a normal dependency (so `@deepseek-ai/schemastery` resolves and
// the Settings page can render a form), absent when it is a linked local
// directory. This test pins the mode this checkout is in and proves the entry
// still loads.
//
// Run: node test/schema.mjs
import { Config, apply, name } from '../index.js'

let failed = 0
function check(label, condition, detail) {
  if (condition) {
    console.log(`PASS  ${label}`)
    return
  }
  failed += 1
  console.log(`FAIL  ${label}${detail === undefined ? '' : ` -> ${detail}`}`)
}

check('entry exports its name', name === 'gemini-guard', String(name))
check('entry exports apply()', typeof apply === 'function', typeof apply)

let resolvable = false
try {
  await import('@deepseek-ai/schemastery')
  resolvable = true
} catch {
  resolvable = false
}

if (resolvable) {
  check('schemastery resolves, so Config must be a function', typeof Config === 'function', typeof Config)
  if (typeof Config === 'function') {
    const normalized = Config({ enabled: true, targets: { gemini: { enabled: true } } })
    check('schema fills defaults', normalized.listenPort === 8799, String(normalized.listenPort))
    check('schema keeps one enabled target', normalized.targets.gemini.enabled === true && normalized.targets.openai.enabled === false)
    let rejected = false
    try {
      Config({ listenPort: 'nope' })
    } catch {
      rejected = true
    }
    check('schema rejects a wrong type', rejected)
  }
} else {
  check('schemastery is absent, so Config must be undefined', Config === undefined, typeof Config)
  console.log('INFO  这是链接目录模式：设置页会显示原始配置，开关走 /_gemini-guard/ 面板。')
  console.log('INFO  把本包装进 profile 的 node_modules（作为依赖）后，Config 自动变成表单模式。')
}

console.log(failed === 0 ? '\n全部通过' : `\n失败 ${failed} 项`)
process.exitCode = failed === 0 ? 0 : 1
