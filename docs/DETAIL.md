# 模型出口闸门（dsh-gemini-guard）

## 它解决什么

Gemini / OpenAI / Anthropic / xAI 这些厂商的开发者 API，都按**请求来源的公网 IP** 决定是否提供服务。不在支持地区时典型响应：

```
400 FAILED_PRECONDITION  User location is not supported for the API use.   (Gemini)
403                      Country, region, or territory not supported        (OpenAI)
```

这条判定的输入是连接源 IP，不是 User-Agent、不是 Accept-Language、不是时区、也不是任何自定义头。客户端做不到“让请求看起来来自别的地方”。能做的只有四件事，本插件只做这四件事：

1. **只在出口正确时放行**：每次模型调用前，用同一条出口路径做“隧道 + TLS + 出口 IP 归属”校验，校验不过就本地拒绝，一个字节都不发给厂商。
2. **提前判断风险，而不是等出错**：出口身份要过一遍体检（地区、机房段、代理标记、时区一致性、IP 稳定性、延迟），不合格的组合在请求发出前就被拦下。
3. **出口一抖就停**：连接失败、流中途断开、地区被拒、鉴权被拒、限流/配额，都按语义分别处理——该冷却的冷却、该硬停的硬停，不再向厂商制造“同一把 key 从多个国家/多个 IP 冒出来”的噪声。
4. **保持指纹一致**：同一个 key 在厂商眼里始终是同一个客户端（固定的 User-Agent / Accept-Language / 客户端标识头，只转发厂商真正需要的头），并且提示词里的时区、地区、语言与本机出口地区不互相矛盾。

顺带解决“节点没准备好时误用”：闸门在**发出请求之前**判定，节点没起来时你点发送，得到的是本地拦截提示，而不是一次会让厂商记账的可疑请求。

## 提前判断：出口体检与拦截规则

每次探测采集（默认来自 ip-api，可换成自建）：

| 观测 | 用途 |
|---|---|
| 出口 IP、国家码、省/市 | 地区放行判定 |
| 时区 | 与 `environment.timeZone` 交叉核对 |
| ISP / ASN | 判断是家宽还是机房段 |
| `hosting` / `proxy` 标记 | 公开情报是否已把该 IP 标为机房/代理 |
| 探测延迟 | 出口质量，抖动前兆 |
| 窗口内不同 IP 的数量 | **IP 跳动检测**（最关键的一项） |

判定动作，按 `severity` 分两档（`warn` 记录但放行，`block` 本地拒绝）：

| 规则 | 默认 | 说明 |
|---|---|---|
| 出口国家不在 `allowedCountries` | block（不可关） | 命中即硬停，冷却 1 小时，需人工复位 |
| 窗口内不同出口 IP 数 > `maxDistinctExitIps` | block | 默认 1 小时内超过 2 个出口 IP 即判定“节点在跳”，这正是风控最容易盯上的形态 |
| 出口机房段且 `rejectHosting: block` | warn（可改 block） | VPN 节点多为机房 IP，直接 block 会误伤；先告警，由你决定 |
| 出口被情报标记为代理且 `rejectProxyFlag: block` | warn | 同上 |
| 出口时区 ≠ 声明时区且 `timeZoneConsistency: block` | warn | 只影响叙述一致性，不影响厂商判定，默认不拦 |
| `confirmations > 1` 时出口未被连续确认 | block | 新 IP 需要连续 N 次探测一致才放行（默认 1，设 2 即“换节点后等第二眼”） |

**响应侧二次判断**（不求人，只看厂商自己说的话）：

| 厂商语义 | 处理 |
|---|---|
| 地区/国家不支持（400 或 403） | 归类 `geo` → 硬停，不进重试 |
| key 无效 / 鉴权失败（400/401/403） | 归类 `auth` → 该 target 熔断（默认非硬停） |
| 429 / rate limit | 归类 `rate-limit` → 按 `Retry-After` 冷却（下限 30 秒） |
| `insufficient_quota` / 配额耗尽 | 归类 `quota` → 冷却 10 分钟，不再烧钱 |
| `overloaded` / 5xx | 短暂冷却 / 仅记录 |
| 流以 200 结束但没有终止标记 | 归类 `late-abort` → 计入稳定性，连续 3 次开熔断 |

