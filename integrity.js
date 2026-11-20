// 三份代码 diff：工作区源码 ↔ GitHub 仓库 ↔ DSH profile 里已安装的副本。
//
// 一个守护插件最先该守的是它自己的代码：用户改工作区、推 GitHub、重装 profile，
// 任何一步漏掉，DSH 跑的就不是用户以为的那份。这里不做推断，只比内容。
//
// 比的单位是文件内容哈希，用的是 git blob 的 SHA-1（sha1("blob <len>\0" + bytes)）。
// 选它是因为 GitHub 的 tree 本来只给这个值：不用下载仓库，也能跟本地逐字节对齐。
import crypto from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFile, spawn } from 'node:child_process'

const IGNORE = new Set(['.git', 'node_modules', '.DS_Store', 'Thumbs.db'])

export const STATUS_LABELS = {
  same: '一致',
  differs: '三份内容互不相同',
  'workspace-ahead': '工作区改过、还没提交/推送',
  'installed-stale': '安装副本落后于源码（需要重装）',
  'github-stale': 'GitHub 落后于本地',
  'only-workspace': '只在工作区（通常是未发布的 test/ 等）',
  'only-github': '只在 GitHub（工作区缺文件）',
  'only-installed': '只在安装副本（可疑：源码里没有）',
  'missing-installed': '安装副本缺这个文件',
  'missing-workspace': '工作区缺这个文件',
  'missing-github': 'GitHub 缺这个文件',
}

export function gitBlobHash(buffer) {
  return crypto.createHash('sha1').update(`blob ${buffer.length}\0`).update(buffer).digest('hex')
}

function runGit(args, { cwd, timeoutMs = 20000 } = {}) {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, timeout: timeoutMs, windowsHide: true, maxBuffer: 32 << 20, encoding: 'utf8' },
      (error, stdout, stderr) => resolve({
        ok: !error,
        code: error ? (typeof error.code === 'number' ? error.code : 1) : 0,
        stdout: String(stdout ?? ''),
        stderr: String(stderr ?? (error instanceof Error ? error.message : '')),
      }))
  })
}

const text = (error) => (error instanceof Error ? error.message : String(error))

// ---------------------------------------------------------------------------
// 哈希的两种形态
//
// raw 是磁盘上的字节；norm 是把它当文本、把 CRLF 折成 LF 之后的字节。
// 为什么需要两个：git 提交时按 .gitattributes 把行尾规范化，所以 GitHub 上的
// blob 可能是 LF，而 worktree/安装副本里躺着 CRLF。只比 raw 会在 Windows 上
// 把整棵树误报成"全都不一样"。比较规则：任一对得上就算同一份内容。
// ---------------------------------------------------------------------------

const hashOf = (raw, norm = '') => ({ raw, norm })

function looksTextual(buffer) {
  const limit = Math.min(buffer.length, 8192)
  for (let index = 0; index < limit; index += 1) {
    if (buffer[index] === 0) return false
  }
  return true
}

function sameHash(left, right) {
  if (!left || !right) return false
  if (left.raw !== '' && left.raw === right.raw) return true
  const candidates = [left.raw, left.norm].filter(Boolean)
  const others = [right.raw, right.norm].filter(Boolean)
  return candidates.some((candidate) => others.includes(candidate))
}

function isEolOnly(left, right) {
  return left?.raw !== right?.raw && left?.norm !== '' && (left.norm === right?.raw || left.norm === right?.norm)
}

/** 一批路径交给 git 自己算哈希：过滤器和 .gitattributes 都按提交时那套来。 */
function hashObjects(cwd, paths, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn('git', ['hash-object', '--stdin-paths'], { cwd, windowsHide: true })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => child.kill(), timeoutMs)
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('error', (error) => {
      clearTimeout(timer)
      resolve({ ok: false, stdout: '', stderr: error.message })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ ok: code === 0, stdout, stderr })
    })
    child.stdin.end(`${paths.join('\n')}\n`)
  })
}


// ---------------------------------------------------------------------------
// 三份清单
// ---------------------------------------------------------------------------

