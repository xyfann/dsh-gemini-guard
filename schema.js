// Cordis `Config` schema — the surface the Plugins/Settings page renders.
//
// Two constraints shaped this file:
//
// 1. `@deepseek-ai/schemastery` only resolves when this package is installed as
//    a normal dependency (profile node_modules). A locally *linked* bundle
//    resolves from its own real path, where that package is absent. So the
//    import is dynamic and failure is not an error: `Config` becomes undefined,
//    the row keeps working, and configuration stays in the panel + YAML.
// 2. The schema is the *form*, not the authority. `resolveConfig()` in
//    config.js still validates semantics (ranges, duplicate routes, cross-field
//    rules) and throws one readable error listing every problem. Defaults here
//    come from that module so the two can never drift.
import { DEFAULTS } from './config.js'

let Schema = null
try {
  const loaded = await import('@deepseek-ai/schemastery')
  Schema = loaded?.default ?? loaded?.Schema ?? null
} catch {
  Schema = null
}

function buildSchema(Schema) {
  const { egress, environment, limits, breaker, features } = DEFAULTS

  const TargetSchema = Schema.object({
    enabled: Schema.boolean()
      .default(false)
      .description('接管这个厂商的路由。默认只开 gemini。'),
    route: Schema.string().description('pi-ai 路由名：google / openai / anthropic / xai，或自建路由名。'),
    displayName: Schema.string().description('选择器里显示的名字。'),
    apiKeyRef: Schema.string().description('凭据引用名，值存在本地凭据库，不写进配置。'),
    transport: Schema.union(['relay', 'direct'])
      .description('relay：请求经本机中继（强约束）；direct：保留原 baseURL，只靠钩子判定（较松）。'),
    pathPrefix: Schema.string().description('中继路径前缀，例如 /gemini。'),
    upstreamHost: Schema.string().description('厂商域名。'),
    upstreamPort: Schema.number().description('厂商端口，HTTPS 为 443。'),
    upstreamBasePath: Schema.string().description('拼在中继前缀后的版本段：/v1beta、/v1，或留空。'),
    allowedCountries: Schema.any().description('null 表示继承 egress.allowedCountries；数组表示单独清单。'),
    manageProviderRoute: Schema.boolean().description('是否允许插件把该路由的 baseURL 指向中继。'),
    headers: Schema.object({
      userAgent: Schema.string().description('统一后的 User-Agent；{node} 会替换成真实 Node 版本。'),
      acceptLanguage: Schema.string().description('统一后的 Accept-Language。'),
      apiClientHeader: Schema.string().description('客户端标识头名，例如 x-goog-api-client；留空则不发送。'),
      apiClient: Schema.string().description('客户端标识头的值。'),
      forwardHeaders: Schema.array(Schema.string()).description('除 content-type/accept/authorization 外需要原样转发的头。'),
    }).description('每个厂商的客户端指纹与透传头。'),
  }).description('一个厂商目标。')

  return Schema.object({
    enabled: Schema.boolean()
      .default(true)
      .description('总开关。关掉后所有受管请求在本地被拒绝，不会发出任何流量。'),

    features: Schema.object({
      egressProbe: Schema.boolean().default(features.egressProbe)
        .description('出口探测（地理归属 + TLS 可达）。关掉后地区白名单无法强制执行，状态显示 unverified。'),
      reachabilityProbe: Schema.boolean().default(features.reachabilityProbe)
        .description('探测时对每个上游各做一次 TLS 握手。'),
      riskRules: Schema.boolean().default(features.riskRules)
        .description('机房段 / 代理标记 / 时区 / IP 跳动 / 延迟规则。关掉后只保留地区白名单。'),
      headerNormalize: Schema.boolean().default(features.headerNormalize)
        .description('统一客户端指纹（User-Agent / Accept-Language / 客户端标识头）。'),
      promptContext: Schema.boolean().default(features.promptContext)
        .description('注入本机环境事实并改写提示词时区。改动需重启生效。'),
      burstLimit: Schema.boolean().default(features.burstLimit)
        .description('按厂商排队，压掉并发突发。'),
      streamWatch: Schema.boolean().default(features.streamWatch)
        .description('流没有终止标记时判为中断（计入稳定性）。'),
      autoRoute: Schema.boolean().default(features.autoRoute)
        .description('启动时把 provider 路由指向中继。改动需重启生效。'),
      pathAware: Schema.boolean().default(features.pathAware)
        .description('域名分流（智能分流）环境下，厂商域名解析到假 IP 时，第三方地理探测不代表真实路径；开启后地区判定改由厂商回包决定。'),
    }).description('逐项功能开关。'),

    egress: Schema.object({
      proxy: Schema.string().default(egress.proxy)
        .description('可选上游 HTTP(S) 代理，例如 http://127.0.0.1:7890。留空表示走系统路由（TUN 模式）。'),
      allowedCountries: Schema.array(Schema.string()).default(egress.allowedCountries)
        .description('允许的出口国家/地区代码；空数组表示只校验可达性、不校验国家。'),
      geoUrl: Schema.string().default(egress.geoUrl)
        .description('出口地理信息来源，可换成自建服务。'),
      ttlMs: Schema.number().default(egress.ttlMs)
        .description('探测缓存时长（毫秒）。越小越安全，越大越省事。'),
      timeoutMs: Schema.number().default(egress.timeoutMs)
        .description('探测请求超时（毫秒）。'),
      confirmations: Schema.number().default(egress.confirmations)
        .description('同一出口 IP 需要连续几次探测一致才放行。'),
      requireStableExit: Schema.boolean().default(egress.requireStableExit)
        .description('是否启用出口 IP 跳动检测。'),
      stabilityWindowMs: Schema.number().default(egress.stabilityWindowMs)
        .description('跳动检测的时间窗口（毫秒）。'),
      maxDistinctExitIps: Schema.number().default(egress.maxDistinctExitIps)
        .description('窗口内允许出现的不同出口 IP 数。'),
      rejectHosting: Schema.union(['off', 'warn', 'block']).default(egress.rejectHosting)
        .description('出口属于机房/云主机段时的处置。'),
      rejectProxyFlag: Schema.union(['off', 'warn', 'block']).default(egress.rejectProxyFlag)
        .description('出口被公开情报标记为代理时的处置。'),
      timeZoneConsistency: Schema.union(['off', 'warn', 'block']).default(egress.timeZoneConsistency)
        .description('出口时区与本机声明时区不一致时的处置。'),
      maxLatencyMs: Schema.number().default(egress.maxLatencyMs)
        .description('出口探测延迟超过此值只告警。'),
    }).description('共享出口策略。'),

    environment: Schema.object({
      region: Schema.string().default(environment.region).description('声明的账号地区。'),
      timeZone: Schema.string().default(environment.timeZone).description('声明的时区。'),
      locale: Schema.string().default(environment.locale).description('声明的语言。'),
      device: Schema.string().default(environment.device).description('声明的设备。'),
      followExit: Schema.boolean().default(environment.followExit)
        .description('地区与时区改为跟随探测到的出口，一套配置可给任何地区的用户用。'),
      injectContext: Schema.boolean().default(environment.injectContext)
        .description('是否向模型注入本机环境事实。'),
      contextOrder: Schema.number().default(environment.contextOrder)
        .description('注入块在运行时上下文中的排序位。'),
      rewriteTimeZone: Schema.boolean().default(environment.rewriteTimeZone)
        .description('是否把提示词里的旧时区改写为声明时区。'),
      sourceTimeZone: Schema.string().default(environment.sourceTimeZone)
        .description('需要被改写的源时区，例如 Asia/Shanghai。'),
    }).description('提示词侧的环境事实。'),

    limits: Schema.object({
      maxConcurrentPerTarget: Schema.number().default(limits.maxConcurrentPerTarget)
        .description('每个厂商同时进行的上游请求数；多出的排队而不是拒绝。'),
      queueTimeoutMs: Schema.number().default(limits.queueTimeoutMs)
        .description('排队超时（毫秒），超时返回本地 503。'),
    }).description('并发整形。'),

    breaker: Schema.object({
      failureThreshold: Schema.number().default(breaker.failureThreshold)
        .description('连续传输类异常多少次打开熔断。'),
      cooldownMs: Schema.number().default(breaker.cooldownMs)
        .description('普通熔断冷却（毫秒）。'),
      hardStopCooldownMs: Schema.number().default(breaker.hardStopCooldownMs)
        .description('硬停冷却（毫秒），地区被拒时使用。'),
      hardStop: Schema.boolean().default(breaker.hardStop)
        .description('地区被拒是否闩死到人工复位。'),
      modelCooldownMs: Schema.number().default(breaker.modelCooldownMs)
        .description('单个型号高负载时的冷却（毫秒）。只影响该型号，同路由的其它型号照常可用。'),
    }).description('熔断器。'),

    listenHost: Schema.string().default(DEFAULTS.listenHost)
      .description('中继监听地址，默认只绑回环。'),
    listenPort: Schema.number().default(DEFAULTS.listenPort)
      .description('中继监听端口。'),
    connectTimeoutMs: Schema.number().default(DEFAULTS.connectTimeoutMs)
      .description('出口连接超时（毫秒）。'),
    tlsTimeoutMs: Schema.number().default(DEFAULTS.tlsTimeoutMs)
      .description('TLS 握手超时（毫秒）。'),
    requestTimeoutMs: Schema.number().default(DEFAULTS.requestTimeoutMs)
      .description('单请求上限（毫秒），长生成用。'),
    firstByteTimeoutMs: Schema.number().default(DEFAULTS.firstByteTimeoutMs)
      .description('等待上游响应头的上限（毫秒）。超时本地 504 并明确告知厂商排队，避免静默重试。'),
    maxRequestBytes: Schema.number().default(DEFAULTS.maxRequestBytes)
      .description('请求体上限（字节）。'),
    logFile: Schema.string().default(DEFAULTS.logFile)
      .description('日志文件路径；留空表示 <DSH_HOME>/logs/gemini-guard.log。'),
    verbose: Schema.boolean().default(DEFAULTS.verbose)
      .description('同时打印到控制台。'),
    targets: Schema.dict(TargetSchema).default(DEFAULTS.targets)
      .description('厂商目标表。加第五家厂商就在这里的加一段，不需要改代码。'),
  }).description('模型出口闸门：给按来源 IP 判定地区的大模型路由加一层失败即拒的出口闸门。')
}

export const Config = Schema === null ? undefined : buildSchema(Schema)
