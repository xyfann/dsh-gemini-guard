// The admission decision every guarded model call must pass, plus the circuit
// breaker that stops traffic when an exit is unhealthy or looks risky.
//
// Two layers of state live here on purpose:
//   * shared egress state  - one exit identity for every vendor on this machine
//   * per-target state     - one breaker and one counter set per vendor route,
//                            because a vendor-specific rejection must not stop
//                            the others.
import fs from 'node:fs'
import path from 'node:path'
import { lookup } from 'node:dns/promises'
import { countryListFor, targetForRoute } from './config.js'
import { detectSplitTunnel } from './egress-path.js'
import { ExitHistory, assessEgress } from './risk.js'
import { getThroughEgress, openOutbound } from './transport.js'

const MAX_MEMORY_LOG = 300

export function createLogger(cfg) {
  const records = []
  const file = cfg.logFile

  function append(record) {
    records.push(record)
    if (records.length > MAX_MEMORY_LOG) records.shift()
    if (cfg.verbose) {
      // eslint-disable-next-line no-console
      console.log(`[gemini-guard] ${record.level} ${record.message}`)
    }
    if (!file) return
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.appendFile(file, `${JSON.stringify(record)}\n`, () => {})
    } catch {
      // Logging must never break the guard itself.
    }
  }

  const make = (level) => (message, detail) => append({
    at: new Date().toISOString(),
    level,
    message,
    ...(detail === undefined ? {} : { detail }),
  })

  return { info: make('info'), warn: make('warn'), error: make('error'), recent: () => records.slice(-60) }
}

function freshBreaker() {
  return { state: 'closed', failures: 0, openedAt: 0, reason: '', hard: false }
}

function freshCounters() {
  return {
    requests: 0,
    admitted: 0,
    blocked: 0,
    geoRejections: 0,
    authRejections: 0,
    rateLimited: 0,
    quotaHits: 0,
    upstreamErrors: 0,
    lateAborts: 0,
  }
}

function message(error) {
  return error instanceof Error ? error.message : String(error)
}

/** Bound a promise that has no timeout of its own (DNS, mostly). */
function withDeadline(promise, timeoutMs, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      const timer = setTimeout(() => reject(new Error(`${label}（${timeoutMs} ms）`)), timeoutMs)
      timer.unref?.()
    }),
  ])
}

export class GeoGuard {
  constructor(cfg, log) {
    this.cfg = cfg
    this.log = log
    const first = cfg.enabledTargets[0]
    this.net = {
      proxy: cfg.egress.proxy,
      connectTimeoutMs: cfg.connectTimeoutMs,
      tlsTimeoutMs: cfg.tlsTimeoutMs,
      userAgent: first?.headers.userAgent ?? 'dsh-gemini-guard',
      acceptLanguage: first?.headers.acceptLanguage ?? 'en-US,en;q=0.9',
    }
    this.egressCache = null
    this.refreshing = null
    this.history = new ExitHistory(cfg.egress.stabilityWindowMs)
    this.confirm = { ip: '', count: 0 }
    this.targetState = new Map(cfg.enabledTargets.map((target) => [target.id, {
      breaker: freshBreaker(),
      counters: freshCounters(),
      upstreamCooldownUntil: 0,
      models: new Map(),
    }]))
  }