/** 工作区：让 git 按 .gitignore 列文件（含未跟踪、未忽略的），不在 git 仓库里就遍历目录。 */
async function workspaceFiles(root) {
  const listed = await runGit(['-C', root, 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: root })
  if (listed.ok) {
    const files = new Map()
    for (const entry of listed.stdout.split('\0')) {
      if (entry === '') continue
      const relative = entry.replace(/\\/g, '/')
      if (!isIgnored(relative)) files.set(relative, path.join(root, relative))
    }
    return { files, via: 'git' }
  }
  return { files: await walkFiles(root), via: 'dir' }
}

function isIgnored(relative) {
  return relative.split('/').some((segment) => IGNORE.has(segment))
}

/** 一层目录遍历（安装副本用，没有 .gitignore 可依）。符号链接不跟，避免环。 */
async function walkFiles(root) {
  const files = new Map()
  const pending = ['']
  while (pending.length > 0) {
    const relative = pending.pop()
    const absolute = relative === '' ? root : path.join(root, relative)
    let entries
    try {
      entries = await fsp.readdir(absolute, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const child = relative === '' ? entry.name : `${relative}/${entry.name}`
      if (isIgnored(child)) continue
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) pending.push(child)
      else if (entry.isFile()) files.set(child, path.join(root, child))
    }
  }
  return files
}

async function hashFiles(files) {
  const hashes = new Map()
  const problems = []
  for (const [relative, absolute] of files) {
    try {
      const buffer = await fsp.readFile(absolute)
      const raw = gitBlobHash(buffer)
      const norm = looksTextual(buffer)
        ? gitBlobHash(Buffer.from(buffer.toString('utf8').replace(/\r\n/g, '\n'), 'utf8'))
        : ''
      hashes.set(relative, hashOf(raw, norm === raw ? '' : norm))
    } catch (error) {
      problems.push(`${relative}: ${text(error)}`)
    }
  }
  return { hashes, problems }
}

/** GitHub：浅取一个 ref 到临时裸库，读 tree 里的 blob sha。不动用户的仓库。 */
async function remoteTree(repoUrl, ref, timeoutMs) {
  const temporary = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-guard-diff-'))
  try {
    const init = await runGit(['init', '--bare', '--quiet'], { cwd: temporary, timeoutMs })
    if (!init.ok) throw new Error(`git init 失败：${init.stderr.trim()}`)

    let wanted = String(ref ?? '').trim()
    if (wanted === '') {
      const symref = await runGit(['ls-remote', '--symref', repoUrl, 'HEAD'], { cwd: temporary, timeoutMs })
      if (!symref.ok) throw new Error(`读远端失败：${symref.stderr.trim()}`)
      const found = /^ref:\s+(\S+)\s+HEAD$/m.exec(symref.stdout)
      wanted = found ? found[1] : 'HEAD'
    }

    const fetched = await runGit(['fetch', '--quiet', '--depth=1', '--no-tags', repoUrl, wanted], { cwd: temporary, timeoutMs })
    if (!fetched.ok) throw new Error(`拉取失败：${fetched.stderr.trim()}`)

    const head = await runGit(['rev-parse', 'FETCH_HEAD'], { cwd: temporary, timeoutMs })
    if (!head.ok) throw new Error(`rev-parse 失败：${head.stderr.trim()}`)
    const commit = head.stdout.trim()

    const tree = await runGit(['ls-tree', '-r', '-z', commit], { cwd: temporary, timeoutMs })
    if (!tree.ok) throw new Error(`ls-tree 失败：${tree.stderr.trim()}`)

    const files = new Map()
    for (const record of tree.stdout.split('\0')) {
      if (record === '') continue
      const tab = record.indexOf('\t')
      if (tab < 0) continue
      const [mode, type, sha] = record.slice(0, tab).split(' ')
      if (type !== 'blob' || mode === '120000' || sha === undefined) continue
      const relative = record.slice(tab + 1)
      if (!isIgnored(relative)) files.set(relative, hashOf(sha))
    }
    return { ref: wanted, commit, files }
  } finally {
    await fsp.rm(temporary, { recursive: true, force: true }).catch(() => {})
  }
}

// ---------------------------------------------------------------------------
// 定位三份
// ---------------------------------------------------------------------------

/** 收集对象里所有 path 字段：DSH 的 workspace.json 就长这样。 */
function collectPaths(value, out = []) {
  if (Array.isArray(value)) {
    for (const item of value) collectPaths(item, out)
    return out
  }
  if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      if (key === 'path' && typeof item === 'string') out.push(item)
      else collectPaths(item, out)
    }
  }
  return out
}

