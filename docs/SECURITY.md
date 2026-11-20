# 安全与工程审查（dsh-gemini-guard）

本文回答四类问题：**体积、它改动了什么、崩溃的影响半径、卸载是否干净**。
所有数字与结论来自本文写作时对仓库的直接测量与代码扫描，命令附在每节末尾，可自行复核。

## 1. 体积与构成

| 项 | 数值 |
|---|---|
| 包总体积 | **154 KB**（21 个文件，含文档与测试） |
| 运行时 JS | **2,436 行**（9 个文件：`index/config/schema/guard/relay/hooks/transport/risk/panel`） |
| 测试 JS | 382 行（`test/` 四个文件） |
| 依赖 | **0 个 runtime 依赖**，只用 Node 内置模块（`http/net/tls/zlib/fs/path`） |
| 可选依赖 | `@deepseek-ai/schemastery`，**仅用于设置页表单**，用动态 import + try/catch：解析不到就退化为“无表单”，不影响挂载与运行 |
| 原生模块 / 安装脚本 | 无。`package.json` 没有 `scripts`、没有 `postinstall` |
| 最大单文件 | `guard.js` 18.6 KB |

零依赖这件事很重要：它意味着**没有供应链风险**（不会因为某个传递依赖投毒而中招），也不需要 pnpm 在安装时执行任何构建脚本。

```powershell
Get-ChildItem -Recurse -File | Measure-Object Length -Sum
(Get-ChildItem -Recurse -Include *.js,*.mjs | Get-Content | Measure-Object -Line).Lines
```

## 2. 它对这台电脑做了什么

| 面 | 事实 |
|---|---|
| 监听端口 | 仅 `127.0.0.1:8799`（`listenHost` 可改，但代码里没有任何 `0.0.0.0` 默认值） |
| 出站连接 | 三类：①地理探测地址（默认 `ip-api.com`，可换成自建）②各 target 的上游厂商 ③可选的 `egress.proxy` |
| 磁盘写入 | **只有一个日志文件** `<DSH_HOME>\logs\gemini-guard.log`（JSON 行，追加写）。除它之外没有任何 `fs.write*` |
| 配置写入 | 仅在你在面板点"保存"时，通过 DSH 的 `configEditor` 写 profile 的 `cordis.patch.yml`（框架提供的受控入口） |
| 系统设置 | **不碰**：无注册表、无服务、无计划任务、无自启动、无环境变量持久化、无 hosts 修改 |
| 子进程 | **没有**：代码里没有 `child_process`，不执行任何外部命令 |
| 动态执行 | **没有** `eval` / `new Function` |
| 浏览器面 | 面板是一张自包含 HTML（无外链、无 CDN、无 `<script src>`），只向同源 `/_gemini-guard/*` 发请求 |

```powershell
Select-String -Path *.js -Pattern 'child_process','eval(','new Function','HKCU','HKLM','schtasks'
Select-String -Path *.js -Pattern 'node:fs','listen('
```

## 3. 崩溃影响半径

| 场景 | 后果 |
|---|---|
| 插件加载失败（配置非法、端口被占） | 该插件行 `failed`，**DSH 进程照常运行**；其余插件与会话不受影响。配置非法时插件直接不挂载，比"半套规则生效"更安全 |
| 中继端口被占 | 插件进入硬停状态（所有受管请求本地拒绝），不会假装正常 |
| 中继运行时出错（EMFILE 等） | 兜底 `server.on('error')` 记录日志并继续；**不会**变成未捕获异常 |
| 某次请求异常 | 每个 socket 都挂了 `error` 处理器（请求、响应、上游、客户端断开），异常转为该次调用的失败，不外溢 |
| 钩子抛错 | `llm/stream` 抛错 → 变成本次模型调用的失败，`llm-retry` 按策略决定是否重试；不会打穿进程 |
| **唯一真实的连带风险** | 路由的 `baseURL` 已被改写到本机中继，而插件没起来 → 受管厂商的调用会失败（报连接被拒）。这不是崩溃，是配置残留；用 `/unroute` 或手工改回即可 |

## 4. 卸载是否干净

推荐的"先撤路由、再卸包"顺序：

1. `POST http://127.0.0.1:8799/_gemini-guard/unroute`
   → 把 `google` / `openai` / `anthropic` / `xai` 路由的 `baseURL` 覆盖撤掉（只撤指向本机中继的那些），路由回落到厂商官方端点。
2. **Plugins → 移除该 bundle**（或 `plugin_manager remove_bundle`）
   → 删除包、删除 patch 里由 bundle 插入的 `gemini-guard` 行。本插件没有写在别处的状态。
3. 可选：删除 `<DSH_HOME>\logs\gemini-guard.log`（唯一残留物，纯本地日志）。
4. 可选：检查 `cordis.patch.yml` 里是否还有 `gemini-guard` 字样；若你曾在面板保存过开关，`config` 会留一条覆盖记录，删掉即可（`unroute` 不处理开关残留，因为它不影响功能）。

