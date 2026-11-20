# dsh-gemini-guard

Fail-closed egress gate for DeepSeek Harness vendor routes that decide whether a
developer API is offered from the **caller's public IP**.

Vendors covered out of the box — all four are pi-ai catalog routes, so no model
list needs maintaining:

| target | route | upstream | relay baseURL |
|---|---|---|---|
| `gemini` | `google` | generativelanguage.googleapis.com | `…/gemini/v1beta` |
| `openai` | `openai` | api.openai.com | `…/openai/v1` |
| `anthropic` | `anthropic` | api.anthropic.com | `…/anthropic` |
| `grok` | `xai` | api.x.ai | `…/grok/v1` |

Adding a fifth vendor is a config block, not code: set its route, host, path and
the headers it needs forwarded.

```
DSH session → llm-pi-ai route → 127.0.0.1:8799/<prefix> → vendor
                     │                    │
                     └ llm/stream gate    └ probe + risk rules + breaker
```

## What it refuses to do

- It cannot change the exit IP. Region checks read the source IP, so nothing in a
  header or a prompt can move it. The plugin makes the exit **stable, vetted and
  reproducible**; it does not make it somewhere else.
- It does not promise an account survives. It removes the self-inflicted
  signals: cross-region flapping, retry storms, leaked host fingerprints, and
  requests sent from a node nobody verified yet.

## Pre-flight rules

| signal | default action |
|---|---|
| exit country not allowed | block (hard stop) |
| more than N distinct exit IPs in the window | block (flapping) |
| exit is a datacenter / flagged as proxy | warn (`block` optional) |
| exit timezone ≠ declared timezone | warn (`block` optional) |
| exit not confirmed by N probes | block |
| vendor says region unsupported | hard stop, never retried |
| vendor says bad key | that target's breaker opens |
| 429 / quota / overloaded | cooldown until `Retry-After` |
| stream ended without a terminator | counted as instability |

## Status endpoints

```
GET  /_gemini-guard/          control panel (HTML, toggles + live status)
GET  /_gemini-guard/status      exit identity, per-target breaker, cooldowns, counters
GET  /_gemini-guard/settings    editable knobs
POST /_gemini-guard/settings    apply knobs (persisted through the profile config row when possible)
POST /_gemini-guard/recheck     force a fresh probe (?target=gemini to narrow)
POST /_gemini-guard/reset       clear breakers and re-probe
POST /_gemini-guard/unroute     drop the baseURL rewrite, so an uninstall leaves no dead route
```

Security, size, crash blast radius, and uninstall: [docs/SECURITY.md](docs/SECURITY.md).

The panel exists because a locally linked bundle cannot resolve
`@deepseek-ai/schemastery`, so it cannot export a Cordis `Config` schema and the
Plugins page shows no generated form. The package now ships that schema anyway
(`schema.js`, resolved by dynamic import): installed **as a dependency** the
Settings page renders the full form; linked from a directory it degrades to
"no form" and the panel carries the same switches — `egressProbe`,
`reachabilityProbe`, `riskRules`, `headerNormalize`, `promptContext`,
`burstLimit`, `streamWatch`, `autoRoute`.

## 三份代码 diff：DSH 跑的到底是不是你推的那份

```
GET  /_gemini-guard/diff?target=dsh-gemini-guard        # 有 60s 缓存
GET  /_gemini-guard/diff?target=<包名>&refresh=1        # 强制重查
```

三处副本逐文件比内容哈希：工作区源码、GitHub 仓库、profile 里已安装的副本。

| verdict | 含义 |
|---|---|
| `identical` | 三份完全一样（文件集合与内容） |
| `content-identical` | 内容一致，只是工作区多了 `test/` 这类不会装进 DSH 的文件 |
| `drift` | 有文件内容不同，或安装副本多出源码里没有的文件 |
| `unknown` | 有一份没读到（例如远端不可达），只报能比的部分 |

每个差异带 `status`：`workspace-ahead`（改了没提交/没推）、`installed-stale`（需要重装）、`github-stale`、`only-installed`（可疑）、`missing-installed` 等。

位置不用配：工作区按 `DSH_WORKSPACE` → `$DSH_HOME/storages/workspace.json` → `~/dsh-workspace` → 当前目录依次找；安装副本按 `DSH_PROFILE_DIR/node_modules` → `$DSH_HOME/profiles/*/node_modules` 找；仓库地址取 `package.json` 的 `repository`，没有就取 `git remote origin`。GitHub 侧只做一次浅 fetch 到临时裸库读 blob sha，不下载仓库、不改你的 `.git`；`?repo=` 可临时指定别的仓库。

## Tests

```sh
node test/risk.mjs     # exit judgement + upstream failure classification
node test/config.mjs   # four targets, relay URL assembly, invalid config rejection
node test/smoke.mjs    # real egress: region block, confirmation gate, forward, isolation, panel
node test/schema.mjs   # pins the Config mode of this checkout
```

Full documentation: [docs/DETAIL.md](docs/DETAIL.md).
