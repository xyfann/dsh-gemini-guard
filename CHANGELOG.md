# Changelog

本项目的版本记录。版本号遵循语义化版本：`MAJOR.MINOR.PATCH`，预发布用 `-beta.N`。

## 0.3.4-beta.1 — 2026-11-20

### 新增

- **三份代码 diff（`GET /_gemini-guard/diff`）**：同一份插件的三处副本——工作区源码、GitHub 仓库、profile 里已安装的副本——逐文件比内容哈希，回答"DSH 现在跑的到底是不是我改/我推的那份"。默认比本插件自己，`?target=` 可查任意已安装插件。
- 判定四档：`identical`（三份完全一样）、`content-identical`（内容一致，只是工作区多了 `test/` 这类不会装进 DSH 的文件）、`drift`（有内容不同，或安装副本多出源码里没有的文件）、`unknown`（有一份没读到）。
- 行尾不误报：工作区交给 `git hash-object` 按提交时的过滤器算哈希，安装副本额外算一份 CRLF→LF 的规范化哈希，只在行尾不同按同一份内容处理。
- 位置零配置：工作区按 `DSH_WORKSPACE` → `$DSH_HOME/storages/workspace.json` → `~/dsh-workspace` → 当前目录找；安装副本按 `DSH_PROFILE_DIR/node_modules` → `$DSH_HOME/profiles/*/node_modules` 找；仓库地址取 `package.json` 的 `repository`，没有就取 `git remote origin`。
- GitHub 侧只做一次浅 fetch 到临时裸库、读 tree 里的 blob sha，不下载仓库、不改用户的 `.git`。
- `test/diff.mjs`：离线覆盖六种情形——基线、安装副本被改、安装副本多出文件、工作区未提交、推送重装后回到一致、远端不可达。

## 0.3.3-beta.1 — 2026-11-20

### 修复

- **路由接管会保留空的 `models: []`**：pi-ai 语义里这个字段是"整体替换内置目录"，空数组等于该路由**零模型**——设置页填完 key 后模型选择器仍然什么都没有。接管时现在会删掉空列表并记一条说明，内置目录随之恢复。

### 新增

- `test/route.mjs`：直接驱动 `ensureProviderRoutes`，覆盖五种情形——空 models 清理、用户自定义 baseURL 不被覆盖、缺路由时创建、缺 configEditor 时报错、编辑器挂起时 10 秒超时返回。这是本次"模型消失"事故的看门人。

## 0.3.2-beta.1 — 2026-11-20

### 修复

- **启动被阻塞（严重）**：`apply()` 里 `await ensureProviderRoutes()` 会等配置写入返回。宿主在 HMR 事务内时该写入可能**挂起**而不是报错，导致 `apply()` 永不返回、DSH 主窗口打不开。现在激活立即返回，路由接管改由 1.5s 定时器触发，再走 1.5s / 5s / 15s / 40s 重试阶梯；定时器通过 `ctx.effect` 随插件卸载清理，并 `unref()` 以免拖住进程退出。
- `ensureProviderRoutes` 的 `editor.edit()` 增加 10 秒上限（`Promise.race`），挂起的编辑器不再能拖住调用方（重试阶梯或面板端点）。

### 新增

- `test/boot.mjs`：用"永不 resolve 的配置编辑器"复现该故障，断言 `apply()` 在 2 秒内返回。这条测试是本次事故的看门人。

### 说明

- 修复思路来自用户用 Codex 做的紧急修补（同一处 `index.js`），此处按发布流程收进正源，并补上回归测试与编辑器超时。

## 0.3.1-beta.1 — 2026-11-20

### 修复

- **激活后路由改写失败**：插件在 HMR 事务内被激活时，`configEditor.edit` 会被拒绝（`HMR transactions cannot be nested`），导致 `baseURL` 没有指向中继、模型选择器里看不到受管厂商。现在 `ensureProviderRoutes` 返回结果并按 1.5s / 5s / 15s / 40s 延迟重试，直到事务收尾。
- 面板新增「接管路由」按钮与 `POST /_gemini-guard/route`，可手动触发同一次改写。

## 0.3.0-beta.1 — 2026-11-20

首个对外测试版。给按来源 IP 判定地区的大模型路由加一层失败即拒的出口闸门。

### 新增

- **多厂商目标**：`gemini` / `openai` / `anthropic` / `grok` 四条路由共用一套出口策略，熔断与计数按厂商隔离。加第五家厂商只需在 `targets` 里加一段配置。
- **出口体检与预判拦截**：地区白名单、机房段、代理标记、时区一致性、出口 IP 跳动、探测延迟；`off / warn / block` 三档处置。
- **熔断器**：地区被拒硬停、鉴权被拒熔断、429/配额/过载按 `Retry-After` 冷却、流无终止标记判为中断。
- **控制面板** `http://127.0.0.1:8799/_gemini-guard/`：实时状态、复检、复位、撤销路由、保存开关。
- **8 个功能开关**：出口探测、可达性探测、风险规则、客户端指纹、提示词环境、并发整形、流中断检测、启动接管路由。
- **`Config` 双模式**：作为 profile 依赖安装时设置页渲染完整表单；目录链接安装时自动退化为无表单，开关走面板。
- **`environment.followExit`**：地区/时区跟随探测到的出口，一套配置给任何地区的人用。
- **`POST /_gemini-guard/unroute`**：卸载前撤销路由改写，避免留下指向死端口的路由。
- **并发整形**：每厂商信号量排队，压掉 subagent/workflow 的突发。

### 修复

- 客户端取消（Stop / 取消 turn）不中止上游请求，导致继续计费与"并发轰炸"外观。
- 拦截响应前未 drain 请求体，大请求体时客户端可能收到 RST 而不是 403。
- 错误响应体未解压，gzip 时地区拒绝会被误分类为普通 400。
- 中继监听成功后移除临时 `error` 监听，运行期 `error` 会成为未捕获异常。
- 重复 route/prefix 校验包含已禁用目标，妨碍手写同名替换。
- User-Agent 里的 Node 版本硬编码，改为 `{node}` 占位注入真实版本。
- 多目标可达性探测串行，改为并行。

### 已知限制

- 无法改变出口 IP：地区判定读的是连接源 IP，插件只能让出口"固定、可验证、不跳动"。
- 机房 IP 可能被厂商拒绝，与插件无关。
- 账号国家/结算地不在本插件的能力范围内。
- **首次安装后需重启一次 DSH**：HMR 热加载激活处于 loader 事务内，`configEditor` 的写入会被拒绝（`HMR transactions cannot be nested`），provider 路由只能在正常 boot 时写入。详见 `docs/RELEASE.md` 第 6 节。