终止标记按厂商区分：`[DONE]`（OpenAI/xAI）、`message_stop`（Anthropic）、`finishReason`（Gemini）、`response.completed`（Responses）。

## 支持的厂商与接入差异

四个 target 都走同一套逻辑，差异只在参数：

| target | pi-ai 路由 | 上游 | 中继 baseURL | 需要原样转发的鉴权头 |
|---|---|---|---|---|
| `gemini` | `google` | `generativelanguage.googleapis.com` | `…/gemini/v1beta` | `x-goog-api-key` |
| `openai` | `openai` | `api.openai.com` | `…/openai/v1` | `authorization`、`openai-organization`、`openai-project`、`openai-beta` |
| `anthropic` | `anthropic` | `api.anthropic.com` | `…/anthropic`（版本段由 SDK 自己加） | `x-api-key`、`anthropic-version`、`anthropic-beta` |
| `grok` | `xai` | `api.x.ai` | `…/grok/v1` | `authorization`、`x-api-key` |

这四条都是 pi-ai 内置目录路由，所以**不写 `models` 就自动带该厂商的全部模型**。

想接第 5、6 个厂商（Mistral、DeepSeek、Groq、OpenRouter…）时，在 `targets` 里加一段即可；它们的 pi-ai 路由名与上游域名在 `@earendil-works/pi-ai/dist/providers/*.js` 里，`upstreamBasePath` 抄同一份 baseUrl 的路径部分。没有代码要改。

## 工作方式

```
DSH 会话
  └─ llm-pi-ai 适配器（每个 target 一条路由）
       ├─ llm/stream 瀑布 ─────────► 闸门判定：放行 / 抛错（本地，无网络）
       └─ HTTP ──► 本机中继 127.0.0.1:8799/<prefix>
                     ├─ 再次判定（出口体检 + 熔断 + 冷却）
                     ├─ 单条 TCP/TLS 出口（可经本地代理），不回落直连
                     └─ 统一头部 ──► 厂商
```

两层判定是故意的：`llm/stream` 能拦住绝大多数模型调用且零网络开销；中继是最后一道，凡是走裸 HTTP 的路径（模型发现、标题生成等辅助调用）都由它兜住。

## 使用

### 1. 存 API key

与其它 provider 一样走本地凭据存储，不要写进配置：

```yaml
# %DSH_HOME%\.credentials.yaml
GOOGLE_AI_STUDIO_API_KEY: AIza...
OPENAI_API_KEY: sk-...
ANTHROPIC_API_KEY: sk-ant-...
XAI_API_KEY: xai-...
```

引用名由各 target 的 `apiKeyRef` 决定。

### 2. 路由自动指向

插件启动时会把已启用且 `transport: relay` 的 target 对应的 provider 路由指到中继（只在原值为空或已指向中继时才写，绝不覆盖你自己填的地址）。例如启用 gemini + openai 后：

```yaml
- id: llm-pi-ai
  name: "@deepseek-ai/dsh-llm-pi-ai"
  config:
    providers:
      google:
        displayName: Google AI Studio
        apiKeyEnv: GOOGLE_AI_STUDIO_API_KEY
        baseURL: http://127.0.0.1:8799/gemini/v1beta
      openai:
        displayName: OpenAI
        apiKeyEnv: OPENAI_API_KEY
        baseURL: http://127.0.0.1:8799/openai/v1
```

自动写入被拒绝时（例如配置层优先级冲突），把对应段落手工贴进 `cordis.patch.yml`——注意同一 `id` 的 `config` 是整体替换，贴之前先备份。

### 3. 看状态、复检、复位