  #state(targetId) {
    let state = this.targetState.get(targetId)
    if (!state) {
      state = { breaker: freshBreaker(), counters: freshCounters(), upstreamCooldownUntil: 0, models: new Map() }
      this.targetState.set(targetId, state)
    }
    return state
  }

  /** Shared egress refresh: exit identity plus one TLS reachability check per target. */
  async #refresh({ force = false } = {}) {
    const now = Date.now()
    if (!force && this.egressCache && now - this.egressCache.at < this.cfg.egress.ttlMs) {
      return this.egressCache
    }
    if (this.refreshing) return this.refreshing
    this.refreshing = this.#doRefresh().finally(() => {
      this.refreshing = null
    })
    return this.refreshing
  }

  async #doRefresh() {
    const at = Date.now()
    const cache = { at, geo: null, geoError: '', reach: new Map(), splitTunnel: new Map(), unverified: false }

    if (!this.cfg.features.egressProbe) {
      cache.unverified = true
      cache.geoError = '出口探测已关闭（features.egressProbe = false）'
      this.egressCache = cache
      if (!this.warnedUnverified) {
        this.warnedUnverified = true
        this.log.warn('出口探测已关闭', '不再校验出口地区/稳定性；请求会直接发往厂商')
      }
      return cache
    }

    // Which path does the vendor host actually take? A fake/non-public address
    // means a domain-splitting tunnel captured it, and the external geolocation
    // lookup below is then measuring something else entirely.
    await Promise.all(this.cfg.enabledTargets.map(async (target) => {
      try {
        const resolved = await withDeadline(
          lookup(target.upstreamHost, { all: true }),
          this.cfg.egress.timeoutMs,
          `DNS 解析超时：${target.upstreamHost}`,
        )
        cache.splitTunnel.set(target.id, detectSplitTunnel(resolved.map((entry) => entry.address)))
      } catch {
        cache.splitTunnel.set(target.id, null)
      }
    }))

    try {
      const response = await getThroughEgress(this.net, this.cfg.egress.geoUrl, {
        timeoutMs: this.cfg.egress.timeoutMs,
        headers: {},
      })
      if (response.status !== 200) throw new Error(`地理探测返回 HTTP ${response.status}`)
      let geo
      try {
        geo = JSON.parse(response.text)
      } catch {
        throw new Error('地理探测响应不是 JSON')
      }
      if (geo.status && geo.status !== 'success') {
        throw new Error(`地理探测失败：${geo.message ?? geo.status}`)
      }
      cache.geo = {
        ok: true,
        ip: String(geo.query ?? geo.ip ?? ''),
        countryCode: String(geo.countryCode ?? '').toUpperCase(),
        country: String(geo.country ?? ''),
        region: String(geo.regionName ?? ''),
        city: String(geo.city ?? ''),
        timeZone: String(geo.timezone ?? ''),
        isp: String(geo.isp ?? geo.org ?? ''),
        asn: String(geo.as ?? ''),
        proxyFlag: geo.proxy === true,
        hosting: geo.hosting === true,
        mobile: geo.mobile === true,
        latencyMs: response.elapsedMs,
        at,
      }
    } catch (error) {
      cache.geoError = message(error)
    }

    const targetChecks = this.cfg.enabledTargets.map(async (target) => {
      if (!this.cfg.features.reachabilityProbe) {
        cache.reach.set(target.id, { ok: true, skipped: true })
        return
      }
      const startedAt = Date.now()
      try {
        const socket = await openOutbound(this.net, target.upstreamHost, target.upstreamPort, {
          useTls: true,
          timeoutMs: this.cfg.connectTimeoutMs,
        })
        socket.destroy()
        cache.reach.set(target.id, { ok: true, latencyMs: Date.now() - startedAt })
      } catch (error) {
        cache.reach.set(target.id, { ok: false, detail: message(error) })
      }
    })
    await Promise.all(targetChecks)

    if (cache.geo?.ip) {
      this.history.record(cache.geo.ip, at)
      if (this.confirm.ip === cache.geo.ip) {
        this.confirm.count = Math.min(this.confirm.count + 1, this.cfg.egress.confirmations)
      } else {
        this.confirm.ip = cache.geo.ip
        this.confirm.count = 1
      }
      this.log.info(
        `出口 ${cache.geo.ip}（${cache.geo.countryCode}）就绪确认 ${this.confirm.count}/${this.cfg.egress.confirmations}`
        + `${cache.geo.hosting ? '，机房段' : ''}${cache.geo.proxyFlag ? '，被标记为代理' : ''}`,
      )
    } else {
      this.log.warn('出口探测失败', cache.geoError)
    }

    this.egressCache = cache
    return cache
  }

  #evaluate(target, cache) {
    if (cache.unverified) {
      return { ok: true, unverified: true, reason: 'unverified' }
    }
    if (!cache.geo) {
      return { ok: false, reason: 'probe-failed', detail: cache.geoError || '出口探测失败' }
    }
    const reach = cache.reach.get(target.id)
    if (!reach || reach.ok !== true) {
      return { ok: false, reason: 'target-unreachable', detail: `${target.upstreamHost} 不可达：${reach?.detail ?? '未知原因'}` }
    }
    // The vendor host resolves into a fake/non-public range: a domain-splitting
    // tunnel captured it, while the geolocation probe almost certainly did not.
    // The country and the exit-quality numbers therefore describe another path,
    // so gating on them would refuse traffic that is actually fine. Reachability
    // above already measured the real path; the region verdict now comes from
    // the vendor's own answer on a real request.
    const marker = cache.splitTunnel?.get(target.id) ?? null
    if (marker && this.cfg.features.pathAware) {
      if (!this.warnedSplitTunnel) {
        this.warnedSplitTunnel = true
        this.log.warn(
          '检测到域名分流（智能分流）',
          `${target.upstreamHost} 解析到 ${marker}，第三方地理探测不代表 API 路径；`
          + '地区判定改由厂商回包决定，机房/代理/时区/跳动规则不再据此拦截',
        )
      }
      return { ok: true, pathAware: true, reason: 'path-aware', splitTunnel: marker, geo: cache.geo, reach }
    }
    const countries = countryListFor(this.cfg, target)
    if (countries.length > 0 && !countries.includes(cache.geo.countryCode)) {
      return {
        ok: false,
        reason: 'country-not-allowed',
        detail: `出口 ${cache.geo.ip} 归属 ${cache.geo.countryCode}/${cache.geo.country}，允许清单 ${countries.join('/')}`,
        geo: cache.geo,
      }
    }
    const risk = this.cfg.features.riskRules
      ? assessEgress(this.cfg, cache.geo, this.history)
      : { blocked: false, reasons: [] }
    const blocking = risk.reasons.find((reason) => reason.severity === 'block')
    if (blocking) {
      return { ok: false, reason: blocking.code, detail: blocking.detail, risk, geo: cache.geo }
    }
    if (this.confirm.count < this.cfg.egress.confirmations) {
      return {
        ok: false,
        reason: 'awaiting-confirmation',
        detail: `出口 ${cache.geo.ip} 需连续 ${this.cfg.egress.confirmations} 次探测确认，当前 ${this.confirm.count} 次`,
        geo: cache.geo,
      }
    }
    return { ok: true, risk, geo: cache.geo, reach }
  }

  async probe(targetId, { force = false } = {}) {
    const target = this.cfg.targets[targetId]
    if (!target) return { ok: false, reason: 'unknown-target', detail: `未配置的 target：${targetId}` }
    const cache = await this.#refresh({ force })
    return this.#evaluate(target, cache)
  }

  #trip(state, reason, detail, hard) {
    state.breaker.state = 'open'
    state.breaker.openedAt = Date.now()
    state.breaker.reason = reason
    state.breaker.hard = hard
    this.log.warn(`熔断器打开（${reason}${hard ? '，硬停' : ''}）`, detail)
  }

  /** Decide whether one model request for `targetId` may proceed. */
  async admit(targetId, model = '') {
    const target = this.cfg.targets[targetId]
    if (!target || !target.enabled) return { ok: true, skipped: true }
    const state = this.#state(targetId)
    state.counters.requests += 1

    if (!this.cfg.enabled) {
      state.counters.blocked += 1
      return { ok: false, reason: 'disabled', detail: '插件已停用（enabled: false）' }
    }

    const now = Date.now()
    // Model-level health first: a saturated model is a deployment problem, not a
    // route problem, so switching models must remain possible right away.
    if (model !== '') {
      const health = state.models.get(model)
      if (health && health.until > now) {
        state.counters.blocked += 1
        const healthy = [...state.models.entries()]
          .filter(([, entry]) => entry.until <= now)
          .map(([id]) => id)
        return {
          ok: false,
          reason: 'model-cooling',
          model,
          detail: `型号 ${model} 冷却中（${health.lastKind}），还剩 ${Math.ceil((health.until - now) / 1000)} 秒`
            + (healthy.length > 0 ? `；当前可用：${healthy.join(', ')}` : '；可在面板里复位或换型号'),
        }
      }
    }
    if (state.upstreamCooldownUntil > now) {
      state.counters.blocked += 1
      return {
        ok: false,
        reason: 'upstream-cooldown',
        detail: `上游要求冷却，还剩 ${Math.ceil((state.upstreamCooldownUntil - now) / 1000)} 秒`,
      }
    }

    if (state.breaker.state === 'open') {
      const cooldown = state.breaker.hard ? this.cfg.breaker.hardStopCooldownMs : this.cfg.breaker.cooldownMs
      const remaining = state.breaker.openedAt + cooldown - now
      if (remaining > 0) {
        state.counters.blocked += 1
        return {
          ok: false,
          reason: state.breaker.hard ? 'hard-stopped' : 'breaker-open',
          detail: `熔断器打开（${state.breaker.reason}），还需 ${Math.ceil(remaining / 1000)} 秒冷却，或访问 ${this.cfg.controlBaseUrl}/reset 复位`,
        }
      }
      state.breaker.state = 'half-open'
      this.log.info(`${target.id} 熔断进入 half-open，允许一次探测`)
    }

    const cache = await this.#refresh()
    const verdict = this.#evaluate(target, cache)
    if (!verdict.ok) {
      state.counters.blocked += 1
      if (verdict.reason === 'country-not-allowed') {
        state.counters.geoRejections += 1
        this.#trip(state, 'geo', verdict.detail, this.cfg.breaker.hardStop)
      }
      this.log.warn(`${target.id} 请求被拦截`, `${verdict.reason}：${verdict.detail}`)
      return verdict
    }

    state.counters.admitted += 1
    for (const warning of verdict.risk?.reasons ?? []) {
      if (warning.severity === 'warn') this.log.warn(`${target.id} 出口提示`, `${warning.code}：${warning.detail}`)
    }
    return verdict
  }

  async admitByRoute(route) {
    const target = targetForRoute(this.cfg, route)
    if (!target) return { ok: true, skipped: true }
    return this.admit(target.id, model)
  }

  /** Feed one request outcome back into that target's breaker. */
  recordOutcome(targetId, outcome = {}) {
    const target = this.cfg.targets[targetId]
    if (!target) return
    const state = this.#state(targetId)
    const { kind, detail = '', status = 0, retryAfterMs = 0, model = '' } = outcome
    const now = Date.now()

    switch (kind) {
      case 'ok':
        state.breaker.failures = 0
        if (state.breaker.state === 'half-open') {
          state.breaker.state = 'closed'
          state.breaker.hard = false
          state.breaker.reason = ''
          this.log.info(`${target.id} half-open 探测成功，熔断器 closed`)
        }
        return

      case 'geo':
        state.counters.geoRejections += 1
        this.#trip(state, 'geo-blocked-by-vendor', detail, this.cfg.breaker.hardStop)
        return

      case 'auth':
        state.counters.authRejections += 1
        this.#trip(state, 'auth-rejected', detail, false)
        return

      case 'quota':
        state.counters.quotaHits += 1
        state.upstreamCooldownUntil = now + Math.max(retryAfterMs, 600000)
        this.log.warn(`${target.id} 配额耗尽，冷却 ${Math.round(Math.max(retryAfterMs, 600000) / 1000)} 秒`, detail)
        return

      case 'rate-limit':
        state.counters.rateLimited += 1
        state.upstreamCooldownUntil = now + Math.max(retryAfterMs, 30000)
        this.log.warn(`${target.id} 上游限流，冷却 ${Math.round(Math.max(retryAfterMs, 30000) / 1000)} 秒`, detail)
        return

      case 'overloaded':
        state.counters.upstreamErrors += 1
        if (model !== '') {
          // Per-deployment ejection (LiteLLM cools a deployment, Envoy ejects a
          // host): the route stays usable through its other models.
          state.models.set(model, {
            until: now + Math.max(retryAfterMs, this.cfg.breaker.modelCooldownMs),
            lastKind: 'overloaded',
          })
          this.log.warn(`${target.id} 型号 ${model} 高负载，单独冷却 ${Math.round(this.cfg.breaker.modelCooldownMs / 1000)} 秒`, detail)
        } else {
          state.upstreamCooldownUntil = now + Math.max(retryAfterMs, 2000)
          this.log.warn(`${target.id} 厂商高负载（换型号或稍后再试）`, detail)
        }
        return

      case 'server':
        state.counters.upstreamErrors += 1
        this.log.warn(`${target.id} 上游 ${status || 5}xx`, detail)
        return

      case 'client':
        return

      case 'late-abort':
        state.counters.lateAborts += 1
        state.breaker.failures += 1
        this.log.warn(`${target.id} 流中断（连续 ${state.breaker.failures} 次）`, detail)
        if (state.breaker.failures >= this.cfg.breaker.failureThreshold) {
          this.#trip(state, 'egress-unstable', detail, false)
        }
        return

      case 'transport':
        state.counters.upstreamErrors += 1
        state.breaker.failures += 1
        this.log.warn(`${target.id} 出口传输失败（连续 ${state.breaker.failures} 次）`, detail)
        if (state.breaker.failures >= this.cfg.breaker.failureThreshold) {
          this.#trip(state, 'egress-unstable', detail, false)
        }
        return

      default:
        return
    }
  }

  forceHardStop(reason, detail) {
    for (const target of this.cfg.enabledTargets) {
      this.#trip(this.#state(target.id), reason, detail, true)
    }
  }

  /** Drop every latch without probing: used when a switch changes the rules. */
  clearBreakers() {
    for (const id of this.targetState.keys()) {
      const state = this.#state(id)
      state.breaker = freshBreaker()
      state.upstreamCooldownUntil = 0
      state.models.clear()
    }
    this.egressCache = null
    this.log.info('开关变更，已清除熔断与探测缓存')
  }

  /**
   * Release the latches that a user action can plausibly have fixed (a re-pasted
   * key, a switched node) while keeping hard stops. Called by /recheck: the
   * button says "check the exit again", so it must not leave a stale refusal in
   * place that only /reset could clear.
   */
  releaseSoftBreakers() {
    const released = []
    for (const id of this.targetState.keys()) {
      const state = this.#state(id)
      if (state.breaker.state === 'open' && state.breaker.hard) continue
      if (state.breaker.state !== 'closed' || state.upstreamCooldownUntil !== 0 || state.models.size > 0) {
        released.push(id)
      }
      state.breaker = freshBreaker()
      state.upstreamCooldownUntil = 0
      state.models.clear()
    }
    if (released.length > 0) this.log.info(`复检前已解除软熔断：${released.join(',')}`)
    return released
  }

  /** Manual reset: clears breakers, then re-probes the exit. */
  async reset(targetId) {
    const ids = targetId ? [targetId] : [...this.targetState.keys()]
    for (const id of ids) {
      const state = this.#state(id)
      state.breaker = freshBreaker()
      state.upstreamCooldownUntil = 0
      state.models.clear()
    }
    this.egressCache = null
    this.confirm = { ip: '', count: 1 }
    this.history = new ExitHistory(this.cfg.egress.stabilityWindowMs)
    this.log.info(`已复位（${ids.join(',')}），重新探测出口`)
    const target = this.cfg.enabledTargets[0]
    return target ? this.probe(target.id, { force: true }) : { ok: false, reason: 'no-target' }
  }

  snapshot() {
    const cache = this.egressCache
    const targets = {}
    for (const target of this.cfg.enabledTargets) {
      const state = this.#state(target.id)
      const reach = cache?.reach.get(target.id)
      targets[target.id] = {
        enabled: target.enabled,
        route: target.route,
        transport: target.transport,
        relayBaseUrl: target.relayBaseUrl,
        upstream: `${target.upstreamHost}:${target.upstreamPort}`,
        allowedCountries: countryListFor(this.cfg, target),
        reachable: reach?.ok ?? null,
        reachDetail: reach?.detail ?? null,
        splitTunnel: cache?.splitTunnel?.get(target.id) ?? null,
        breaker: {
          state: state.breaker.state,
          reason: state.breaker.reason,
          hard: state.breaker.hard,
          failures: state.breaker.failures,
          openedAt: state.breaker.openedAt === 0 ? null : new Date(state.breaker.openedAt).toISOString(),
        },
        upstreamCooldownUntil: state.upstreamCooldownUntil === 0 ? null : new Date(state.upstreamCooldownUntil).toISOString(),
        // Only models currently ejected are listed; an empty object means the
        // whole route is usable.
        models: Object.fromEntries(
          [...state.models.entries()]
            .filter(([, health]) => health.until > Date.now())
            .map(([id, health]) => [id, { until: new Date(health.until).toISOString(), lastKind: health.lastKind }]),
        ),
        counters: state.counters,
      }
    }
    return {
      plugin: 'dsh-gemini-guard',
      enabled: this.cfg.enabled,
      egress: !this.cfg.features.egressProbe || cache?.unverified
        ? { phase: 'unverified', error: cache?.geoError || '出口探测已关闭（features.egressProbe = false）' }
        : cache?.geo
        ? {
            phase: 'probed',
            ip: cache.geo.ip,
            countryCode: cache.geo.countryCode,
            country: cache.geo.country,
            region: cache.geo.region,
            city: cache.geo.city,
            timeZone: cache.geo.timeZone,
            isp: cache.geo.isp,
            asn: cache.geo.asn,
            hosting: cache.geo.hosting,
            proxyFlag: cache.geo.proxyFlag,
            latencyMs: cache.geo.latencyMs,
            confirmations: `${this.confirm.count}/${this.cfg.egress.confirmations}`,
            distinctIpsInWindow: this.history.distinct(),
            recentIps: this.history.recent(),
            checkedAt: new Date(cache.at).toISOString(),
          }
        : { phase: 'unprobed', error: cache?.geoError ?? '' },
      features: { ...this.cfg.features },
      refreshInFlight: this.refreshing !== null,
      policy: {
        requireStableExit: this.cfg.egress.requireStableExit,
        maxDistinctExitIps: this.cfg.egress.maxDistinctExitIps,
        stabilityWindowMs: this.cfg.egress.stabilityWindowMs,
        rejectHosting: this.cfg.egress.rejectHosting,
        rejectProxyFlag: this.cfg.egress.rejectProxyFlag,
        timeZoneConsistency: this.cfg.egress.timeZoneConsistency,
        confirmations: this.cfg.egress.confirmations,
      },
      environment: this.cfg.environment,
      targets,
      recent: this.log.recent(),
    }
  }
}