async function workspaceRoots() {
  const roots = []
  const push = (value) => {
    if (typeof value !== 'string' || value.trim() === '') return
    const resolved = path.resolve(value)
    if (!roots.includes(resolved)) roots.push(resolved)
  }
  push(process.env.DSH_WORKSPACE)
  if (process.env.DSH_HOME) {
    const registry = path.join(process.env.DSH_HOME, 'storages', 'workspace.json')
    try {
      for (const entry of collectPaths(JSON.parse(await fsp.readFile(registry, 'utf8')))) push(entry)
    } catch {
      // 没有注册表就靠剩下几个候选
    }
  }
  push(path.join(os.homedir(), 'dsh-workspace'))
  push(process.cwd())
  return roots
}

async function findWorkspace(target) {
  const isPackage = async (dir) => {
    try {
      return JSON.parse(await fsp.readFile(path.join(dir, 'package.json'), 'utf8'))?.name === target
    } catch {
      return false
    }
  }
  for (const root of await workspaceRoots()) {
    const nested = path.join(root, target)
    if (fs.existsSync(path.join(nested, 'package.json'))) return nested
    // 候选目录本身可能就是包目录（在包里开 shell 时常见）
    if (await isPackage(root)) return root
  }
  return ''
}

async function findInstalled(target) {
  const roots = [process.env.DSH_PROFILE_DIR ? path.join(process.env.DSH_PROFILE_DIR, 'node_modules') : '']
  if (process.env.DSH_HOME) {
    const profiles = path.join(process.env.DSH_HOME, 'profiles')
    for (const entry of await fsp.readdir(profiles, { withFileTypes: true }).catch(() => [])) {
      if (entry.isDirectory()) roots.push(path.join(profiles, entry.name, 'node_modules'))
    }
  }
  for (const root of roots.filter(Boolean)) {
    const candidate = path.join(root, target)
    if (fs.existsSync(path.join(candidate, 'package.json'))) {
      return { dir: candidate, real: await fsp.realpath(candidate).catch(() => candidate) }
    }
  }
  return null
}

