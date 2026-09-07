const path = require('node:path');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');

const pkg = require('../../../package.json');
const { getAdapter, getSupportedPlatforms } = require('../adapters');
const {
  discoverChildGitRepos,
  findGitRoot,
} = require('./init');
const { defaultInitPlatforms } = require('./init-args');
const {
  clearCliVersionReminderCooldown,
} = require('../version-reminder');
const { runNpm } = require('../../../scripts/lib/npm-cli.cjs');
const { resolveUserLanguage } = require('../cli-lang');
const { detectColorSupport, renderFullArt } = require('../brand');

const PACKAGE_NAME = pkg.name;
const UPGRADE_COMMAND = `npm install -g ${PACKAGE_NAME}@latest`;
// 用户旅程文案双语；reason_code、npm 退出码等技术事实保留原文。
const UPDATE_MESSAGES = {
  zh: {
    upgrading: (command) => `正在通过以下命令升级 ${PACKAGE_NAME}: ${command}`,
    npmMissing: '无法运行 npm：PATH 上未找到 `npm`。',
    npmMissingFix: '请先安装 Node.js/npm（或用你自己的包管理器执行升级），然后重试。',
    upgradeFailed: (status) => `升级失败（npm 退出码 ${status}）。`,
    retryManually: (command) => `可手动重试: ${command}`,
    upgradedTo: (name, version) => `✅ ${name} 已升级到 v${version}。`,
    upgraded: (name) => `✅ ${name} 升级完成。`,
    refreshSkipped: 'Runtime 刷新：已跳过（无法安全确定刷新范围）。',
    refreshSkippedNoRuntime: 'Runtime 刷新：已跳过（本项目未安装 spec-first runtime assets）。update 只刷新已安装的宿主，不会替你安装新宿主；如需安装请运行 `spec-first init`。',
    refreshSkippedChildRuntimeOnly: (count) => `Runtime 刷新：已跳过（父 workspace 自身未安装 runtime，但有 ${count} 个子仓库各自装有 runtime）。update 不会跨仓库代为安装，请按下方命令逐个刷新。`,
    refreshSkippedStatelessRuntime: (roots) => `Runtime 刷新：已跳过（检测到 ${roots} 目录存在，但其中的 spec-first state.json 缺失，无法确认已安装哪些宿主）。这通常是 init 中断或 state.json 被删除；请按下方命令显式指定宿主重装。`,
    refreshing: (command) => `正在刷新 runtime assets: ${command}`,
    refreshDegraded: (reason) => `Runtime 刷新：降级（${reason}）。`,
    refreshDegradedMissingCli: 'Runtime 刷新：降级（升级后在 PATH 上找不到 `spec-first`）。',
    refreshDegradedExit: (status) => `Runtime 刷新：降级（spec-first init 退出码 ${status}）。`,
    refreshCompleted: 'Runtime 刷新完成。',
    pluginNote1: '注意：如果你是以 Claude Code plugin（而非 npm -g）方式安装 spec-first，',
    pluginNote2: '请改用 `claude plugin update` 升级——npm -g 管理的是另一份副本。',
  },
  en: {
    upgrading: (command) => `Upgrading ${PACKAGE_NAME} via: ${command}`,
    npmMissing: 'Could not run npm: `npm` was not found on your PATH.',
    npmMissingFix: 'Install Node.js/npm (or run the upgrade with your own package manager), then retry.',
    upgradeFailed: (status) => `Upgrade failed (npm exited with code ${status}).`,
    retryManually: (command) => `You can retry manually with: ${command}`,
    upgradedTo: (name, version) => `✅ ${name} upgraded to v${version}.`,
    upgraded: (name) => `✅ ${name} upgraded.`,
    refreshSkipped: 'Runtime refresh: skipped (scope could not be determined safely).',
    refreshSkippedNoRuntime: 'Runtime refresh: skipped (no spec-first runtime assets are installed in this project). update refreshes installed hosts only and never installs a new one — run `spec-first init` to install.',
    refreshSkippedChildRuntimeOnly: (count) => `Runtime refresh: skipped (this parent workspace has no runtime of its own, but ${count} child repo(s) have their own). update never installs across repos — refresh each with the commands below.`,
    refreshSkippedStatelessRuntime: (roots) => `Runtime refresh: skipped (${roots} exist but their spec-first state.json is missing, so the installed host set cannot be confirmed). This usually means init was interrupted or state.json was deleted — reinstall with an explicit host using the commands below.`,
    refreshing: (command) => `Refreshing runtime assets via: ${command}`,
    refreshDegraded: (reason) => `Runtime refresh: degraded (${reason}).`,
    refreshDegradedMissingCli: 'Runtime refresh: degraded (`spec-first` was not found on PATH after upgrade).',
    refreshDegradedExit: (status) => `Runtime refresh: degraded (spec-first init exited with code ${status}).`,
    refreshCompleted: 'Runtime refresh completed.',
    pluginNote1: 'Note: if you installed spec-first as a Claude Code plugin (not via npm -g),',
    pluginNote2: '  upgrade it with `claude plugin update` instead — npm -g manages a separate copy.',
  },
};