**不做第 1 步会怎样**：卸载后路由仍指向 `127.0.0.1:8799`，而中继已不在 → 这几个厂商的调用报 `ECONNREFUSED`。不是系统损坏，但会让人困惑。所以第 1 步是唯一"必须"的动作。

## 5. 有没有我的个人信息

对全部源码、配置、文档做了关键词扫描（用户名、`C:\Users`、盘符路径、机器名、邮箱、`AIza`/`sk-`/`xai-`/`sk-ant`、私钥头）：

| 关键词 | 命中 |
|---|---|
| `xyfan` / `R:\` / `C:\Users` / `DESKTOP-` / 邮箱 / `AIza` / `sk-` / `sk-ant` / 私钥头 | **0** |
| `xai-` | 1 处，是 `XAI_API_KEY` 的**占位示例**，不是真 key |
| `USERNAME` | 2 处，是代理认证里的 `url.username` 字段名 |

结论：**插件本体不含任何个人信息**。默认值只有产品名与行业事实（厂商域名、UA、协议路径）。

需要知道的两个"运行时会产生个人信息"的点：

- **日志文件**会记录出口 IP、ISP、ASN、时区、以及每次拦截/失败的原因。这些留在**本机**，不上传。
- **地理探测**每次探测都会向 `ip-api.com` 发一个请求，对方能看到你当时的出口 IP。想避免就把 `egress.geoUrl` 换成自建服务，或在面板里关掉"出口探测"（代价是地区白名单失效）。

## 6. "写死"清单：哪些东西不能改，为什么

| 值 | 可否配置 | 说明 |
|---|---|---|
| 监听地址/端口、日志路径 | ✅ `listenHost` / `listenPort` / `logFile` | |
| 出口代理、允许国家、确认次数、抖动阈值、三档风险策略、探测地址与 TTL | ✅ `egress.*` | 面板里也能改 |
| 每个厂商：路由名、上游域名/端口/路径前缀、允许国家、API key 引用名、UA、语言、客户端标识头、需要透传的鉴权头 | ✅ `targets.<id>.*` | 新增第五家厂商只改配置 |
| 并发上限、排队超时、请求体上限、各种超时 | ✅ `limits.*`、顶层超时 | |
| 提示词环境事实、时区来源、是否跟随出口 | ✅ `environment.*` | `followExit: true` 时地区/时区自动跟随探测结果，适合给任何地区的人用 |
| 8 个功能开关 | ✅ `features.*` + 面板 | |
| 控制端点路径 `/_gemini-guard` | ❌ 代码常量 | 改了要同步改面板与文档，收益小 |
| 403 拒绝响应的 JSON 外形（`PERMISSION_DENIED` + ErrorInfo） | ❌ 代码常量 | 这是让各家 SDK 正确分类失败的**协议形状**，做成可配只会制造误判 |
| SSE 终止标记（`[DONE]` / `message_stop` / `finishReason` / `response.completed`） | ❌ 代码常量 | 厂商协议事实，不是偏好 |
| 风险原因码（`country-not-allowed` 等） | ❌ 代码常量 | 内部词汇，文档与测试依赖它 |
| 面板 HTML/CSS | ❌ 代码常量 | 刻意零外链，避免引入第三方资源 |
| UA 里的运行时版本 | ✅ 可用 `{node}` 占位符注入真实版本（默认已用） | 之前写死成固定版本号是缺陷，已修正 |

> 我此前说的"写死"，指的正是最后一行那类：把 `gl-node/22.14.0` 这样的字面量硬编码在默认值里。现在的规则是——**凡是"这台机器/这个地区/这个人"相关的，全部走配置；只有"协议事实"和"内部词汇"留在代码里**。

## 7. 尚未验证的部分（诚实清单）

- 以上是**静态审查 + 独立运行测试**（`test/*.mjs`，26 + 18 + 11 + 3 项全绿）的结论；**未在"已安装进 DSH"的状态下验证**运行时隔离行为（安装审批此前被拒，profile 未改动）。
- "插件加载失败不带走 DSH"依据的是 Cordis 的插件生命周期设计（行状态 `failed`），而不是我实测到的崩溃注入实验。要坐实这条，装好之后可以做一个受控实验：故意写坏一行配置，观察 DSH 是否存活、该行是否显示 `failed`。
- **`Config` 双模式已用真实 schemastery 验证**：把插件复制到临时目录、并为 `@deepseek-ai/schemastery` 放一个转发到本机 3.19.0 的 shim 后，`Config` 变成函数、默认值materialize 出四个厂商目标、`Config({})` 的输出能通过 `resolveConfig()`、错误类型被 schema 拒绝；在链接模式下 `Config` 为 `undefined` 且入口照常加载。仍未验证的是：DSH 设置页实际渲染出来的控件布局与文案。`test/schema.mjs` 会固定当前 checkout 处于哪种模式。
