// Extension-point wiring: admit-or-block every guarded model call, keep one
// coherent request fingerprint per vendor, keep prompt-side environment facts
// consistent with the egress region, and point each provider route at the relay.
import { targetForRoute } from './config.js'
import { guardError } from './guard.js'

const PI_AI_PLUGIN = '@deepseek-ai/dsh-llm-pi-ai'

/**
 * `llm/stream` waterfall: the only place that can refuse a model call before
 * the adapter builds a request. A guarded call that cannot prove a usable exit
 * throws here, so the failure is local and costs the vendor nothing.
 */
export function registerLlmStreamGuard(ctx, { cfg, guard, log }) {
  ctx.on('llm/stream', async function* geminiGuardStream(options, next) {
    const target = targetForRoute(cfg, options?.provider)
    if (!target) {
      yield* next()
      return
    }
    const admission = await guard.admit(target.id)
    if (!admission.ok) {
      log.warn('拦截模型调用', `${target.id} ${admission.reason}: ${admission.detail ?? ''}`)
      throw guardError(cfg, target.id, admission)
    }
    yield* next()
  })
}

/**
 * `llm-pi-ai/request-headers` waterfall: replace the harness's own client
 * signature with one stable one. Synchronous by contract; a failure here would
 * fail the call, so every edit is defensive.
 */
export function registerHeaderNormalizer(ctx, { cfg, log }) {
  ctx.on('llm-pi-ai/request-headers', (request, headers, next) => {
    const target = targetForRoute(cfg, request?.provider)
    if (!target || !cfg.features.headerNormalize) return next()
    const { userAgent, acceptLanguage, apiClientHeader, apiClient } = target.headers
    try {
      if (typeof headers?.set === 'function') {
        headers.set('user-agent', userAgent)
        headers.set('accept-language', acceptLanguage)
        if (apiClientHeader && apiClient) headers.set(apiClientHeader, apiClient)
      } else if (headers && typeof headers === 'object') {
        headers['user-agent'] = userAgent
        headers['accept-language'] = acceptLanguage
        if (apiClientHeader && apiClient) headers[apiClientHeader] = apiClient
      }
    } catch (error) {
      log.warn('规范化请求头失败（已忽略）', error instanceof Error ? error.message : String(error))
    }
    return next()
  })
}

/** Environment facts, optionally derived from the probe so one config serves any region. */
function effectiveEnvironment(cfg, guard) {
  const env = cfg.environment
  if (!env.followExit) return env
  const geo = guard?.egressCache?.geo
  if (!geo) return env
  return {
    ...env,
    region: geo.countryCode || env.region,
    timeZone: geo.timeZone || env.timeZone,
  }
}

function environmentText(cfg, guard) {
  const env = effectiveEnvironment(cfg, guard)
  return [
    'Local environment facts for this machine:',
    `- Account region: ${env.region}`,
    `- Time zone: ${env.timeZone}`,
    `- Locale: ${env.locale}`,
    `- Device: ${env.device}`,
    'Use these values when the user asks about this machine, its local clock, or its network location.',
    'Do not infer the location from the language the user writes in.',
  ].join('\n')
}

function rewritePresentation(presentation, cfg, guard) {
  const env = cfg.environment
  const effective = effectiveEnvironment(cfg, guard)
  if (!env.rewriteTimeZone || !env.sourceTimeZone || env.sourceTimeZone === effective.timeZone) {
    return presentation
  }
  const swap = (value) => (typeof value === 'string' && value.includes(env.sourceTimeZone)
    ? value.split(env.sourceTimeZone).join(effective.timeZone)
    : value)
  const next = { ...presentation }
  if (Array.isArray(presentation?.contexts)) {
    next.contexts = presentation.contexts.map((entry) => ({ ...entry, text: swap(entry.text) }))
  }
  if (Array.isArray(presentation?.sections)) {
    next.sections = presentation.sections.map((entry) => ({ ...entry, text: swap(entry.text) }))
  }
  return next
}

/** Prompt-side consistency: one environment block plus timezone rewriting. */
export function registerPromptHooks(ctx, { cfg, log, guard }) {
  const systemPrompt = ctx.get('systemPrompt')
  if (!systemPrompt) {
    log.warn('systemPrompt 服务不可用，跳过提示词一致性注入')
    return
  }

  if (cfg.environment.injectContext && cfg.features.promptContext && typeof systemPrompt.context === 'function') {
    ctx.effect(() => systemPrompt.context({
      name: 'gemini-guard/environment',
      order: cfg.environment.contextOrder,
      text: () => environmentText(cfg, guard),
    }))
  }

  if (cfg.environment.rewriteTimeZone) {
    ctx.on('system-prompt/assemble', async (assembly, context, next) => {
      const resolved = await next()
      if (!cfg.features.promptContext) return resolved
      return rewritePresentation(resolved, cfg, guard)
    })
  }
}

/**
 * Undo the baseURL rewrite so an uninstall leaves nothing pointing at a dead
 * relay port. Only touches entries that point at this relay.
 */