export function guardError(cfg, targetId, admission) {
  const target = cfg.targets[targetId]
  const reasonText = {
    'country-not-allowed': '出口 IP 不在允许地区',
    'probe-failed': '出口节点探测失败',
    'target-unreachable': '目标厂商不可达',
    'exit-ip-flapping': '出口 IP 正在跳动',
    'hosting-exit': '出口属于机房段（策略拒绝）',
    'proxy-flagged-exit': '出口被标记为代理（策略拒绝）',
    'timezone-mismatch': '出口时区与本机声明不一致（策略拒绝）',
    'awaiting-confirmation': '出口尚未被连续探测确认',
    'upstream-cooldown': '上游要求冷却',
    'model-cooling': '该型号高负载冷却中（换一个型号即可）',
    'breaker-open': '出口不稳定，熔断冷却中',
    'hard-stopped': '已被硬停，等待人工复位',
    disabled: '插件已停用',
  }[admission.reason] ?? admission.reason

  const error = new Error(
    `[gemini-guard] 已拦截本次 ${target?.displayName ?? targetId}（${target?.route ?? '?'}）请求：${reasonText}。`
    + `${admission.detail ? `详情：${admission.detail}。` : ''}`
    + `未向厂商发出任何字节。修好节点后访问 ${cfg.controlBaseUrl}/recheck 复检，或 ${cfg.controlBaseUrl}/reset 复位。`,
  )
  error.name = 'GeminiGuardError'
  error.code = 'INVALID_CONFIG'
  error.guard = { target: targetId, reason: admission.reason, detail: admission.detail ?? '' }
  return error
}