/**
 * `spec-first update` — 实际执行 CLI 包升级。
 *
 * 设计边界(见 docs/plans/2026-06-12-003-feat-update-perform-upgrade-plan.md):
 * - 无条件直跑 `npm install -g spec-first@latest`:不查版本、不检测安装方式。
 *   npm 自身幂等,已是最新会自动 no-op。
 * - 升级成功后启动 fresh `spec-first init` 子进程刷新本地 runtime,避免旧进程
 *   直接跑新生成逻辑的版本错位。
 * - 已知风险(用户确认接受):非 npm-global 安装(Claude plugin / pnpm / volta 等)
 *   会被装出冲突副本;以一条静态 caveat 提示缓解,不做分支检测。
 * - 刷新范围只覆盖本项目已安装的宿主。探测不到已装 runtime 时不刷新、不安装,
 *   打印 fallback 命令后仍以 0 退出(升级本身成功);安装是 `spec-first init` 的职责。
 * - 退出码:0=升级成功(含无可刷新目标而跳过);1=升级失败或刷新已尝试但失败;2=用法错误。
 */
async function runUpdate(argv, deps = {}) {
  const args = [...argv];

  if (args.includes('-h') || args.includes('--help')) {
    printHelp();
    return 0;
  }

  // `--json` / `--claude` / `--codex` 等旧 check-only flag 已移除,视为用法错误。
  if (args.length > 0) {
    console.error(`Usage: spec-first update [-h|--help]`);
    return 2;
  }

  const runInstall = deps.runInstall || defaultRunInstall;
  const runRuntimeRefresh = deps.runRuntimeRefresh || defaultRunRuntimeRefresh;
  const resolveRuntimeRefresh = deps.resolveRuntimeRefreshCommand || resolveRuntimeRefreshCommand;
  const resolveInstalledCli = deps.resolveInstalledCliPath || resolveInstalledCliPath;
  const clearVersionReminderCooldown = deps.clearVersionReminderCooldown || clearCliVersionReminderCooldown;
  const cwd = deps.cwd || process.cwd();
  const messages = UPDATE_MESSAGES[
    (deps.resolveLang || resolveUserLanguage)() === 'en' ? 'en' : 'zh'
  ];

  // 更新入口展示完整 logo：版本升级是低频、值得仪式感的时刻。
  console.log(renderFullArt(pkg.version, { useColor: detectColorSupport() }).trimEnd());
  console.log(messages.upgrading(UPGRADE_COMMAND));
  console.log('');

  const result = runInstall();

  if (result && result.errorCode === 'ENOENT') {
    console.error('');
    console.error(messages.npmMissing);
    console.error(messages.npmMissingFix);
    return 1;
  }

  if (!result || result.status !== 0) {
    const status = result && Number.isInteger(result.status) ? result.status : 1;
    console.error('');
    console.error(messages.upgradeFailed(status));
    console.error(messages.retryManually(UPGRADE_COMMAND));
    return status || 1;
  }

  console.log('');
  // 升级后解析一次全局安装位置：既用于新版本展示，也供 runtime refresh
  // 复用（避免重复执行 npm root -g）。
  const installedCli = resolveInstalledCli();
  const installedVersion = readInstalledVersion(installedCli && installedCli.cliPath);
  console.log(installedVersion
    ? messages.upgradedTo(PACKAGE_NAME, installedVersion)
    : messages.upgraded(PACKAGE_NAME));
  const refresh = resolveRuntimeRefresh(cwd);
  if (!refresh || !Array.isArray(refresh.args)) {
    console.log(resolveRefreshSkippedMessage(messages, refresh));
    printRuntimeRefreshFallback(refresh);
  } else {
    if (!installedCli || !installedCli.ok || !installedCli.cliPath) {
      const reasonCode = installedCli && installedCli.reason_code
        ? installedCli.reason_code
        : 'global-package-cli-unresolved';
      console.error('');
      console.error(messages.refreshDegraded(reasonCode));
      printRuntimeRefreshFallback(refresh);
      return 1;
    }
    console.log(messages.refreshing(formatSpecFirstCommand(refresh.args)));
    const refreshResult = runRuntimeRefresh(refresh.args, {
      cwd: refresh.cwd || cwd,
      cliPath: installedCli.cliPath,
    });
    if (refreshResult && refreshResult.errorCode === 'ENOENT') {
      console.error('');
      console.error(messages.refreshDegradedMissingCli);
      printRuntimeRefreshFallback(refresh);
      return 1;
    }
    if (!refreshResult || refreshResult.status !== 0) {
      const status = refreshResult && Number.isInteger(refreshResult.status) ? refreshResult.status : 1;
      console.error('');
      console.error(messages.refreshDegradedExit(status));
      printRuntimeRefreshFallback(refresh);
      return 1;
    }
    console.log(messages.refreshCompleted);
  }
  console.log('');
  console.log(messages.pluginNote1);
  console.log(messages.pluginNote2);
  try {
    clearVersionReminderCooldown();
  } catch {
    // 缓存清理失败不能把成功升级变成失败命令。
  }
  return 0;
}