export async function restoreProviderRoutes(ctx, { cfg, log }) {
  const editor = ctx.get('configEditor')
  if (!editor || typeof editor.entries !== 'function' || typeof editor.edit !== 'function') {
    throw new Error('configEditor 不可用')
  }
  const entries = editor.entries() ?? []
  const nameOf = (entry) => entry?.options?.name ?? entry?.name ?? entry?.plugin?.name ?? ''
  const row = entries.find((entry) => nameOf(entry) === PI_AI_PLUGIN)
  if (!row) throw new Error(`未找到 ${PI_AI_PLUGIN} 行`)

  const restored = []
  await editor.edit(row, (current) => {
    const providers = { ...(current?.providers ?? {}) }
    let dirty = false
    for (const target of Object.values(cfg.targets)) {
      const existing = providers[target.route]
      if (!existing || !target.relayBaseUrl) continue
      const base = typeof existing.baseURL === 'string' ? existing.baseURL : ''
      const relayRoot = target.relayBaseUrl.slice(0, target.relayBaseUrl.length - target.upstreamBasePath.length)
      if (!base.startsWith(relayRoot)) continue
      // Drop only our override; the route keeps its credential reference and
      // falls back to the vendor's own endpoint.
      const next = { ...existing }
      delete next.baseURL
      providers[target.route] = next
      restored.push(target.route)
      dirty = true
    }
    return dirty ? { ...current, providers } : current
  })
  if (restored.length > 0) log.info(`已撤销路由改写：${restored.join(',')}`)
  return restored
}

/**
 * Point every relay-backed route at its prefix. Best-effort by design: a
 * profile whose loader does not expose the entry keeps its own configuration
 * and gets a warning with the YAML to paste instead of a silently broken route.
 */
export async function ensureProviderRoutes(ctx, { cfg, log }) {
  if (!cfg.features.autoRoute) {
    log.info('自动路由已关闭（features.autoRoute = false），provider baseURL 保持原样')
    return { ok: false, written: [], error: 'autoRoute-disabled' }
  }
  const wanted = cfg.enabledTargets.filter((target) => target.manageProviderRoute && target.transport === 'relay')
  if (wanted.length === 0) return { ok: true, written: [], error: '' }

  const editor = ctx.get('configEditor')
  if (!editor || typeof editor.entries !== 'function' || typeof editor.edit !== 'function') {
    log.warn('configEditor 不可用；请按详情文档手动写入 provider 配置块')
    return { ok: false, written: [], error: 'configEditor-unavailable' }
  }

  let entries = []
  try {
    entries = editor.entries() ?? []
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    log.warn('读取 loader entries 失败，跳过自动写入', detail)
    return { ok: false, written: [], error: detail }
  }

  const nameOf = (entry) => entry?.options?.name ?? entry?.name ?? entry?.plugin?.name ?? ''
  const row = entries.find((entry) => nameOf(entry) === PI_AI_PLUGIN)
  if (!row) {
    log.warn(`未找到 ${PI_AI_PLUGIN} 行；请手动写入 provider 配置块`)
    return { ok: false, written: [], error: 'row-not-found' }
  }

  const written = []
  const EDIT_TIMEOUT_MS = 10000
  try {
    // A hanging editor must not hang its caller (the retry ladder or the panel
    // endpoint). Racing it keeps the failure observable and bounded.
    await Promise.race([
      editor.edit(row, (current) => {
        const providers = { ...(current?.providers ?? {}) }
        let dirty = false
        for (const target of wanted) {
          const existing = providers[target.route] ?? {}
          const existingBase = typeof existing.baseURL === 'string' ? existing.baseURL : ''
          const relayRoot = target.relayBaseUrl.slice(0, target.relayBaseUrl.length - target.upstreamBasePath.length)
          if (existingBase !== '' && !existingBase.startsWith(relayRoot)) {
            log.warn(`${target.route} 路由已指向 ${existingBase}，与本机中继 ${relayRoot} 不一致；保持原样，请自行确认`)
            continue
          }
          const candidate = {
            ...existing,
            displayName: existing.displayName ?? target.displayName,
            apiKeyEnv: existing.apiKeyEnv ?? target.apiKeyRef,
            baseURL: target.relayBaseUrl,
          }
          // `models: []` replaces the installed catalog wholesale, so the route
          // ends up advertising nothing. An empty list is never what a user
          // means after filling in a key: drop it and let the catalog apply.
          if (Array.isArray(candidate.models) && candidate.models.length === 0) {
            delete candidate.models
            log.info(`${target.route} 的 models 列表为空（会隐藏全部模型），已移除该字段以恢复内置目录`)
          }
          if (JSON.stringify(candidate) === JSON.stringify(existing)) continue
          providers[target.route] = candidate
          written.push(target.route)
          dirty = true
        }
        return dirty ? { ...current, providers } : current
      }),
      new Promise((_, reject) => {
        const timer = setTimeout(() => reject(new Error(`config editor did not settle within ${EDIT_TIMEOUT_MS} ms`)), EDIT_TIMEOUT_MS)
        timer.unref?.()
      }),
    ])
  } catch (error) {
    // Activation can happen inside an HMR transaction, where a nested config
    // write is refused ("HMR transactions cannot be nested") or hangs. The
    // caller retries after the transaction settles; the panel can also trigger
    // it by hand.
    const detail = error instanceof Error ? error.message : String(error)
    log.warn('写入 provider 配置未完成（稍后重试）', detail)
    return { ok: false, written, error: detail }
  }
  if (written.length > 0) log.info(`已把 ${written.join(' / ')} 路由指向本机中继`)
  return { ok: true, written, error: '' }
}
