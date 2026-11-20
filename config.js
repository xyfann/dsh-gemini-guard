// Configuration for dsh-gemini-guard.
//
// One egress identity, many vendor targets. The egress block owns everything
// about "where do requests leave from and is that safe"; each target owns
// "which vendor is this, where does it live, and what headers does it need".
// Unknown keys are rejected: a typo in a guard setting is a safety bug.

const SEVERITY_MODES = ['off', 'warn', 'block']

const TARGET_DEFAULTS = {
  gemini: {
    enabled: true,
    route: 'google',
    displayName: 'Google AI Studio',
    apiKeyRef: 'GOOGLE_AI_STUDIO_API_KEY',
    transport: 'relay',
    pathPrefix: '/gemini',
    upstreamHost: 'generativelanguage.googleapis.com',
    upstreamPort: 443,
    upstreamBasePath: '/v1beta',
    allowedCountries: null,
    manageProviderRoute: true,
    headers: {
      userAgent: 'google-genai-sdk/1.16.0 gl-node/{node}',
      acceptLanguage: 'en-US,en;q=0.9',
      apiClientHeader: 'x-goog-api-client',
      apiClient: 'gl-node/22.14.0',
      forwardHeaders: ['x-goog-api-key'],
    },
  },
  openai: {
    enabled: false,
    route: 'openai',
    displayName: 'OpenAI',
    apiKeyRef: 'OPENAI_API_KEY',
    transport: 'relay',
    pathPrefix: '/openai',
    upstreamHost: 'api.openai.com',
    upstreamPort: 443,
    upstreamBasePath: '/v1',
    allowedCountries: null,
    manageProviderRoute: true,
    headers: {
      userAgent: 'openai-node/5.9.0',
      acceptLanguage: 'en-US,en;q=0.9',
      apiClientHeader: '',
      apiClient: '',
      forwardHeaders: ['openai-organization', 'openai-project', 'openai-beta', 'cookie'],
    },
  },
  anthropic: {
    enabled: false,
    route: 'anthropic',
    displayName: 'Anthropic',
    apiKeyRef: 'ANTHROPIC_API_KEY',
    transport: 'relay',
    pathPrefix: '/anthropic',
    upstreamHost: 'api.anthropic.com',
    upstreamPort: 443,
    upstreamBasePath: '',
    allowedCountries: null,
    manageProviderRoute: true,
    headers: {
      userAgent: 'anthropic-typescript/0.60.0',
      acceptLanguage: 'en-US,en;q=0.9',
      apiClientHeader: '',
      apiClient: '',
      forwardHeaders: ['x-api-key', 'anthropic-version', 'anthropic-beta'],
    },
  },
  grok: {
    enabled: false,
    route: 'xai',
    displayName: 'xAI Grok',
    apiKeyRef: 'XAI_API_KEY',
    transport: 'relay',
    pathPrefix: '/grok',
    upstreamHost: 'api.x.ai',
    upstreamPort: 443,
    upstreamBasePath: '/v1',
    allowedCountries: null,
    manageProviderRoute: true,
    headers: {
      userAgent: 'xai-sdk-node/1.2.0',
      acceptLanguage: 'en-US,en;q=0.9',
      apiClientHeader: '',
      apiClient: '',
      forwardHeaders: ['x-api-key'],
    },
  },
}

