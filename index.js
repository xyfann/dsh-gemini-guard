// dsh-gemini-guard — a fail-closed egress gate for the vendor routes that check
// where a request comes from.
//
// Why this exists: vendors decide whether a developer API is offered from the
// caller's public IP. A flapping VPN node turns one key into traffic from many
// countries in a few minutes, which is both a hard error and exactly the pattern
// abuse systems watch for. This plugin refuses to send anything until it can
// prove a usable, allow-listed, stable exit — and stops the moment that proof
// fails.
import { resolveConfig } from './config.js'
import { createLogger, GeoGuard } from './guard.js'
import { createIntegrityChecker } from './integrity.js'
import { createRelayServer } from './relay.js'
import {
  ensureProviderRoutes,
  registerHeaderNormalizer,
  registerLlmStreamGuard,
  registerPromptHooks,
  restoreProviderRoutes,
} from './hooks.js'

export const name = 'gemini-guard'

// Schema for the Settings form. Undefined when `@deepseek-ai/schemastery` is not
// resolvable (locally linked bundle): the row still mounts, configuration stays
// in the control panel and YAML.
export { Config } from './schema.js'

const SELF_PLUGIN_NAMES = ['dsh-gemini-guard']

function message(error) {
  return error instanceof Error ? error.message : String(error)
}

const EGRESS_KEYS = new Set([
  'allowedCountries',
  'confirmations',
  'requireStableExit',
  'maxDistinctExitIps',
  'rejectHosting',
  'rejectProxyFlag',
  'timeZoneConsistency',
])

/** Translate the panel's flat patch into the row's nested config shape. */
function mergePatch(current, patch) {
  const next = { ...(current ?? {}) }
  for (const [key, value] of Object.entries(patch ?? {})) {
    if (key === 'features' && value && typeof value === 'object') {
      next.features = { ...(next.features ?? {}), ...value }
      continue
    }
    if (key === 'targets' && value && typeof value === 'object') {
      const targets = { ...(next.targets ?? {}) }
      for (const [id, targetPatch] of Object.entries(value)) {
        targets[id] = { ...(targets[id] ?? {}), ...targetPatch }
      }
      next.targets = targets
      continue
    }
    if (EGRESS_KEYS.has(key)) {
      next.egress = { ...(next.egress ?? {}), [key]: value }
      continue
    }
    if (key === 'maxConcurrentPerTarget') {
      next.limits = { ...(next.limits ?? {}), maxConcurrentPerTarget: value }
      continue
    }
    next[key] = value
  }
  return next
}

/** Persist panel changes into the profile's own patch row. */
function createPersist(ctx, log) {
  return async (patch) => {
    const editor = ctx.get('configEditor')
    if (!editor || typeof editor.entries !== 'function' || typeof editor.edit !== 'function') {
      throw new Error('configEditor 不可用')
    }
    const entries = editor.entries() ?? []
    const nameOf = (entry) => entry?.options?.name ?? entry?.name ?? entry?.plugin?.name ?? ''
    const row = entries.find((entry) => SELF_PLUGIN_NAMES.includes(nameOf(entry)))
    if (!row) throw new Error('未找到本插件的配置行')
    await editor.edit(row, (current) => mergePatch(current, patch))
    log.info('开关已写入 profile 配置')
  }
}

export async function apply(ctx, rawConfig) {
  const cfg = resolveConfig(rawConfig, { harnessHome: process.env.DSH_HOME })
  const log = createLogger(cfg)
  const guard = new GeoGuard(cfg, log)
  // 三份代码对比（工作区 / GitHub / 已安装）不需要任何配置：位置从环境变量推。
  const integrity = createIntegrityChecker({ log })

  const relayTargets = cfg.enabledTargets.filter((target) => target.transport === 'relay')
  if (relayTargets.length > 0) {
    const server = createRelayServer({
      cfg,
      guard,
      log,
      persist: createPersist(ctx, log),
      unroute: () => restoreProviderRoutes(ctx, { cfg, log }),
      route: () => ensureProviderRoutes(ctx, { cfg, log }),
      integrity,
    })
    try {
      await new Promise((resolve, reject) => {
        const onError = (error) => {
          server.removeListener('listening', onListening)
          reject(error)
        }
        const onListening = () => {
          server.removeListener('error', onError)
          resolve()
        }
        server.once('error', onError)
        server.once('listening', onListening)
        server.listen(cfg.listenPort, cfg.listenHost)
      })
      log.info(`中继已监听 ${cfg.listenHost}:${cfg.listenPort}（${relayTargets.map((t) => t.pathPrefix).join(' ')}）`)
      log.info(`控制面板 ${cfg.controlBaseUrl}/`)
      // A permanent handler: an 'error' event with no listener is an uncaught
      // exception, and an uncaught exception in the Host process is a DSH crash.
      server.on('error', (error) => {
        log.error('中继错误（已隔离，DSH 进程不受影响）', message(error))
      })
      ctx.effect(() => () => {
        log.info('正在卸载中继')
        server.close()
      })
    } catch (error) {
      // Mounting with a dead relay would leave routes pointing at nothing. Keep
      // the guard mounted, hard-stopped, so calls fail with the real reason
      // instead of a bare ECONNREFUSED.
      guard.forceHardStop('relay-listen-failed', message(error))
    }
  }

  registerLlmStreamGuard(ctx, { cfg, guard, log })
  registerHeaderNormalizer(ctx, { cfg, log })
  registerPromptHooks(ctx, { cfg, log, guard })

  // Route takeover must never block activation.
  //
  // Cordis loads a bundle inside an HMR transaction, and `configEditor.edit()`
  // during that window can hang instead of failing. An `await` here therefore
  // held `apply()` open and the host never reached ready — the app window never
  // opened. Activation returns first; the takeover runs on a timer, then walks
  // the retry ladder. The same call is exposed as POST /_gemini-guard/route.
  const routeProvider = () => ensureProviderRoutes(ctx, { cfg, log })
  const routeTimer = setTimeout(() => {
    void (async () => {
      try {
        const first = await routeProvider()
        if (first.ok || first.error === 'autoRoute-disabled') return
      } catch (error) {
        log.warn('路由接管异常（稍后重试）', message(error))
      }
      for (const delayMs of [1500, 5000, 15000, 40000]) {
        await new Promise((resolve) => setTimeout(resolve, delayMs))
        try {
          const result = await routeProvider()
          if (result.ok || result.error === 'autoRoute-disabled') {
            log.info('路由接管完成（延迟重试）')
            return
          }
        } catch (error) {
          log.warn('路由接管重试异常', message(error))
        }
      }
      log.warn('路由接管仍未成功：可在控制面板点「接管路由」，或按详情文档手工写入 provider 配置块')
    })()
  }, 1500)
  routeTimer.unref?.()
  ctx.effect(() => () => clearTimeout(routeTimer))

  if (cfg.enabled) {
    // Warm the proof now: the first model call should not be the thing that
    // discovers a dead or suspicious node.
    for (const target of cfg.enabledTargets) {
      void guard.probe(target.id, { force: true }).catch((error) => {
        log.warn(`${target.id} 启动探测异常`, message(error))
      })
    }
  }
}