// 从已解析的全局 cli 路径（bin/spec-first.js）读安装清单中的新版本号；
// 纯文件读取、可注入、不重复执行 npm root -g（全局根已由
// resolveInstalledCliPath 解析一次）。读取失败静默回退旧措辞——
// 版本展示是增强信息，不构成升级流程的一部分。
function readInstalledVersion(cliPath, options = {}) {
  try {
    if (!cliPath) return '';
    const readFileSync = options.readFileSync || fs.readFileSync;
    const manifestPath = path.resolve(path.dirname(path.dirname(cliPath)), 'package.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    return typeof manifest.version === 'string' ? manifest.version : '';
  } catch (_error) {
    return '';
  }
}

// 默认 install 执行器:跨平台调用 npm,stdio 直通让 npm 进度直达用户。
// 返回 { status, errorCode },便于测试注入替身。
// Node >=20.12 (CVE-2024-27980) 拒绝 shell:false 下 spawn `.cmd`,直接 spawn `npm.cmd` 会 EINVAL;
// 复用仓库既有的 npm CLI JavaScript resolver,统一走 `node npm-cli.js`。
function defaultRunInstall() {
  try {
    const result = runNpm(['install', '-g', `${PACKAGE_NAME}@latest`], { stdio: 'inherit' });
    return {
      status: result.status,
      errorCode: result.error ? result.error.code : null,
    };
  } catch (error) {
    return {
      status: typeof error.status === 'number' ? error.status : 1,
      errorCode: error.code || 'npm-cli-unresolved',
    };
  }
}

// 同上:不按 PATH 猜 `spec-first.cmd`,直接用当前 Node 执行刚升级的 global package bin。
function defaultRunRuntimeRefresh(args, options = {}) {
  if (!options.cliPath) {
    return { status: 1, errorCode: 'global-package-cli-unresolved' };
  }
  const result = spawnSync(process.execPath, [options.cliPath, ...args], {
    cwd: options.cwd || process.cwd(),
    stdio: 'inherit',
    windowsHide: true,
  });
  return {
    status: result.status,
    errorCode: result.error ? result.error.code : null,
  };
}

function resolveInstalledCliPath(options = {}) {
  const runNpmCommand = options.runNpm || runNpm;
  let result;
  try {
    result = runNpmCommand(['root', '-g'], { encoding: 'utf8' });
  } catch (_error) {
    return { ok: false, cliPath: null, reason_code: 'global-npm-root-unavailable' };
  }
  if (!result || result.error || result.status !== 0) {
    return { ok: false, cliPath: null, reason_code: 'global-npm-root-unavailable' };
  }
  const globalRoot = String(result.stdout || '').trim();
  if (!globalRoot) {
    return { ok: false, cliPath: null, reason_code: 'global-npm-root-empty' };
  }
  return resolvePackageCliFromGlobalRoot(globalRoot, options);
}

function resolvePackageCliFromGlobalRoot(globalRoot, options = {}) {
  const existsSync = options.existsSync || fs.existsSync;
  const readFileSync = options.readFileSync || fs.readFileSync;
  const statSync = options.statSync || fs.statSync;
  const packageRoot = path.resolve(globalRoot, ...PACKAGE_NAME.split('/'));
  const manifestPath = path.join(packageRoot, 'package.json');
  if (!existsSync(manifestPath)) {
    return { ok: false, cliPath: null, reason_code: 'global-package-manifest-missing' };
  }
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (_error) {
    return { ok: false, cliPath: null, reason_code: 'global-package-manifest-invalid' };
  }
  if (!manifest || manifest.name !== PACKAGE_NAME) {
    return { ok: false, cliPath: null, reason_code: 'global-package-identity-mismatch' };
  }
  const binEntry = typeof manifest.bin === 'string'
    ? manifest.bin
    : manifest.bin && typeof manifest.bin === 'object'
      ? manifest.bin[PACKAGE_NAME]
      : null;
  if (typeof binEntry !== 'string' || !binEntry || path.isAbsolute(binEntry) || path.win32.isAbsolute(binEntry)) {
    return { ok: false, cliPath: null, reason_code: 'global-package-bin-invalid' };
  }
  const cliPath = path.resolve(packageRoot, binEntry);
  if (!isPathWithin(packageRoot, cliPath)) {
    return { ok: false, cliPath: null, reason_code: 'global-package-bin-outside-package' };
  }
  try {
    if (!statSync(cliPath).isFile()) {
      return { ok: false, cliPath: null, reason_code: 'global-package-bin-not-file' };
    }
  } catch (_error) {
    return { ok: false, cliPath: null, reason_code: 'global-package-bin-missing' };
  }
  return {
    ok: true,
    cliPath,
    globalRoot: path.resolve(globalRoot),
    reason_code: 'global-package-cli-resolved',
  };
}

function isPathWithin(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function resolveRuntimeRefreshCommand(cwd = process.cwd()) {
  const root = path.resolve(cwd);
  // 必须用 findGitRoot 的返回值:从子目录执行时 cwd 不是 repo root,platform detection 会一律为空并
  // 静默回落到 `init -y` 默认宿主,反而制造本步骤要修的 drift。
  const gitRoot = findGitRoot(root);
  if (gitRoot) {
    const platforms = detectInstalledRuntimePlatforms(gitRoot);
    if (platforms.length === 0) {
      const statelessRuntimeRoots = detectStatelessRuntimeRoots(gitRoot);
      return {
        args: null,
        cwd: gitRoot,
        reason_code: statelessRuntimeRoots.length > 0
          ? 'installed-runtime-stateless'
          : 'installed-runtime-absent',
        ...(statelessRuntimeRoots.length > 0
          ? { stateless_runtime_roots: statelessRuntimeRoots }
          : {}),
      };
    }
    return {
      args: buildRuntimeRefreshArgsForPlatforms(platforms),
      cwd: gitRoot,
      reason_code: 'single-git-repo',
    };
  }

  const childRepos = discoverChildGitRepos(root);
  if (childRepos.length > 0) {
    // 父 workspace 自身装了 host runtime 时按父范围刷新。
    const parentPlatforms = detectInstalledRuntimePlatforms(root);
    if (parentPlatforms.length > 0) {
      return {
        args: buildRuntimeRefreshArgsForPlatforms(parentPlatforms),
        cwd: root,
        reason_code: 'parent-workspace',
        child_repo_count: childRepos.length,
      };
    }
    // 父自身没装 runtime 时不得代表 child 执行 --all-repos:那会把某个 child 的宿主
    // 装进从未安装过的兄弟仓库。改为报告各 child 的自有宿主,由 fallback 输出
    // 逐仓库命令,让用户显式决定。
    const childRuntimeRepos = childRepos
      .map((repo) => ({
        git_root: repo.git_root,
        workspace_relative_path: repo.workspace_relative_path,
        platforms: detectInstalledRuntimePlatforms(repo.git_root),
      }))
      .filter((entry) => entry.platforms.length > 0);
    return {
      args: null,
      cwd: root,
      reason_code: childRuntimeRepos.length > 0
        ? 'child-repo-runtime-only'
        : 'installed-runtime-absent',
      child_repo_count: childRepos.length,
      child_runtime_repos: childRuntimeRepos,
    };
  }

  return {
    args: null,
    cwd: root,
    reason_code: 'scope-undetermined',
  };
}

function buildRuntimeRefreshArgs(root) {
  const platforms = detectInstalledRuntimePlatforms(root);
  return buildRuntimeRefreshArgsForPlatforms(platforms);
}

// 返回 null 表示"没有可刷新的宿主",由调用方走 skip + fallback 路径。
// 绝不能回落成无 host flag 的 `init -y`:那会安装 -y 默认宿主(claude+codex),
// 把"刷新已装 runtime"变成"安装用户从未选择的宿主"。
function buildRuntimeRefreshArgsForPlatforms(platforms, targetArgs = []) {
  if (!Array.isArray(platforms) || platforms.length === 0) {
    return null;
  }
  return ['init', ...platforms.map((platform) => `--${platform}`), ...targetArgs, '-y'];
}

// state.json 是宿主已安装的判据,但 runtime 根目录可能在 state.json 缺失时仍然存在
// (init 中断、用户手删)。此时"没有可刷新的宿主"成立,但不能对用户声称"未安装",
// 否则他会看着满是受管目录的 .claude/ 怀疑命令在说谎。
function detectStatelessRuntimeRoots(root) {
  const stateless = [];
  for (const platform of getSupportedPlatforms()) {
    const adapter = getAdapter(platform);
    const stateFile = path.join(root, adapter.stateFile);
    if (fs.existsSync(stateFile)) {
      continue;
    }
    const runtimeRoot = adapter.stateFile.split('/')[0];
    if (!runtimeRoot || stateless.includes(runtimeRoot)) {
      continue;
    }
    if (fs.existsSync(path.join(root, runtimeRoot))) {
      stateless.push(runtimeRoot);
    }
  }
  return stateless;
}

function detectInstalledRuntimePlatforms(root) {
  return detectInstalledRuntimePlatformsInRoots([root]);
}

function detectInstalledRuntimePlatformsInRoots(roots) {
  const installed = new Set();
  for (const root of roots) {
    for (const platform of getSupportedPlatforms()) {
      const adapter = getAdapter(platform);
      if (fs.existsSync(path.join(root, adapter.stateFile))) {
        installed.add(platform);
      }
    }
  }
  return getSupportedPlatforms()
    .filter((platform) => installed.has(platform));
}

// 跳过刷新有三种成因,措辞必须分开:未安装 runtime、父 workspace 只有 child 装了
// runtime、无法确定范围。混用一句会把"我不给你装"误读成"我失败了"。
function resolveRefreshSkippedMessage(messages, refresh = {}) {
  const reasonCode = refresh && refresh.reason_code;
  if (reasonCode === 'installed-runtime-absent') {
    return messages.refreshSkippedNoRuntime;
  }
  if (reasonCode === 'installed-runtime-stateless') {
    const roots = Array.isArray(refresh.stateless_runtime_roots)
      ? refresh.stateless_runtime_roots
      : [];
    return messages.refreshSkippedStatelessRuntime(roots.join(', '));
  }
  if (reasonCode === 'child-repo-runtime-only') {
    const childRuntimeRepos = Array.isArray(refresh.child_runtime_repos)
      ? refresh.child_runtime_repos
      : [];
    return messages.refreshSkippedChildRuntimeOnly(childRuntimeRepos.length);
  }
  return messages.refreshSkipped;
}

function printRuntimeRefreshFallback(refresh = {}) {
  const args = Array.isArray(refresh.args) ? refresh.args : null;
  const childRuntimeRepos = Array.isArray(refresh.child_runtime_repos)
    ? refresh.child_runtime_repos
    : [];
  // 已知每个 child 自有的宿主时,给出精确的逐仓库命令,而不是让用户自己拼
  // `--repo <path>` 占位符。
  // 未安装 runtime 时,指引必须是"显式选宿主安装",不能是 `init -y`——后者正是
  // 会装 -y 默认宿主的命令,与本命令不代为安装的契约冲突。
  // 没有已知刷新范围时,不能推荐 `init -y`:它安装 -y 默认宿主,正是本命令拒绝代做的事。
  // 统一给出显式选宿主与交互两条路径。
  if (!args && childRuntimeRepos.length === 0) {
    console.error('Install commands:');
    const suggestedHosts = defaultInitPlatforms();
    const installArgs = suggestedHosts.length > 0
      ? buildRuntimeRefreshArgsForPlatforms(suggestedHosts)
      : null;
    if (installArgs) {
      console.error(`  Pick hosts explicitly: ${formatSpecFirstCommand(withDeveloperPlaceholder(installArgs))}`);
    }
    console.error('  Or choose interactively: spec-first init');
    return;
  }
  if (!args && childRuntimeRepos.length > 0) {
    console.error('Fallback commands:');
    for (const entry of childRuntimeRepos) {
      const target = entry.workspace_relative_path || entry.git_root;
      const perChildArgs = insertInitTargetArgs(
        buildRuntimeRefreshArgsForPlatforms(entry.platforms),
        ['--repo', target],
      );
      console.error(`  Child repo: ${formatSpecFirstCommand(withDeveloperPlaceholder(perChildArgs))}`);
    }
    return;
  }
  // 到此处 args 必然非空:上面两个 guard 已覆盖所有 !args 情形并 return。
  // 不再保留 `['init','-y']` 回落——那是本次修复要消灭的静默安装命令。
  const singleArgs = stripInitTargetArgs(args);
  const parentArgs = args;
  const childArgs = insertInitTargetArgs(stripInitTargetArgs(args), ['--repo', '<path>']);
  console.error('Fallback commands:');
  console.error(`  Single repo: ${formatSpecFirstCommand(withDeveloperPlaceholder(singleArgs))}`);
  console.error(`  Parent workspace: ${formatSpecFirstCommand(withDeveloperPlaceholder(parentArgs))}`);
  console.error(`  Child repo: ${formatSpecFirstCommand(withDeveloperPlaceholder(childArgs))}`);
}

function stripInitTargetArgs(args) {
  const output = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--all-repos') {
      continue;
    }
    if (arg === '--repo') {
      index += 1;
      continue;
    }
    if (arg.startsWith('--repo=')) {
      continue;
    }
    output.push(arg);
  }
  return output;
}