```
GET  /_gemini-guard/status              # 出口身份 + 每个 target 的熔断/冷却/计数 + 最近日志
POST /_gemini-guard/recheck             # 全部 target 立刻重新探测
POST /_gemini-guard/recheck?target=gemini
POST /_gemini-guard/reset               # 清全部熔断 + 重新探测
POST /_gemini-guard/reset?target=openai
```

`status` 关键字段：

| 字段 | 含义 |
|---|---|
| `egress.phase` | `probed` / `unprobed` |
| `egress.ip`、`countryCode`、`isp`、`asn` | 厂商实际看到的出口身份 |
| `egress.hosting`、`proxyFlag`、`timeZone` | 体检输入 |
| `egress.confirmations`、`distinctIpsInWindow`、`recentIps` | 稳定性证据 |
| `targets.<id>.breaker` | `closed` / `open` / `half-open`；`hard` 表示需人工复位 |
| `targets.<id>.upstreamCooldownUntil` | 限流/配额冷却到期时间 |
| `targets.<id>.counters` | `requests/admitted/blocked/geoRejections/authRejections/rateLimited/quotaHits/upstreamErrors/lateAborts` |

日志在 `<DSH_HOME>\logs\gemini-guard.log`（JSON 行）。

### 4. 控制面板与开关

浏览器打开 `http://127.0.0.1:8799/_gemini-guard/`（仅回环可访问）：

- 顶部：出口身份、ISP/ASN、时区、机房/代理标记、窗口内 IP 数、每个 target 的熔断状态
- 开关：插件总开关（kill switch）、允许出口国家、确认次数、IP 跳动检测与其阈值、机房/代理/时区的处置档位（忽略/告警/拦截）、每厂商最大并发、四个厂商各自的启用开关
- 功能开关：出口探测、每厂商可达性探测、风险规则、客户端指纹统一、提示词环境信息、并发整形、流中断检测、启动接管路由——逐项独立开关
- 按钮：复检出口、复位熔断、保存
- 底部：完整 status JSON

保存时先在本进程立即生效（`/_gemini-guard/settings`），再尝试写回 profile 该行的 `config`；写入成功面板会提示“已保存到 profile 配置”，没有可写入口时提示“已生效（本次运行）”。注意 `config` 的字段不是 volatile 的，写回会触发本插件重启（中继会短暂重绑），这是配置层的既有行为。

**设置页与面板的分工（两种安装形态）**

本插件导出 `Config` 模式（`schema.js`），但它是**双模式**的：

| 安装形态 | `@deepseek-ai/schemastery` 能否解析 | 结果 |
|---|---|---|
| 本地目录链接（Plugins → Add plugin 指向工作区目录） | 否（解析从包的真实路径开始，那里没有该依赖） | `Config` 为 `undefined`，设置页只有原始配置；开关走 `/_gemini-guard/` 面板 |
| 作为 profile 依赖安装（`pnpm add` / 发布到 registry 后安装） | 是 | `Config` 是一个 schema，设置页渲染出完整表单：总开关、8 个功能开关、出口策略、环境事实、并发、熔断、四个厂商目标（`targets` 字典，新增厂商直接加一段） |

两种形态共用同一份默认值（`config.js` 的 `DEFAULTS`），所以表单里看到的默认值和运行时一致；`resolveConfig()` 仍然是语义校验的权威，范围/重复路由/跨字段规则由它统一报错。

## 配置项

### 顶层

| 字段 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 关掉后所有受管请求本地拒绝（仍然不发出流量） |

### `features`（功能开关，面板里逐项可切）

| 开关 | 默认 | 关掉之后 |
|---|---|---|
| `egressProbe` | 开 | 不再做地理/TLS 探测，地区白名单无法强制执行，`status.egress.phase` 变为 `unverified`，请求直接放行 |
| `reachabilityProbe` | 开 | 探测时不再对每个厂商做一次 TLS 握手（保留地理探测） |
| `riskRules` | 开 | 只保留地区白名单；机房段/代理标记/时区/跳动/延迟规则全部跳过 |
| `headerNormalize` | 开 | 不再改写 User-Agent / Accept-Language / 客户端标识头 |
| `promptContext` | 开 | 不再注入环境事实、不再改写提示词时区（该开关的注入部分在挂载时决定，改动需重启生效） |
| `burstLimit` | 开 | 不再排队，并发直冲上游 |
| `streamWatch` | 开 | 流即使没有终止标记也算正常结束（不再产生 `late-abort`） |
| `autoRoute` | 开 | 启动时不改写 provider 的 baseURL（改动需重启生效） |