function normalizeRepoUrl(value) {
  let url = String(value ?? '').trim()
  if (url === '') return ''
  if (url.startsWith('git+')) url = url.slice(4)
  if (url.startsWith('github:')) url = `https://github.com/${url.slice(7)}`
  const scp = /^git@([^:]+):(.+)$/.exec(url)
  if (scp) url = `https://${scp[1]}/${scp[2]}`
  // 只有 URL 才去 .git 后缀；本地路径可能是 xxx.git 的裸库，去掉就打不开了。
  if (/^https?:\/\//i.test(url)) url = url.replace(/\.git$/, '')
  return url.replace(/\/+$/, '')
}

async function findRepo(workspaceDir) {
  try {
    const pkg = JSON.parse(await fsp.readFile(path.join(workspaceDir, 'package.json'), 'utf8'))
    const declared = normalizeRepoUrl(pkg?.repository?.url ?? pkg?.repository ?? '')
    if (declared !== '') return declared
  } catch {
    // 没有 package.json 就退回 git remote
  }
  const remote = await runGit(['-C', workspaceDir, 'remote', 'get-url', 'origin'], { cwd: workspaceDir })
  return remote.ok ? normalizeRepoUrl(remote.stdout.trim()) : ''
}

// ---------------------------------------------------------------------------
// 对比
// ---------------------------------------------------------------------------

function classify(workspace, github, installed) {
  const present = [workspace, github, installed].filter((value) => value !== undefined)
  if (present.length === 3) {
    const workspaceGithub = sameHash(workspace, github)
    const githubInstalled = sameHash(github, installed)
    if (workspaceGithub && githubInstalled) return 'same'
    if (!workspaceGithub && githubInstalled) return 'workspace-ahead'
    if (workspaceGithub && !githubInstalled) return 'installed-stale'
    if (sameHash(workspace, installed) && !githubInstalled) return 'github-stale'
    return 'differs'
  }
  if (present.length === 2) {
    if (workspace !== undefined && github !== undefined) return 'missing-installed'
    if (workspace !== undefined) return 'missing-github'
    return 'missing-workspace'
  }
  if (workspace !== undefined) return 'only-workspace'
  if (github !== undefined) return 'only-github'
  return 'only-installed'
}

function emptyReport(target) {
  return {
    ok: false,
    target,
    verdict: 'unknown',
    checkedAt: new Date().toISOString(),
    sources: {
      workspace: { state: 'missing', path: '', branch: '', head: '', dirty: null, files: 0 },
      github: { state: 'unknown', repo: '', ref: '', commit: '', files: 0 },
      installed: { state: 'missing', path: '', realPath: '', linked: false, files: 0 },
    },
    pairs: {},
    files: [],
    counts: { same: 0, differing: 0 },
    notes: [],
    errors: [],
  }
}

async function compare(target, { repo = '', ref = '' } = {}) {
  const report = emptyReport(target)
  if (!target) {
    report.errors.push({ source: 'input', message: '缺少目标包名' })
    return report
  }

  const workspaceDir = await findWorkspace(target)
  if (!workspaceDir) {
    report.errors.push({ source: 'workspace', message: `工作区里没有 ${target}（找过 DSH_WORKSPACE、~/dsh-workspace、当前目录）` })
  }
  const installed = await findInstalled(target)
  if (!installed) {
    report.errors.push({ source: 'installed', message: `profile 的 node_modules 里没有 ${target}` })
  }

  const workspaceHashes = new Map()
  if (workspaceDir) {
    const listed = await workspaceFiles(workspaceDir)
    const existing = new Map([...listed.files].filter(([, absolute]) => fs.existsSync(absolute)))
    // 有 git 就让它按提交时那套过滤器算哈希：行尾规范化不会变成假差异。
    const batched = listed.via === 'git' && existing.size > 0
      ? await hashObjects(workspaceDir, [...existing.keys()], 20000)
      : { ok: false, stdout: '' }
    if (batched.ok) {
      const lines = batched.stdout.trim() === '' ? [] : batched.stdout.trim().split('\n')
      if (lines.length === existing.size) {
        [...existing.keys()].forEach((relative, index) => workspaceHashes.set(relative, hashOf(lines[index].trim())))
      } else {
        const hashed = await hashFiles(existing)
        for (const [key, value] of hashed.hashes) workspaceHashes.set(key, value)
        report.notes.push(...hashed.problems)
      }
    } else {
      const hashed = await hashFiles(existing)
      for (const [key, value] of hashed.hashes) workspaceHashes.set(key, value)
      report.notes.push(...hashed.problems)
    }
    const head = await runGit(['-C', workspaceDir, 'rev-parse', '--short', 'HEAD'], { cwd: workspaceDir })
    const branch = await runGit(['-C', workspaceDir, 'rev-parse', '--abbrev-ref', 'HEAD'], { cwd: workspaceDir })
    const status = await runGit(['-C', workspaceDir, 'status', '--porcelain'], { cwd: workspaceDir })
    report.sources.workspace = {
      state: 'ok',
      path: workspaceDir,
      via: listed.via,
      branch: branch.ok ? branch.stdout.trim() : '',
      head: head.ok ? head.stdout.trim() : '',
      dirty: status.ok ? status.stdout.trim() !== '' : null,
      files: workspaceHashes.size,
    }
  }

  const installedHashes = new Map()
  if (installed) {
    const walked = await walkFiles(installed.real)
    const hashed = await hashFiles(walked)
    for (const [key, value] of hashed.hashes) installedHashes.set(key, value)
    report.notes.push(...hashed.problems)
    report.sources.installed = {
      state: 'ok',
      path: installed.dir,
      realPath: installed.real,
      linked: workspaceDir !== '' && (installed.real === workspaceDir || installed.real.startsWith(`${workspaceDir}${path.sep}`)),
      files: installedHashes.size,
    }
  }

  const repoUrl = repo !== '' ? normalizeRepoUrl(repo) : (workspaceDir ? await findRepo(workspaceDir) : '')
  report.sources.github.repo = repoUrl
  const githubHashes = new Map()
  if (repoUrl === '') {
    report.errors.push({ source: 'github', message: '没有仓库地址（package.json 的 repository 与 git remote 都为空）' })
  } else {
    try {
      const tree = await remoteTree(repoUrl, ref)
      for (const [key, value] of tree.files) githubHashes.set(key, value)
      report.sources.github = {
        state: 'ok',
        repo: repoUrl,
        ref: tree.ref,
        commit: tree.commit,
        files: githubHashes.size,
      }
    } catch (error) {
      report.sources.github = { ...report.sources.github, state: 'error' }
      report.errors.push({ source: 'github', message: text(error) })
    }
  }

  const union = new Set([...workspaceHashes.keys(), ...githubHashes.keys(), ...installedHashes.keys()])
  const rows = []
  let eolMatches = 0
  for (const relative of [...union].sort()) {
    const workspace = workspaceHashes.get(relative)
    const github = githubHashes.get(relative)
    const installedHash = installedHashes.get(relative)
    const status = classify(workspace, github, installedHash)
    const row = { path: relative, status, label: STATUS_LABELS[status], workspace, github, installed: installedHash }
    if (status === 'same') {
      if (!(workspace?.raw === github?.raw && github?.raw === installedHash?.raw)) eolMatches += 1
    } else {
      rows.push(row)
    }
    report.counts[status === 'same' ? 'same' : 'differing'] += 1
  }
  if (eolMatches > 0) report.notes.push(`${eolMatches} 个文件只在行尾（CRLF/LF）不同，按同一份内容处理`)

  report.pairs = {
    'workspace-github': summarise(workspaceHashes, githubHashes),
    'github-installed': summarise(githubHashes, installedHashes),
    'workspace-installed': summarise(workspaceHashes, installedHashes),
  }

  const driftStatuses = new Set([
    'differs',
    'workspace-ahead',
    'installed-stale',
    'github-stale',
    'only-installed',
    'only-github',
    'missing-workspace',
    'missing-github',
  ])
  const drift = rows.some((row) => driftStatuses.has(row.status))
  if (report.errors.length > 0) {
    report.verdict = 'unknown'
  } else if (drift) {
    report.verdict = 'drift'
  } else {
    // only-workspace / missing-installed 都是「仓库里有、但 npm 不会装进 DSH」的文件，
    // 例如 test/ 与 .gitignore：内容该一致，集合不同属正常。
    report.verdict = rows.length === 0 ? 'identical' : 'content-identical'
  }
  report.ok = report.verdict === 'identical'

  report.files = rows.slice(0, 200).map((row) => ({
    path: row.path,
    status: row.status,
    label: row.label,
    workspace: row.workspace?.raw.slice(0, 8) ?? '',
    github: row.github?.raw.slice(0, 8) ?? '',
    installed: row.installed?.raw.slice(0, 8) ?? '',
  }))
  if (rows.length > 200) report.notes.push(`另有 ${rows.length - 200} 个差异未列出`)
  if (report.sources.installed.linked) report.notes.push('安装副本就是工作区的链接（pnpm link），内容天然一致')
  if (workspaceDir && report.sources.workspace.dirty) {
    report.notes.push('工作区有未提交改动')
  }
  return report
}

function summarise(left, right) {
  let same = 0
  let differs = 0
  let onlyLeft = 0
  let onlyRight = 0
  for (const [key, value] of left) {
    const other = right.get(key)
    if (other === undefined) onlyLeft += 1
    else if (sameHash(value, other)) same += 1
    else differs += 1
  }
  for (const key of right.keys()) if (!left.has(key)) onlyRight += 1
  return { same, differs, onlyLeft, onlyRight }
}

/** 检查器：一个小 TTL 缓存，避免面板连点就把 GitHub 拉爆。 */
export function createIntegrityChecker({ log, ttlMs = 60000 } = {}) {
  const cache = new Map()
  const inflight = new Map()

  async function check(target, options = {}) {
    const name = String(target ?? '').trim()
    const key = `${name}\u0000${options.repo ?? ''}\u0000${options.ref ?? ''}`
    const hit = cache.get(key)
    if (!options.refresh && hit && Date.now() - hit.at < ttlMs) return { ...hit.report, cached: true }
    if (inflight.has(key)) return inflight.get(key)
    const running = compare(name, options)
      .catch((error) => {
        log?.warn?.('三份代码对比失败', text(error))
        return { ...emptyReport(name), errors: [{ source: 'internal', message: text(error) }] }
      })
      .then((report) => {
        cache.set(key, { at: Date.now(), report })
        return report
      })
      .finally(() => inflight.delete(key))
    inflight.set(key, running)
    return running
  }

  return { check, clearCache: () => cache.clear() }
}
