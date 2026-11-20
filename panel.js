// Browser control panel served by the relay itself.
//
// Why a page instead of a Settings form: a locally linked bundle cannot resolve
// `@deepseek-ai/schemastery`, so it cannot export a Cordis `Config` schema and
// the Plugins page therefore shows the row (title, description, icon, detail
// document) but no generated switches. This page gives the same knobs, is
// reachable while the plugin runs, and works before any schema support lands.

/** Whitelisted runtime knobs. Anything else in the POST body is ignored. */
export function applySettings(cfg, patch, guard) {
  const applied = []
  let rulesChanged = false
  if (patch && typeof patch.enabled === 'boolean') {
    cfg.enabled = patch.enabled
    applied.push('enabled')
    rulesChanged = true
  }
  if (patch && patch.features && 'egressProbe' in patch.features) rulesChanged = true
  // A switch that changes what is enforceable must not leave a stale latch
  // behind: otherwise turning the probe off looks like nothing happened.
  if (rulesChanged && guard && typeof guard.clearBreakers === 'function') guard.clearBreakers()
  if (patch && Array.isArray(patch.allowedCountries)) {
    cfg.egress.allowedCountries = patch.allowedCountries
      .map((code) => String(code).trim().toUpperCase())
      .filter((code) => /^[A-Z]{2}$/.test(code))
    applied.push('egress.allowedCountries')
  }
  if (patch && Number.isInteger(patch.confirmations)) {
    cfg.egress.confirmations = Math.min(Math.max(patch.confirmations, 1), 10)
    applied.push('egress.confirmations')
  }
  if (patch && typeof patch.requireStableExit === 'boolean') {
    cfg.egress.requireStableExit = patch.requireStableExit
    applied.push('egress.requireStableExit')
  }
  if (patch && Number.isInteger(patch.maxDistinctExitIps)) {
    cfg.egress.maxDistinctExitIps = Math.min(Math.max(patch.maxDistinctExitIps, 1), 50)
    applied.push('egress.maxDistinctExitIps')
  }
  for (const key of ['rejectHosting', 'rejectProxyFlag', 'timeZoneConsistency']) {
    const value = patch?.[key]
    if (value === 'off' || value === 'warn' || value === 'block') {
      cfg.egress[key] = value
      applied.push(`egress.${key}`)
    }
  }
  if (patch && Number.isInteger(patch.maxConcurrentPerTarget)) {
    cfg.limits.maxConcurrentPerTarget = Math.min(Math.max(patch.maxConcurrentPerTarget, 1), 64)
    applied.push('limits.maxConcurrentPerTarget')
  }
  if (patch && patch.features && typeof patch.features === 'object') {
    for (const [key, value] of Object.entries(patch.features)) {
      if (typeof value !== 'boolean' || !(key in cfg.features)) continue
      cfg.features[key] = value
      applied.push(`features.${key}`)
    }
  }
  if (patch && patch.targets && typeof patch.targets === 'object') {
    for (const [id, value] of Object.entries(patch.targets)) {
      const target = cfg.targets[id]
      if (!target || typeof value?.enabled !== 'boolean') continue
      target.enabled = value.enabled
      applied.push(`targets.${id}.enabled`)
    }
  }
  cfg.enabledTargets = Object.values(cfg.targets).filter((target) => target.enabled)
  return applied
}

export function currentSettings(cfg) {
  return {
    enabled: cfg.enabled,
    features: { ...cfg.features },
    allowedCountries: cfg.egress.allowedCountries,
    confirmations: cfg.egress.confirmations,
    requireStableExit: cfg.egress.requireStableExit,
    maxDistinctExitIps: cfg.egress.maxDistinctExitIps,
    rejectHosting: cfg.egress.rejectHosting,
    rejectProxyFlag: cfg.egress.rejectProxyFlag,
    timeZoneConsistency: cfg.egress.timeZoneConsistency,
    maxConcurrentPerTarget: cfg.limits.maxConcurrentPerTarget,
    targets: Object.fromEntries(
      Object.entries(cfg.targets).map(([id, target]) => [id, { enabled: target.enabled, route: target.route }]),
    ),
  }
}