切换 `enabled` 或 `egressProbe` 会自动清空熔断与探测缓存，避免"关了还是被拦"的困惑。

| 字段 | 默认 | 说明 |
|---|---|---|
| `listenHost` / `listenPort` | `127.0.0.1` / `8799` | 中继监听，只绑回环 |
| `connectTimeoutMs` / `tlsTimeoutMs` | `8000` | 出口连接超时 |
| `requestTimeoutMs` | `900000` | 单请求上限（长生成用） |
| `maxRequestBytes` | `33554432` | 请求体上限 |
| `limits.maxConcurrentPerTarget` | `4` | 每个厂商同时进行的上游请求数；多出的排队，不拒绝（压掉 subagent/workflow 的突发） |
| `limits.queueTimeoutMs` | `60000` | 排队超时，超时返回 503（本地，不外发） |
| `logFile` | `<DSH_HOME>/logs/gemini-guard.log` | 日志落盘 |
| `verbose` | `false` | 同时打印到控制台 |

### `egress`（共享出口）

| 字段 | 默认 | 说明 |
|---|---|---|
| `proxy` | `''` | 可选上游 HTTP(S) 代理，如 `http://127.0.0.1:7890`；空表示走系统路由（TUN 模式用这个） |
| `allowedCountries` | `['TW']` | 全局允许清单；target 可用自己的 `allowedCountries` 覆盖，空数组表示不校验国家 |
| `geoUrl` | `ip-api.com` 查询 | 出口地理信息来源，可换自建 |
| `ttlMs` / `timeoutMs` | `90000` / `8000` | 探测缓存与超时 |
| `confirmations` | `1` | 同一出口 IP 需要连续几次探测一致才放行 |
| `requireStableExit` | `true` | 是否启用 IP 跳动检测 |
| `stabilityWindowMs` / `maxDistinctExitIps` | `3600000` / `2` | 窗口与阈值 |
| `rejectHosting` / `rejectProxyFlag` / `timeZoneConsistency` | `warn` | `off` / `warn` / `block` |
| `maxLatencyMs` | `1200` | 超过只告警 |

### `breaker`

| 字段 | 默认 | 说明 |
|---|---|---|
| `failureThreshold` | `3` | 连续传输类异常多少次开熔断 |
| `cooldownMs` | `120000` | 普通熔断冷却 |
| `hardStopCooldownMs` | `3600000` | 硬停冷却（地区被拒时） |
| `hardStop` | `true` | 地区被拒是否闩死到人工复位 |

### `environment`（提示词侧）

`region`、`timeZone`、`locale`、`device`、`injectContext`、`contextOrder`、`rewriteTimeZone`、`sourceTimeZone`。默认把运行时上下文里的 `Asia/Shanghai` 改写为 `Asia/Taipei`，并注入一段“本机环境事实”。

### `targets.<id>`

| 字段 | 说明 |
|---|---|
| `enabled` | 是否启用该 target（`gemini` 默认开，其余默认关） |
| `route` | pi-ai 路由名（`google` / `openai` / `anthropic` / `xai`） |
| `transport` | `relay`（默认，强约束）或 `direct`（不改 baseURL，只靠钩子判定，较松） |
| `pathPrefix` / `upstreamHost` / `upstreamPort` / `upstreamBasePath` | 中继前缀与真实上游 |
| `allowedCountries` | `null` 继承全局，或单独列表 |
| `apiKeyRef` / `displayName` | 凭据引用与显示名 |
| `manageProviderRoute` | 是否允许插件改写该路由的 baseURL |
| `headers.userAgent` / `acceptLanguage` / `apiClientHeader` / `apiClient` | 指纹 |
| `headers.forwardHeaders` | 除 `content-type`/`accept`/`authorization` 外，原样转发给厂商的头 |

