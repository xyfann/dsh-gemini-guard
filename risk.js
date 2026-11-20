// Pre-flight risk assessment and upstream error classification.
//
// The point of this module is to answer "would using this exit right now look
// suspicious?" *before* a request is written, and "what did the vendor just tell
// us?" as soon as a response comes back. Everything here is provider-neutral.

export class ExitHistory {
  constructor(windowMs) {
    this.windowMs = windowMs
    this.entries = []
  }

  record(ip, at = Date.now()) {
    if (!ip) return
    this.entries.push({ ip, at })
    this.#prune(at)
  }

  #prune(now) {
    const cutoff = now - this.windowMs
    if (this.entries.length > 0 && this.entries[0].at >= cutoff) return
    this.entries = this.entries.filter((entry) => entry.at >= cutoff)
  }

  distinct(now = Date.now()) {
    this.#prune(now)
    return new Set(this.entries.map((entry) => entry.ip)).size
  }

  recent(now = Date.now()) {
    this.#prune(now)
    return this.entries.slice(-20)
  }
}

function modeAllowsBlock(mode) {
  return mode === 'block'
}

/**
 * Judge the shared exit against the risk signals we can actually observe.
 * Country allow-listing is per target, so it is evaluated by the caller.
 */
export function assessEgress(cfg, probe, history, now = Date.now()) {
  const reasons = []
  const block = (code, detail) => reasons.push({ code, severity: 'block', detail })
  const warn = (code, detail) => reasons.push({ code, severity: 'warn', detail })

  if (!probe || probe.ok !== true) {
    block(probe?.reason ?? 'probe-missing', probe?.detail ?? '出口尚未探测')
    return { blocked: true, reasons }
  }

  if (probe.hosting === true) {
    const detail = `出口属于机房/云主机段（ASN ${probe.asn || '未知'}），部分厂商会因此拒绝或降权`
    if (modeAllowsBlock(cfg.egress.rejectHosting)) block('hosting-exit', detail)
    else if (cfg.egress.rejectHosting === 'warn') warn('hosting-exit', detail)
  }

  if (probe.proxyFlag === true) {
    const detail = '出口 IP 被公开情报标记为代理/VPN'
    if (modeAllowsBlock(cfg.egress.rejectProxyFlag)) block('proxy-flagged-exit', detail)
    else if (cfg.egress.rejectProxyFlag === 'warn') warn('proxy-flagged-exit', detail)
  }

  if (probe.timeZone && cfg.environment.timeZone && probe.timeZone !== cfg.environment.timeZone) {
    const detail = `出口时区 ${probe.timeZone} 与本机声明时区 ${cfg.environment.timeZone} 不一致`
    if (modeAllowsBlock(cfg.egress.timeZoneConsistency)) block('timezone-mismatch', detail)
    else if (cfg.egress.timeZoneConsistency === 'warn') warn('timezone-mismatch', detail)
  }

  if (cfg.egress.requireStableExit) {
    const distinct = history.distinct(now)
    if (distinct > cfg.egress.maxDistinctExitIps) {
      block(
        'exit-ip-flapping',
        `${Math.round(cfg.egress.stabilityWindowMs / 60000)} 分钟内出现 ${distinct} 个不同出口 IP（上限 ${cfg.egress.maxDistinctExitIps}）`,
      )
    }
  }

  if (probe.latencyMs > cfg.egress.maxLatencyMs) {
    warn('slow-exit', `出口探测延迟 ${probe.latencyMs} ms，超过 ${cfg.egress.maxLatencyMs} ms`)
  }

  if (probe.countryCode === '' || probe.timeZone === '') {
    warn('geo-incomplete', '地理信息不完整，无法交叉核对出口身份')
  }

  return { blocked: reasons.some((reason) => reason.severity === 'block'), reasons }
}

const GEO_PATTERNS = [
  /user location is not supported/i,
  /location is not supported/i,
  /not available in your (region|country|location)/i,
  /unsupported[_ ]country/i,
  /region is not supported/i,
  /country[,_ ]not[,_ ]supported/i,
  /country,? region,? or territory not supported/i,
  /not supported in your (country|region|territory)/i,
  /not available in (this|your) (country|region)/i,
]

const AUTH_PATTERNS = [
  /api key not valid/i,
  /api_key_invalid/i,
  /invalid[_ ]api[_ ]key/i,
  /incorrect api key/i,
  /invalid x-api-key/i,
  /authentication_error/i,
  /unauthorized/i,
  /permission_denied/i,
  /invalid bearer/i,
]

const QUOTA_PATTERNS = [
  /insufficient_quota/i,
  /exceeded your current quota/i,
  /billing_hard_limit/i,
  /quota exceeded/i,
  /credit balance is too low/i,
]

const RATE_PATTERNS = [
  /rate[_ ]limit/i,
  /too many requests/i,
  /resource_exhausted/i,
  /requests per (minute|day)/i,
  /try again later/i,
]

const OVERLOADED_PATTERNS = [/overloaded/i, /server[_ ]overloaded/i, /capacity/i]

function matches(patterns, text) {
  return patterns.some((pattern) => pattern.test(text))
}

/**
 * Map one upstream failure to a guard action. Order matters: a region refusal
 * arrives as 400 or 403 and must never be mistaken for a bad request, which is
 * the exact bug other tools hit before they separated the two.
 */
export function classifyUpstreamError(status, text, headers = {}) {
  const retryAfterMs = parseRetryAfter(headers['retry-after'])

  if (matches(GEO_PATTERNS, text)) {
    return { kind: 'geo', detail: text.slice(0, 240), retryAfterMs }
  }
  if (matches(QUOTA_PATTERNS, text)) {
    return { kind: 'quota', detail: text.slice(0, 240), retryAfterMs }
  }
  if (status === 429 || matches(RATE_PATTERNS, text)) {
    return { kind: 'rate-limit', detail: text.slice(0, 240), retryAfterMs }
  }
  if (matches(OVERLOADED_PATTERNS, text)) {
    return { kind: 'overloaded', detail: text.slice(0, 240), retryAfterMs }
  }
  if (status === 401 || status === 403 || matches(AUTH_PATTERNS, text)) {
    return { kind: 'auth', detail: text.slice(0, 240), retryAfterMs }
  }
  if (status >= 500) {
    return { kind: 'server', detail: text.slice(0, 240), retryAfterMs }
  }
  if (status === 0) {
    return { kind: 'transport', detail: text.slice(0, 240), retryAfterMs }
  }
  return { kind: 'client', detail: text.slice(0, 240), retryAfterMs }
}

function parseRetryAfter(value) {
  if (typeof value !== 'string' || value === '') return 0
  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 3600000)
  const date = Date.parse(value)
  if (Number.isFinite(date)) return Math.max(0, Math.min(date - Date.now(), 3600000))
  return 0
}