export function renderPanel() {
  return `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>dsh-gemini-guard</title>
<style>
  :root { color-scheme: dark light; --fg:#e6e8eb; --dim:#9aa4af; --bg:#14171a; --card:#1c2126; --line:#2b3238; --ok:#4ade80; --warn:#fbbf24; --bad:#f87171; }
  @media (prefers-color-scheme: light) { :root { --fg:#1c2126; --dim:#5c6773; --bg:#f6f7f9; --card:#fff; --line:#e2e6ea; } }
  body { margin:0; font:14px/1.55 system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif; background:var(--bg); color:var(--fg); }
  main { max-width: 900px; margin: 0 auto; padding: 28px 20px 60px; }
  h1 { font-size: 18px; margin: 0 0 4px; }
  h2 { font-size: 14px; margin: 26px 0 10px; color: var(--dim); font-weight: 600; letter-spacing:.02em; }
  .sub { color: var(--dim); margin: 0 0 18px; }
  .card { background: var(--card); border:1px solid var(--line); border-radius:10px; padding:14px 16px; }
  .row { display:flex; align-items:center; justify-content:space-between; gap:14px; padding:7px 0; border-bottom:1px solid var(--line); }
  .row:last-child { border-bottom:none; }
  .row label { color: var(--fg); }
  .hint { color: var(--dim); font-size:12px; }
  input[type=text], input[type=number], select { background:transparent; color:var(--fg); border:1px solid var(--line); border-radius:6px; padding:4px 8px; font:inherit; min-width:90px; }
  button { background:transparent; color:var(--fg); border:1px solid var(--line); border-radius:7px; padding:6px 12px; font:inherit; cursor:pointer; }
  button.primary { border-color:#3f6fa8; color:#cfe3ff; }
  button:hover { border-color:#4a5561; }
  .chips { display:flex; flex-wrap:wrap; gap:8px; margin: 6px 0 0; }
  .chip { border:1px solid var(--line); border-radius:999px; padding:3px 10px; font-size:12px; color:var(--dim); }
  .ok { color: var(--ok); } .warn { color: var(--warn); } .bad { color: var(--bad); }
  pre { background:var(--bg); border:1px solid var(--line); border-radius:8px; padding:12px; overflow:auto; max-height:340px; font-size:12px; }
  .actions { display:flex; gap:8px; margin-top:12px; flex-wrap:wrap; }
  #msg { min-height: 20px; color: var(--dim); font-size: 12px; margin-top: 10px; }
</style>
</head>
<body>
<main>
  <h1>dsh-gemini-guard</h1>
  <p class="sub">出口闸门控制面板 · 本地回环，仅本机可访问</p>

  <div class="card">
    <div class="row"><span>状态</span><span id="state">…</span></div>
    <div class="chips" id="chips"></div>
    <div class="actions">
      <button onclick="act('recheck')">复检出口</button>
      <button onclick="act('reset')">复位熔断</button>
      <button onclick="act('route')">接管路由</button>
      <button onclick="load()">刷新</button>
      <button class="primary" onclick="save()">保存开关</button>
    </div>
    <div id="msg"></div>
  </div>

  <h2>开关</h2>
  <div class="card" id="form"></div>

  <h2>功能开关</h2>
  <div class="card" id="features"></div>

  <h2>详情</h2>
  <div class="card"><pre id="dump">…</pre></div>
</main>
<script>
var BASE = '/_gemini-guard';
function esc(v) { return String(v == null ? '' : v); }
function setMsg(t, cls) { var m = document.getElementById('msg'); m.textContent = t; m.className = cls || ''; }

function chip(text, cls) { return '<span class="chip ' + (cls || '') + '">' + esc(text) + '</span>'; }

function fillForm(s) {
  var html = '';
  html += row('插件总开关', '<select id="enabled"><option value="true">启用</option><option value="false">停用（全部本地拒绝）</option></select>');
  html += row('允许出口国家', '<input type="text" id="allowedCountries" placeholder="TW,JP（逗号分隔，留空=不校验）">');
  html += row('出口需连续确认次数', '<input type="number" id="confirmations" min="1" max="10">');
  html += row('IP 跳动检测', '<select id="requireStableExit"><option value="true">开</option><option value="false">关</option></select>');
  html += row('窗口内最多出口 IP 数', '<input type="number" id="maxDistinctExitIps" min="1" max="50">');
  html += row('机房段出口', select('rejectHosting'));
  html += row('被标记为代理的出口', select('rejectProxyFlag'));
  html += row('时区不一致', select('timeZoneConsistency'));
  html += row('每个厂商最大并发', '<input type="number" id="maxConcurrentPerTarget" min="1" max="64">');
  html += '<div class="row"><span>厂商开关</span><span class="hint">勾选即接管该路由</span></div>';
  var ids = Object.keys(s.targets || {});
  for (var i = 0; i < ids.length; i++) {
    var id = ids[i];
    html += '<div class="row"><label><input type="checkbox" class="tgt" data-id="' + esc(id) + '"> ' + esc(id) + '</label><span class="hint">' + esc(s.targets[id].route) + '</span></div>';
  }
  document.getElementById('form').innerHTML = html;
  document.getElementById('enabled').value = String(s.enabled);
  document.getElementById('allowedCountries').value = (s.allowedCountries || []).join(',');
  document.getElementById('confirmations').value = s.confirmations;
  document.getElementById('requireStableExit').value = String(s.requireStableExit);
  document.getElementById('maxDistinctExitIps').value = s.maxDistinctExitIps;
  document.getElementById('rejectHosting').value = s.rejectHosting;
  document.getElementById('rejectProxyFlag').value = s.rejectProxyFlag;
  document.getElementById('timeZoneConsistency').value = s.timeZoneConsistency;
  document.getElementById('maxConcurrentPerTarget').value = s.maxConcurrentPerTarget;
  var boxes = document.querySelectorAll('input.tgt');
  for (var k = 0; k < boxes.length; k++) {
    var tid = boxes[k].getAttribute('data-id');
    boxes[k].checked = !!s.targets[tid].enabled;
  }

  var FEATURES = [
    ['egressProbe', '出口探测（地理归属 + TLS 可达）', '关掉后不再校验出口地区，状态显示 unverified'],
    ['reachabilityProbe', '每厂商可达性探测', '探测时额外对每个上游做一次 TLS 握手'],
    ['riskRules', '风险规则（机房/代理/时区/跳动/延迟）', '只保留地区白名单'],
    ['headerNormalize', '统一客户端指纹', '关闭后透传原始 User-Agent'],
    ['promptContext', '提示词环境信息（注入 + 时区改写）', '关闭后模型看不到声明的地区/时区'],
    ['burstLimit', '并发整形（每个厂商排队）', '关闭后并发直冲上游'],
    ['streamWatch', '流中断检测', '关闭后流无终止标记也算正常结束'],
    ['autoRoute', '启动时接管 provider 路由', '改动需重启插件生效'],
    ['pathAware', '分流感知（智能分流环境）', '厂商域名解析到假 IP 时，改用厂商回包判定地区']
  ];
  var html = '';
  for (var i = 0; i < FEATURES.length; i++) {
    var f = FEATURES[i];
    html += '<div class="row"><label><input type="checkbox" class="feat" data-key="' + f[0] + '"> ' + f[1] + '</label><span class="hint">' + f[2] + '</span></div>';
  }
  document.getElementById('features').innerHTML = html;
  var fboxes = document.querySelectorAll('input.feat');
  for (var j = 0; j < fboxes.length; j++) {
    var key = fboxes[j].getAttribute('data-key');
    fboxes[j].checked = !!(s.features && s.features[key]);
  }
}

function row(label, control) {
  return '<div class="row"><label>' + label + '</label>' + control + '</div>';
}

function select(id) {
  return '<select id="' + id + '"><option value="off">忽略</option><option value="warn">仅告警</option><option value="block">拦截</option></select>';
}

function render(status) {
  var e = status.egress || {};
  var phase = e.phase === 'probed' ? (e.countryCode || '?') + ' / ' + (e.ip || '?') : '未探测';
  document.getElementById('state').innerHTML = status.enabled ? '<span class="ok">运行中</span>' : '<span class="bad">已停用</span>';
  var chips = [];
  chips.push(chip('出口 ' + phase, e.phase === 'probed' ? '' : 'warn'));
  if (e.isp) chips.push(chip(e.isp));
  if (e.timeZone) chips.push(chip(e.timeZone));
  if (e.hosting) chips.push(chip('机房段', 'warn'));
  if (e.proxyFlag) chips.push(chip('代理标记', 'warn'));
  if (e.distinctIpsInWindow != null) chips.push(chip('窗口内 IP 数 ' + e.distinctIpsInWindow, e.distinctIpsInWindow > status.policy.maxDistinctExitIps ? 'bad' : ''));
  if (e.confirmations) chips.push(chip('确认 ' + e.confirmations));
  var t = status.targets || {};
  var keys = Object.keys(t);
  for (var i = 0; i < keys.length; i++) {
    var id = keys[i]; var b = t[id].breaker;
    var cls = b.state === 'open' ? 'bad' : 'ok';
    chips.push(chip(id + ' ' + b.state + (b.reason ? '/' + b.reason : ''), cls));
  }
  document.getElementById('chips').innerHTML = chips.join('');
  document.getElementById('dump').textContent = JSON.stringify(status, null, 2);
}

function load() {
  fetch(BASE + '/status').then(function (r) { return r.json(); }).then(function (status) {
    render(status);
    return fetch(BASE + '/settings').then(function (r) { return r.json(); }).then(fillForm);
  }).catch(function (err) { setMsg('读取失败：' + err, 'bad'); });
}

function save() {
  var patch = {
    enabled: document.getElementById('enabled').value === 'true',
    allowedCountries: document.getElementById('allowedCountries').value.split(',').map(function (s) { return s.trim(); }).filter(Boolean),
    confirmations: Number(document.getElementById('confirmations').value),
    requireStableExit: document.getElementById('requireStableExit').value === 'true',
    maxDistinctExitIps: Number(document.getElementById('maxDistinctExitIps').value),
    rejectHosting: document.getElementById('rejectHosting').value,
    rejectProxyFlag: document.getElementById('rejectProxyFlag').value,
    timeZoneConsistency: document.getElementById('timeZoneConsistency').value,
    maxConcurrentPerTarget: Number(document.getElementById('maxConcurrentPerTarget').value),
    features: {},
    targets: {}
  };
  var fboxes = document.querySelectorAll('input.feat');
  for (var f = 0; f < fboxes.length; f++) {
    patch.features[fboxes[f].getAttribute('data-key')] = fboxes[f].checked;
  }
  var boxes = document.querySelectorAll('input.tgt');
  for (var i = 0; i < boxes.length; i++) {
    patch.targets[boxes[i].getAttribute('data-id')] = { enabled: boxes[i].checked };
  }
  fetch(BASE + '/settings', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch) })
    .then(function (r) { return r.json(); })
    .then(function (res) {
      setMsg(res.persisted ? '已保存到 profile 配置' : ('已生效（本次运行）；未写入配置文件：' + (res.persistError || '未知原因')), res.persisted ? 'ok' : 'warn');
      load();
    })
    .catch(function (err) { setMsg('保存失败：' + err, 'bad'); });
}

function act(name) {
  fetch(BASE + '/' + name, { method: 'POST' })
    .then(function (r) { return r.json(); })
    .then(function (res) { setMsg(name + '：' + (res.ok ? '成功' : '未通过'), res.ok ? 'ok' : 'bad'); load(); })
    .catch(function (err) { setMsg(name + ' 失败：' + err, 'bad'); });
}

load();
</script>
</body>
</html>`
}
