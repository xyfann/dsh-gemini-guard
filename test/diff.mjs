// 三份代码 diff 的测试：工作区 / GitHub / 已安装副本。
//
// 全部离线：远端用一个本地裸库扮演 GitHub，安装副本用目录复制。
// 跑：node test/diff.mjs
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { createIntegrityChecker } from '../integrity.js'

let failed = 0
function check(label, condition, detail) {
  if (condition) {
    console.log(`PASS  ${label}`)
    return
  }
  failed += 1
  console.log(`FAIL  ${label}${detail === undefined ? '' : ` -> ${detail}`}`)
}

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
  GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z',
  GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z',
}

const git = (cwd, args) => execFileSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8', stdio: 'pipe' })

const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-guard-diff-'))
const workspaceRoot = path.join(root, 'dsh-workspace')
const profileDir = path.join(root, 'profile')
const packageDir = path.join(workspaceRoot, 'dsh-demo')
const remoteDir = path.join(root, 'remote.git')
const installedDir = path.join(profileDir, 'node_modules', 'dsh-demo')

const write = async (file, text) => {
  await fsp.mkdir(path.dirname(file), { recursive: true })
  await fsp.writeFile(file, text)
}

const FILES = {
  'package.json': JSON.stringify({ name: 'dsh-demo', version: '1.0.0', main: 'index.js', files: ['index.js', 'README.md'] }, null, 2),
  'index.js': 'export const answer = 42\n',
  'README.md': '# demo\n',
  'test/a.mjs': '// not published\n',
}

await fsp.mkdir(packageDir, { recursive: true })
for (const [relative, text] of Object.entries(FILES)) await write(path.join(packageDir, relative), text)
await write(path.join(packageDir, '.gitignore'), 'node_modules\n')
git(packageDir, ['init', '--quiet', '-b', 'main'])
git(packageDir, ['add', '-A'])
git(packageDir, ['commit', '--quiet', '-m', 'init'])
git(root, ['clone', '--quiet', '--bare', packageDir, remoteDir])
git(packageDir, ['remote', 'add', 'origin', remoteDir])

/** 已安装副本 = 只复制 files 白名单里的文件（test/ 不该出现在 profile 里）。 */
async function installCopy() {
  await fsp.rm(installedDir, { recursive: true, force: true })
  for (const relative of ['package.json', 'index.js', 'README.md']) {
    await write(path.join(installedDir, relative), await fsp.readFile(path.join(packageDir, relative)))
  }
}
await installCopy()

process.env.DSH_WORKSPACE = workspaceRoot
process.env.DSH_PROFILE_DIR = profileDir

const checker = createIntegrityChecker({})
const diff = (options = {}) => checker.check('dsh-demo', { refresh: true, ...options })

// --- 1. 正常状态：发布内容一致，test/ 只在仓库里 -----------------------------
{
  const report = await diff()
  check('基线判定为 content-identical', report.verdict === 'content-identical', report.verdict)
  check('三个来源都读到了', Object.values(report.sources).every((source) => source.state === 'ok'), JSON.stringify(report.errors))
  check('GitHub 与安装副本：内容零差异，只差两个未发布文件',
    report.pairs['github-installed'].differs === 0
    && report.pairs['github-installed'].onlyRight === 0
    && report.pairs['github-installed'].onlyLeft === 2,
    JSON.stringify(report.pairs['github-installed']))
  check('未发布文件只报 missing-installed', report.files.every((row) => row.status === 'missing-installed'),
    JSON.stringify(report.files.map((row) => `${row.path}:${row.status}`)))
  check('GitHub 提交号可读', /^[0-9a-f]{40}$/.test(report.sources.github.commit), report.sources.github.commit)
}

// --- 2. 安装副本被改：内容不同 ----------------------------------------------
{
  await write(path.join(installedDir, 'index.js'), 'export const answer = 43\n')
  const report = await diff()
  check('安装副本被改 -> drift', report.verdict === 'drift', report.verdict)
  check('定位到 installed-stale', report.files.some((row) => row.path === 'index.js' && row.status === 'installed-stale'),
    JSON.stringify(report.files))
  await installCopy()
}

// --- 3. 安装副本多出源码里没有的文件 ----------------------------------------
{
  await write(path.join(installedDir, 'injected.js'), 'globalThis.pwned = true\n')
  const report = await diff()
  check('安装副本多文件 -> drift', report.verdict === 'drift', report.verdict)
  check('定位到 only-installed', report.files.some((row) => row.path === 'injected.js' && row.status === 'only-installed'),
    JSON.stringify(report.files))
  await fsp.rm(path.join(installedDir, 'injected.js'))
}

// --- 4. 工作区改了没提交 ----------------------------------------------------
{
  await write(path.join(packageDir, 'index.js'), 'export const answer = 44\n')
  const report = await diff()
  check('工作区未提交 -> drift', report.verdict === 'drift', report.verdict)
  check('定位到 workspace-ahead', report.files.some((row) => row.path === 'index.js' && row.status === 'workspace-ahead'),
    JSON.stringify(report.files))
  check('工作区 dirty 标记', report.sources.workspace.dirty === true, String(report.sources.workspace.dirty))

  // 提交并推上去、再重装：三份回到一致
  git(packageDir, ['add', '-A'])
  git(packageDir, ['commit', '--quiet', '-m', 'bump'])
  git(packageDir, ['push', '--quiet', 'origin', 'main'])
  await installCopy()
  const clean = await diff()
  check('推送并重装后回到 content-identical', clean.verdict === 'content-identical', clean.verdict)
}

// --- 5. 远端读不到：给 unknown，而不是假装 drift -----------------------------
{
  const report = await diff({ repo: path.join(root, 'missing.git') })
  check('远端不可达 -> unknown', report.verdict === 'unknown', report.verdict)
  check('错误里指出 github', report.errors.some((error) => error.source === 'github'), JSON.stringify(report.errors))
  check('仍能报出本地两份的差异计数', report.pairs['workspace-installed'].differs === 0,
    JSON.stringify(report.pairs['workspace-installed']))
}

// --- 6. 目标不存在 ----------------------------------------------------------
{
  const report = await checker.check('dsh-nope', { refresh: true })
  check('未知目标 -> unknown', report.verdict === 'unknown', report.verdict)
  check('错误覆盖工作区与安装副本', report.errors.length >= 2, JSON.stringify(report.errors))
}

await fsp.rm(root, { recursive: true, force: true })

console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`)
process.exitCode = failed === 0 ? 0 : 1