## 边界与限制（请先读这条）

- **改不了出口 IP**。地区判定的输入是连接源 IP。插件让出口“固定、可验证、不跳动”，不能让出口“变成别的地方”。出口在台湾，请求就来自台湾；出口在机房段，即使国家是 TW 也可能被拒——[已有记录](https://github.com/maple3788/RAG_Lab/blob/7516654dbe0c16d110fad95e3de7000b3861e14e/docs/gemini-region-restriction.md)显示部分机房段（含部分新加坡机房）会被拒。家宽出口比机房出口稳。
- **不能保证不封号**。厂商风控不公开。本插件做的是“不主动制造可疑信号”：不跨地区抖动、不并发轰炸、被拒后不反复重试、不泄漏宿主指纹。它降低概率，不承诺结果。
- **`direct` 模式更松**。它保留原 baseURL，只靠 `llm/stream` 钩子判定；模型发现等不走钩子的路径不会被拦。要严格就用默认的 `relay`。
- **中继会改变部分 SDK 的“按域名猜测行为”**。pi-ai 的 `openai-completions` 用 `baseUrl.includes("api.openai.com")` 判断缓存与兼容开关；指向本机中继后这些判断失效，回落到 `provider` 名与默认兼容项。若某模型行为异常，用 `compat` 显式声明。
- **默认 `retryPolicy` 建议改小**。DSH 默认对 `SERVER`/`TRANSPORT` 重试 5 次；出口抖动时等于 6 连击。建议在该路由上写：

  ```yaml
  retryPolicy:
    mode: normal
    maxRetries: 1
    retryableCodes: [RATE_LIMIT]
  ```

- **与 `dsh-request-retry` 共存**：闸门拦截的错误文本不含它的匹配词，被拦下的请求不会被它重试；它仍会重试真正的传输类失败，两者叠加时实际次数以上面的 `retryPolicy` 为准。
- **探测缓存是安全边界的一部分**。`ttlMs` 内不重复探测；节点在缓存有效期内掉了，这一次请求仍会放行，随后由传输失败计入熔断。想更严就把 TTL 调小、`confirmations` 调成 2。
- **自动写入路由依赖 `configEditor`**；桌面版有，纯 Host 组合可能没有。缺失时记录警告并给出可粘贴的 YAML。

## 与社区参考的关系

| 参考 | 借鉴了什么 |
|---|---|
| [dsh-request-retry](https://github.com/pachellber-marine/dsh-request-retry) | “HTTP 200 但流里没有终止事件即为截断”的判定，用于 `late-abort` |
| [claude-mem 04ab62d](https://github.com/thedotmack/claude-mem/commit/04ab62d5b36ff745335693a5f9cc41a9d6f0adda) | 把地区拒绝从“坏请求”里单独分类、单独冷却，而不是重试 |
| [gemini-API (CF Workers)](https://github.com/wwjj999/gemini-API-) | “在中转侧固定出口地区”的思路，说明伪造头部无意义 |
| [openstory PR #2220](https://github.com/openstory-so/openstory/pull/2220) | 地区被拒时的正解是换合规通路，而不是硬刚 |
| [LiteLLM Router](https://docs.litellm.ai/docs/router/learn/concepts.md) | 失败计数 + cooldown + half-open 的语义划分 |

## 验证

三个测试，都不花厂商 token：

```sh
node test/risk.mjs     # 纯逻辑：出口体检 7 例 + 上游错误分类 10 例
node test/config.mjs   # 配置解析：四个 target、relayBaseUrl 拼接、非法配置拒绝
node test/smoke.mjs    # 真实链路：错地区拒绝 / 未确认出口拒绝 / 确认后转发 / 单厂商故障隔离
```

`smoke.mjs` 会真的连一次 `ip-api` 与目标厂商（无 key，故拿到厂商自己的鉴权错误），用来证明中继链路与分类确实工作。