export const DEFAULTS = {
  enabled: true,

  // One switch per subsystem, so a cost or a preference can be turned off
  // without editing code or losing the rest of the guard.
  features: {
    // Geo + TLS probe of the shared exit. Off means no pre-flight proof at all:
    // country rules stop being enforceable and status reports `unverified`.
    egressProbe: true,
    // Per-vendor TLS reachability check inside each probe.
    reachabilityProbe: true,
    // Datacenter / proxy-flag / timezone / IP-flapping / latency rules.
    riskRules: true,
    // Rewrite the client fingerprint (User-Agent, Accept-Language, client id).
    headerNormalize: true,
    // Inject the environment block and rewrite the prompt timezone.
    promptContext: true,
    // Queue bursts instead of letting them hit the vendor together.
    burstLimit: true,
    // Treat a stream that ends without a terminator as a dropped connection.
    streamWatch: true,
    // Point the provider routes at this relay on activation.
    autoRoute: true,
    // When a split tunnel rewrites the vendor's DNS, the third-party
    // geolocation probe measures a different path. In that case stop gating on
    // that measurement and let the vendor's own refusal decide.
    pathAware: true,
  },

  listenHost: '127.0.0.1',
  listenPort: 8799,

  egress: {
    proxy: '',
    allowedCountries: ['TW'],
    geoUrl: 'http://ip-api.com/json/?fields=status,country,countryCode,regionName,city,timezone,isp,org,as,query,proxy,hosting,mobile',
    ttlMs: 90000,
    timeoutMs: 8000,
    // Identical exit IPs required before the exit is treated as confirmed.
    confirmations: 1,
    // Flapping detection: more distinct exit IPs than this inside the window
    // means the "residential-looking" story is gone.
    requireStableExit: true,
    stabilityWindowMs: 3600000,
    maxDistinctExitIps: 2,
    // Datacenter exits are common for VPN nodes; some vendors refuse them.
    rejectHosting: 'warn',
    rejectProxyFlag: 'warn',
    // The prompt-side environment facts name a time zone; a node in another zone
    // makes the story inconsistent even though no API reads the prompt.
    timeZoneConsistency: 'warn',
    maxLatencyMs: 1200,
  },

  breaker: {
    failureThreshold: 3,
    cooldownMs: 120000,
    hardStopCooldownMs: 3600000,
    hardStop: true,
  },

  environment: {
    region: 'TW',
    timeZone: 'Asia/Taipei',
    locale: 'en-US',
    device: 'Windows 11 (x64)',
    // Follow the probed exit instead of the literal values above, so one
    // configuration works for users in any region.
    followExit: false,
    injectContext: true,
    contextOrder: 680,
    rewriteTimeZone: true,
    sourceTimeZone: 'Asia/Shanghai',
  },

  connectTimeoutMs: 8000,
  tlsTimeoutMs: 8000,
  requestTimeoutMs: 900000,
  // How long to wait for upstream *response headers* before giving up. Separate
  // from requestTimeoutMs because a vendor that accepts the request and then
  // queues it is indistinguishable from a hang, and retrying it silently is the
  // worst outcome.
  firstByteTimeoutMs: 90000,
  maxRequestBytes: 33554432,

  // Burst shaping: subagents and workflows can fire many calls at once, which is
  // itself a suspicious pattern. Calls are queued, never rejected.
  limits: {
    maxConcurrentPerTarget: 4,
    queueTimeoutMs: 60000,
  },

  verbose: false,
  logFile: '',

  targets: TARGET_DEFAULTS,
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function mergeDefaults(defaults, raw, path, problems) {
  if (raw === undefined || raw === null) return structuredClone(defaults)
  if (!isPlainObject(raw)) {
    problems.push(`${path.slice(0, -1)} 必须是对象`)
    return structuredClone(defaults)
  }
  const out = structuredClone(defaults)
  for (const [key, value] of Object.entries(raw)) {
    // A schema may materialize keys with `undefined`; those mean "not set".
    if (value === undefined) continue
    if (!(key in defaults)) {
      problems.push(`未知配置项 ${path}${key}`)
      continue
    }
    const fallback = defaults[key]
    if (isPlainObject(fallback)) {
      out[key] = mergeDefaults(fallback, value, `${path}${key}.`, problems)
      continue
    }
    out[key] = value
  }
  return out
}

function str(value, name, problems, { allowEmpty = false } = {}) {
  if (typeof value !== 'string') {
    problems.push(`${name} 必须是字符串`)
    return ''
  }
  if (!allowEmpty && value.trim() === '') problems.push(`${name} 不能为空`)
  return value
}

function int(value, name, problems, min, max) {
  if (!Number.isInteger(value) || value < min || value > max) {
    problems.push(`${name} 必须是 ${min}~${max} 的整数`)
    return min
  }
  return value
}

function bool(value, name, problems) {
  if (typeof value !== 'boolean') {
    problems.push(`${name} 必须是 true 或 false`)
    return false
  }
  return value
}

function mode(value, name, problems) {
  if (!SEVERITY_MODES.includes(value)) {
    problems.push(`${name} 只能是 ${SEVERITY_MODES.join(' / ')}`)
    return 'warn'
  }
  return value
}

function countryList(value, name, problems) {
  if (value === null) return null
  if (!Array.isArray(value)) {
    problems.push(`${name} 必须是国家/地区代码数组或 null`)
    return []
  }
  return value
    .map((code) => String(code).trim().toUpperCase())
    .filter((code) => {
      if (code === '') return false
      if (!/^[A-Z]{2}$/.test(code)) {
        problems.push(`${name} 含非法代码 ${code}`)
        return false
      }
      return true
    })
}

function resolveTarget(id, cfg, problems) {
  const target = cfg
  const base = `targets.${id}.`
  target.enabled = bool(target.enabled, `${base}enabled`, problems)
  target.route = str(target.route, `${base}route`, problems).trim()
  target.displayName = str(target.displayName, `${base}displayName`, problems)
  target.apiKeyRef = str(target.apiKeyRef, `${base}apiKeyRef`, problems).trim()
  target.transport = target.transport === 'relay' || target.transport === 'direct'
    ? target.transport
    : (problems.push(`${base}transport 只能是 relay 或 direct`), 'relay')
  target.pathPrefix = str(target.pathPrefix, `${base}pathPrefix`, problems)
  if (!target.pathPrefix.startsWith('/')) target.pathPrefix = `/${target.pathPrefix}`
  target.pathPrefix = target.pathPrefix.replace(/\/+$/, '')
  target.upstreamHost = str(target.upstreamHost, `${base}upstreamHost`, problems).trim()
  target.upstreamPort = int(target.upstreamPort, `${base}upstreamPort`, problems, 1, 65535)
  target.upstreamBasePath = str(target.upstreamBasePath, `${base}upstreamBasePath`, problems, { allowEmpty: true }).trim()
  if (target.upstreamBasePath !== '' && !target.upstreamBasePath.startsWith('/')) {
    target.upstreamBasePath = `/${target.upstreamBasePath}`
  }
  target.allowedCountries = countryList(target.allowedCountries, `${base}allowedCountries`, problems)
  target.manageProviderRoute = bool(target.manageProviderRoute, `${base}manageProviderRoute`, problems)
  target.headers.userAgent = str(target.headers.userAgent, `${base}headers.userAgent`, problems)
    .replace(/\{node\}/g, process.versions.node ?? 'unknown')
  target.headers.acceptLanguage = str(target.headers.acceptLanguage, `${base}headers.acceptLanguage`, problems)
  target.headers.apiClientHeader = str(target.headers.apiClientHeader, `${base}headers.apiClientHeader`, problems, { allowEmpty: true })
  target.headers.apiClient = str(target.headers.apiClient, `${base}headers.apiClient`, problems, { allowEmpty: true })
  if (!Array.isArray(target.headers.forwardHeaders)) {
    problems.push(`${base}headers.forwardHeaders 必须是字符串数组`)
    target.headers.forwardHeaders = []
  } else {
    target.headers.forwardHeaders = target.headers.forwardHeaders.map((name) => String(name).toLowerCase())
  }
  // An empty list almost always means "a config schema materialised its array
  // default", not "forward nothing". Dropping the vendor's auth header turns
  // every request into an anonymous one, which vendors answer with a permission
  // error that looks like a key problem. Fall back to the vendor default.
  if (target.headers.forwardHeaders.length === 0) {
    target.headers.forwardHeaders = [...(TARGET_DEFAULTS[id]?.headers.forwardHeaders ?? [])]
  }
  return target
}

export function resolveConfig(raw, { harnessHome } = {}) {
  const problems = []
  const cfg = mergeDefaults(DEFAULTS, raw ?? {}, '', problems)

  cfg.enabled = bool(cfg.enabled, 'enabled', problems)
  cfg.verbose = bool(cfg.verbose, 'verbose', problems)
  for (const key of Object.keys(DEFAULTS.features)) {
    cfg.features[key] = bool(cfg.features[key], `features.${key}`, problems)
  }
  cfg.listenHost = str(cfg.listenHost, 'listenHost', problems)
  cfg.listenPort = int(cfg.listenPort, 'listenPort', problems, 1, 65535)

  cfg.egress.proxy = str(cfg.egress.proxy, 'egress.proxy', problems, { allowEmpty: true }).trim()
  cfg.egress.allowedCountries = countryList(cfg.egress.allowedCountries, 'egress.allowedCountries', problems) ?? []
  cfg.egress.geoUrl = str(cfg.egress.geoUrl, 'egress.geoUrl', problems)
  cfg.egress.ttlMs = int(cfg.egress.ttlMs, 'egress.ttlMs', problems, 1000, 3600000)
  cfg.egress.timeoutMs = int(cfg.egress.timeoutMs, 'egress.timeoutMs', problems, 500, 120000)
  cfg.egress.confirmations = int(cfg.egress.confirmations, 'egress.confirmations', problems, 1, 10)
  cfg.egress.requireStableExit = bool(cfg.egress.requireStableExit, 'egress.requireStableExit', problems)
  cfg.egress.stabilityWindowMs = int(cfg.egress.stabilityWindowMs, 'egress.stabilityWindowMs', problems, 60000, 86400000)
  cfg.egress.maxDistinctExitIps = int(cfg.egress.maxDistinctExitIps, 'egress.maxDistinctExitIps', problems, 1, 50)
  cfg.egress.rejectHosting = mode(cfg.egress.rejectHosting, 'egress.rejectHosting', problems)
  cfg.egress.rejectProxyFlag = mode(cfg.egress.rejectProxyFlag, 'egress.rejectProxyFlag', problems)
  cfg.egress.timeZoneConsistency = mode(cfg.egress.timeZoneConsistency, 'egress.timeZoneConsistency', problems)
  cfg.egress.maxLatencyMs = int(cfg.egress.maxLatencyMs, 'egress.maxLatencyMs', problems, 50, 60000)

  cfg.breaker.failureThreshold = int(cfg.breaker.failureThreshold, 'breaker.failureThreshold', problems, 1, 100)
  cfg.breaker.cooldownMs = int(cfg.breaker.cooldownMs, 'breaker.cooldownMs', problems, 1000, 86400000)
  cfg.breaker.hardStopCooldownMs = int(cfg.breaker.hardStopCooldownMs, 'breaker.hardStopCooldownMs', problems, 1000, 604800000)
  cfg.breaker.hardStop = bool(cfg.breaker.hardStop, 'breaker.hardStop', problems)

  cfg.environment.region = str(cfg.environment.region, 'environment.region', problems)
  cfg.environment.timeZone = str(cfg.environment.timeZone, 'environment.timeZone', problems)
  cfg.environment.locale = str(cfg.environment.locale, 'environment.locale', problems)
  cfg.environment.device = str(cfg.environment.device, 'environment.device', problems)
  cfg.environment.followExit = bool(cfg.environment.followExit, 'environment.followExit', problems)
  cfg.environment.injectContext = bool(cfg.environment.injectContext, 'environment.injectContext', problems)
  cfg.environment.contextOrder = int(cfg.environment.contextOrder, 'environment.contextOrder', problems, -1000000, 1000000)
  cfg.environment.rewriteTimeZone = bool(cfg.environment.rewriteTimeZone, 'environment.rewriteTimeZone', problems)
  cfg.environment.sourceTimeZone = str(cfg.environment.sourceTimeZone, 'environment.sourceTimeZone', problems, { allowEmpty: true })

  cfg.connectTimeoutMs = int(cfg.connectTimeoutMs, 'connectTimeoutMs', problems, 200, 120000)
  cfg.tlsTimeoutMs = int(cfg.tlsTimeoutMs, 'tlsTimeoutMs', problems, 200, 120000)
  cfg.requestTimeoutMs = int(cfg.requestTimeoutMs, 'requestTimeoutMs', problems, 5000, 3600000)
  cfg.firstByteTimeoutMs = int(cfg.firstByteTimeoutMs, 'firstByteTimeoutMs', problems, 1000, 600000)
  cfg.maxRequestBytes = int(cfg.maxRequestBytes, 'maxRequestBytes', problems, 65536, 268435456)
  cfg.limits.maxConcurrentPerTarget = int(cfg.limits.maxConcurrentPerTarget, 'limits.maxConcurrentPerTarget', problems, 1, 64)
  cfg.limits.queueTimeoutMs = int(cfg.limits.queueTimeoutMs, 'limits.queueTimeoutMs', problems, 1000, 600000)
  cfg.logFile = str(cfg.logFile, 'logFile', problems, { allowEmpty: true }).trim()

  // Duplicate route/prefix checks only consider enabled targets: a disabled
  // target must not block a hand-declared replacement with the same route.
  const usedPrefixes = new Map()
  const usedRoutes = new Map()
  for (const [id, target] of Object.entries(cfg.targets)) {
    resolveTarget(id, target, problems)
    target.id = id
    if (!target.enabled) continue
    if (usedPrefixes.has(target.pathPrefix)) {
      problems.push(`targets.${id}.pathPrefix 与 ${usedPrefixes.get(target.pathPrefix)} 重复：${target.pathPrefix}`)
    }
    usedPrefixes.set(target.pathPrefix, id)
    if (usedRoutes.has(target.route)) {
      problems.push(`targets.${id}.route 与 ${usedRoutes.get(target.route)} 重复：${target.route}`)
    }
    usedRoutes.set(target.route, id)
  }

  for (const target of Object.values(cfg.targets)) {
    if (target.transport === 'relay') {
      target.relayBaseUrl = `http://${cfg.listenHost}:${cfg.listenPort}${target.pathPrefix}${target.upstreamBasePath}`
    } else {
      target.relayBaseUrl = null
    }
  }

  if (problems.length > 0) {
    throw new Error(`dsh-gemini-guard 配置有 ${problems.length} 处问题：${problems.join('；')}`)
  }

  const home = harnessHome || process.env.DSH_HOME || ''
  if (cfg.logFile === '' && home !== '') {
    const sep = process.platform === 'win32' ? '\\' : '/'
    cfg.logFile = `${home.replace(/[\\/]+$/, '')}${sep}logs${sep}gemini-guard.log`
  }

  cfg.controlBaseUrl = `http://${cfg.listenHost}:${cfg.listenPort}/_gemini-guard`
  cfg.enabledTargets = Object.values(cfg.targets).filter((target) => target.enabled)
  return cfg
}

export function targetForRoute(cfg, route) {
  return cfg.enabledTargets.find((target) => target.route === route) ?? null
}

export function countryListFor(cfg, target) {
  return target.allowedCountries === null ? cfg.egress.allowedCountries : target.allowedCountries
}
