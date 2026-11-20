# 发布与变更流程

这个插件的每一次改动都走同一条流水线。目的只有一个：**任何一个状态都能被复现、被回滚、被验证**。

## 0. 一条铁律

**本地是唯一的事实来源。** 不在 profile 的 `cordis.patch.yml` 里手改本插件的配置、不在 `~/.dsh` 下手装包、不直接改 `node_modules`。
DSH 侧只通过 `plugin_manager`（`install_bundle` / `set_bundle` / `remove_bundle`）变更；配置只通过插件自己的 `configEditor` 或面板写入。

手改的代价不是"不规范"，而是**不可回滚**：没人知道当时改了哪一行，出问题时也无法用一条命令回到已知良好状态。

## 1. 改动（本地）

```powershell
cd R:\xyfan\dsh-workspace\dsh-gemini-guard
# 改代码 / 文档 / 测试
```

规则：

- 行为改动必须带测试；改不动的部分（协议常量、错误码）不为了"可测"而抽象。
- 新增配置项必须有默认值、必须在 `config.js` 里做范围校验、必须在 `schema.js` 里出现在表单中。
- 默认值只有一份：`config.js` 的 `DEFAULTS`；`schema.js` 从它读，不复制。

## 2. 预检（全绿才允许提交）

```powershell
npm test
# 等价于依次执行：
#   node test/risk.mjs      出口判定 + 上游错误分类
#   node test/config.mjs    配置解析、四厂商、非法配置拒绝
#   node test/schema.mjs    当前 checkout 的 Config 模式
#   node test/smoke.mjs     真实链路：地区拦截、确认门、转发、厂商隔离、面板
```

任何一项失败 → 回到第 1 步。**不允许"先提交再补测试"。**

`test/smoke.mjs` 会真的连一次 `ip-api.com` 与目标厂商（无 key，只验证被厂商自己的鉴权错误打回），所以它同时是一致性检查。

## 3. 提交（语义化）

```
<type>: <一句话说明>

<为什么这么改，以及不这么改会怎样>
```

`type` 取 `feat` / `fix` / `docs` / `refactor` / `test` / `chore`。一个提交只做一件事；行为改动与格式改动分开。

## 4. 版本与标签

- 修 bug：`PATCH` +1（`0.3.1-beta.1` → `0.3.2-beta.1`）
- 加功能：`MINOR` +1
- 破坏兼容：`MAJOR` +1
- 预发布期间统一带 `-beta.N`；`-beta.N` 递增表示同一版本内的迭代

```powershell
# package.json 的 version 与 CHANGELOG.md 的条目必须同时改
git add -A
git commit -m "fix: ..."
git tag -a v0.3.2-beta.1 -m "0.3.2-beta.1 — ..."
```

## 5. 推送

```powershell
git push origin main
git push origin v0.3.2-beta.1
```

推完先验证远端真的对：`gh api repos/xyfann/dsh-gemini-guard/contents --jq '.[].name'` 与 `raw.githubusercontent.com/.../package.json` 的 `version`。

## 6. 更新 DSH 侧（只走插件管理器）

```
plugin_manager install_bundle  target = github:xyfann/dsh-gemini-guard
```

- 返回 `application: applied` = 已生效；
- 返回 `restart-required` = **文件已换新，但进程还在跑旧模块**，必须重启 DSH 才会加载新代码；
- 返回 `failed` = 保留诊断，先修环境（例如 runtime 里 pnpm 路径缺失）再重试。

## 7. 验证（三层，缺一不可）

| 层 | 怎么看 | 通过标准 |
|---|---|---|
| 加载 | `cordis_inspect_query` → Config.listConfigs，条目 `status: schema` | 行存在且 schema 解析成功 |
| 运行 | `GET http://127.0.0.1:8799/_gemini-guard/status` | `egress.phase` 有值、`targets.*` 齐全、日志无 warn 堆栈 |
| 功能 | 面板 `/` 打开、GUI 里模型选择器出现受管厂商、发一次真实请求 | 计数 `admitted` 增加、`x-gemini-guard: pass`、厂商正常回包 |

功能层失败时，先看 `status.recent` 的最近日志，再看 `<DSH_HOME>\logs\gemini-guard.log`。

## 8. 回滚

按影响面从小到大：

1. **只回滚行为**：面板关掉对应功能开关（`features.*`），或把 `enabled` 置 false —— 立即生效，不重启。
2. **回滚路由**：`POST /_gemini-guard/unroute` —— 撤掉 baseURL 改写，路由回落厂商官方端点。
3. **回滚版本**：`install_bundle` 指向旧 tag：`github:xyfann/dsh-gemini-guard#v0.3.0-beta.1`，然后重启。
4. **彻底移除**：`unroute` → `plugin_manager remove_bundle` → 可选删除日志文件。

回滚不需要改代码，也不需要手改配置 —— 这是第 0 条铁律的全部意义。

## 9. 已知环境前置

- DSH 的 pnpm 运行时：本机实际在 `~/.dsh/dsh-runtimes/dsh-primary-runtime`，而插件管理器按 `安装目录/resources/runtime/primary-runtime` 查找。已用目录联接补齐；换机或重装 DSH 后需重新确认。
- 出口节点未就绪时，受管厂商的调用会被本地 403 拦截 —— 这是设计行为，不是故障。