function insertInitTargetArgs(args, targetArgs) {
  const output = [...args];
  const yesIndex = output.findIndex((arg) => arg === '-y' || arg === '--yes');
  const insertAt = yesIndex >= 0 ? yesIndex : output.length;
  output.splice(insertAt, 0, ...targetArgs);
  return output;
}

function withDeveloperPlaceholder(args) {
  if (!Array.isArray(args)) return ['init', '-y', '-u', '<name>'];
  if (args.includes('-u') || args.includes('--user')) return args;
  const output = [...args];
  const yesIndex = output.findIndex((arg) => arg === '-y' || arg === '--yes');
  const insertAt = yesIndex >= 0 ? yesIndex + 1 : output.length;
  output.splice(insertAt, 0, '-u', '<name>');
  return output;
}

function formatSpecFirstCommand(args) {
  return `spec-first ${args.join(' ')}`;
}

function printHelp() {
  console.log([
    '🔄 spec-first update — upgrade the spec-first CLI package',
    '',
    `Runs \`${UPGRADE_COMMAND}\` to upgrade the globally installed spec-first CLI,`,
    'then runs a fresh `spec-first init` subprocess to refresh this project\'s runtime assets.',
    'Only hosts already installed in this project are refreshed; update never installs a new host.',
    'If there is nothing to refresh or scope cannot be determined safely, it prints copy-ready',
    'fallback init commands instead of guessing.',
    '',
    '📘 Usage:',
    '  spec-first update',
    '',
    '⚙️  Options:',
    '  -h, --help      Show help',
    '',
    '🔢 Exit codes:',
    '  0  upgrade succeeded and runtime refresh completed, or refresh was skipped with fallback',
    '     guidance (including when this project has no installed runtime to refresh)',
    '  1  upgrade failed or automatic runtime refresh failed',
    '  2  usage error (unexpected argument)',
    '',
    'Note: this upgrades the npm-installed spec-first package. If you use spec-first as a',
    'Claude Code plugin, upgrade it with `claude plugin update` inside Claude Code instead —',
    'npm -g manages a separate copy.',
    '',
    'Per-requirement multi-repo graphs are not rebuilt by `update`. After upgrading, re-run',
    '`spec-runtime-setup --only codegraph,graphify --workspace-graph` from the requirement folder',
    'to rebuild graphs, or `spec-first clean --workspace-graph` to remove managed graph assets.',
    '',
    '🔗 Repository:',
    '  https://github.com/sunrain520/spec-first',
  ].join('\n'));
}

module.exports = {
  buildRuntimeRefreshArgs,
  buildRuntimeRefreshArgsForPlatforms,
  detectInstalledRuntimePlatforms,
  insertInitTargetArgs,
  readInstalledVersion,
  resolveInstalledCliPath,
  resolvePackageCliFromGlobalRoot,
  resolveRuntimeRefreshCommand,
  runUpdate,
  stripInitTargetArgs,
  withDeveloperPlaceholder,
};
