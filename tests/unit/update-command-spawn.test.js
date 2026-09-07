'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..', '..');

// Node >=20.12 (CVE-2024-27980) refuses to spawn a `.cmd` shim with shell:false, so naming
// `npm.cmd` / `spec-first.cmd` directly makes these paths unusable on Windows. Both must go
// through an explicit Node interpreter instead.
describe('spec-first update spawns without .cmd shims', () => {
  function loadUpdateWithSpawnSpy() {
    jest.resetModules();
    const calls = [];
    jest.doMock('node:child_process', () => ({
      ...jest.requireActual('node:child_process'),
      spawnSync: (command, args, options) => {
        calls.push({ command, args, options });
        return { status: 0, error: null };
      },
    }));
    return { calls, update: require('../../src/cli/commands/update') };
  }

  afterEach(() => {
    jest.dontMock('node:child_process');
    jest.resetModules();
  });

  test('the global install runs npm through the shared Node CLI resolver', async () => {
    const { calls, update } = loadUpdateWithSpawnSpy();

    await update.runUpdate([], {
      runRuntimeRefresh: () => ({ status: 0, errorCode: null }),
      resolveRuntimeRefreshCommand: () => ({ args: ['init', '-y'], cwd: repoRoot, reason_code: 'test' }),
      resolveInstalledCliPath: () => ({ ok: true, cliPath: '/global/spec-first/bin/spec-first.js' }),
      clearVersionReminderCooldown: () => {},
    });

    expect(calls).toHaveLength(1);
    const [installCall] = calls;
    expect(installCall.command).toBe(process.execPath);
    expect(path.basename(installCall.args[0])).toBe('npm-cli.js');
    expect(installCall.args.slice(1)).toEqual(['install', '-g', 'spec-first@latest']);
    expect(calls.some((call) => String(call.command).endsWith('.cmd'))).toBe(false);
  });

  test('the runtime refresh runs the upgraded global package bin through Node instead of the invoking checkout', async () => {
    const { calls, update } = loadUpdateWithSpawnSpy();
    const globalCliPath = path.join(os.tmpdir(), 'global-node_modules', 'spec-first', 'bin', 'spec-first.js');

    await update.runUpdate([], {
      resolveRuntimeRefreshCommand: () => ({
        args: ['init', '--claude', '-y'],
        cwd: repoRoot,
        reason_code: 'test',
      }),
      resolveInstalledCliPath: () => ({
        ok: true,
        cliPath: globalCliPath,
        reason_code: 'global-package-cli-resolved',
      }),
      clearVersionReminderCooldown: () => {},
    });

    const refreshCall = calls.find((call) => Array.isArray(call.args) && call.args.includes('init'));
    expect(refreshCall).toBeDefined();
    expect(refreshCall.command).toBe(process.execPath);
    expect(refreshCall.args[0]).toBe(globalCliPath);
    expect(refreshCall.args.slice(1)).toEqual(['init', '--claude', '-y']);
    expect(refreshCall.args[0]).not.toBe(path.join(repoRoot, 'bin', 'spec-first.js'));
    expect(calls.some((call) => String(call.command).endsWith('.cmd'))).toBe(false);
  });

  test('an unresolved global CLI degrades without running the stale checkout or claiming refresh completion', async () => {
    const { update } = loadUpdateWithSpawnSpy();
    const runRuntimeRefresh = jest.fn(() => ({ status: 0, errorCode: null }));
    const logs = [];
    const errors = [];
    const logSpy = jest.spyOn(console, 'log').mockImplementation((message = '') => logs.push(String(message)));
    const errorSpy = jest.spyOn(console, 'error').mockImplementation((message = '') => errors.push(String(message)));
    try {
      const exitCode = await update.runUpdate([], {
        runInstall: () => ({ status: 0, errorCode: null }),
        runRuntimeRefresh,
        resolveRuntimeRefreshCommand: () => ({ args: ['init', '-y'], cwd: repoRoot, reason_code: 'test' }),
        resolveInstalledCliPath: () => ({ ok: false, reason_code: 'global-package-cli-unresolved' }),
        clearVersionReminderCooldown: () => {},
        // 显式语言注入：断言锁英文消息，不依赖执行机器的全局 developer profile。
        resolveLang: () => 'en',
      });

      expect(exitCode).toBe(1);
      expect(runRuntimeRefresh).not.toHaveBeenCalled();
      expect(logs).not.toContain('Runtime refresh completed.');
      expect(errors.join('\n')).toContain('global-package-cli-unresolved');
    } finally {
      logSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });
});

// The refresh must target the repository root. Running it against the invocation cwd made
// platform detection come back empty in any subdirectory, which silently downgraded the refresh
// to `init -y` and installed default hosts the user never selected.
describe('spec-first update resolves the refresh target from the git root', () => {
  function initRepoWithSubdir(platform) {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'spec-first-update-root-')));
    fs.mkdirSync(path.join(root, '.git'), { recursive: true });
    const { getAdapter } = require('../../src/cli/adapters');
    const stateFile = path.join(root, getAdapter(platform).stateFile);
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    fs.writeFileSync(stateFile, JSON.stringify({ platform }), 'utf8');
    const subdir = path.join(root, 'packages', 'nested');
    fs.mkdirSync(subdir, { recursive: true });
    return { root, subdir };
  }

  test('detects the installed host when invoked from a subdirectory', () => {
    const { resolveRuntimeRefreshCommand } = require('../../src/cli/commands/update');
    const { root, subdir } = initRepoWithSubdir('claude');

    const resolved = resolveRuntimeRefreshCommand(subdir);

    expect(resolved.reason_code).toBe('single-git-repo');
    expect(resolved.cwd).toBe(root);
    expect(resolved.args).toEqual(['init', '--claude', '-y']);
    expect(resolved.args).not.toEqual(['init', '-y']);
  });

  test('still resolves the git root when invoked at the root itself', () => {
    const { resolveRuntimeRefreshCommand } = require('../../src/cli/commands/update');
    const { root } = initRepoWithSubdir('codex');

    const resolved = resolveRuntimeRefreshCommand(root);

    expect(resolved.cwd).toBe(root);
    expect(resolved.args).toEqual(['init', '--codex', '-y']);
  });
});

describe('spec-first update resolves the upgraded global package entry', () => {
  test('validates package identity and resolves the declared bin under npm root -g', () => {
    const { resolvePackageCliFromGlobalRoot } = require('../../src/cli/commands/update');
    const globalRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'spec-first-global-root-')));
    const packageRoot = path.join(globalRoot, 'spec-first');
    const cliPath = path.join(packageRoot, 'bin', 'spec-first.js');
    fs.mkdirSync(path.dirname(cliPath), { recursive: true });
    fs.writeFileSync(path.join(packageRoot, 'package.json'), JSON.stringify({
      name: 'spec-first',
      bin: { 'spec-first': 'bin/spec-first.js' },
    }), 'utf8');
    fs.writeFileSync(cliPath, '#!/usr/bin/env node\n', 'utf8');

    try {
      expect(resolvePackageCliFromGlobalRoot(globalRoot)).toEqual(expect.objectContaining({
        ok: true,
        cliPath,
        reason_code: 'global-package-cli-resolved',
      }));
    } finally {
      fs.rmSync(globalRoot, { recursive: true, force: true });
    }
  });

  test('rejects a global package manifest whose bin escapes the package root', () => {
    const { resolvePackageCliFromGlobalRoot } = require('../../src/cli/commands/update');
    const globalRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'spec-first-global-root-')));
    const packageRoot = path.join(globalRoot, 'spec-first');
    fs.mkdirSync(packageRoot, { recursive: true });
    fs.writeFileSync(path.join(packageRoot, 'package.json'), JSON.stringify({
      name: 'spec-first',
      bin: { 'spec-first': '../stale-checkout.js' },
    }), 'utf8');

    try {
      expect(resolvePackageCliFromGlobalRoot(globalRoot)).toEqual({
        ok: false,
        cliPath: null,
        reason_code: 'global-package-bin-outside-package',
      });
    } finally {
      fs.rmSync(globalRoot, { recursive: true, force: true });
    }
  });
});

// `update` refreshes runtime assets; it must never install a host the project never had.
// The zero-detected-platform fallback used to emit a bare `init -y`, which installs the
// `-y` default hosts (claude+codex), and the parent-workspace branch emitted `--all-repos`,
// which spread a child's host into sibling repos that never had it.
describe('spec-first update never installs a host that was not already present', () => {
  const tempRoots = [];

  function makeRepo(platforms = []) {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'spec-first-update-scope-')));
    tempRoots.push(root);
    fs.mkdirSync(path.join(root, '.git'), { recursive: true });
    writePlatformState(root, platforms);
    return root;
  }

  function makeWorkspace({ parentPlatforms = [], children = {} } = {}) {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'spec-first-update-ws-')));
    tempRoots.push(root);
    writePlatformState(root, parentPlatforms);
    const childRoots = {};
    for (const [name, platforms] of Object.entries(children)) {
      const childRoot = path.join(root, name);
      fs.mkdirSync(path.join(childRoot, '.git'), { recursive: true });
      writePlatformState(childRoot, platforms);
      childRoots[name] = childRoot;
    }
    return { root, childRoots };
  }

  function writePlatformState(root, platforms) {
    const { getAdapter } = require('../../src/cli/adapters');
    for (const platform of platforms) {
      const stateFile = path.join(root, getAdapter(platform).stateFile);
      fs.mkdirSync(path.dirname(stateFile), { recursive: true });
      fs.writeFileSync(stateFile, JSON.stringify({ platform }), 'utf8');
    }
  }

  afterEach(() => {
    while (tempRoots.length > 0) {
      fs.rmSync(tempRoots.pop(), { recursive: true, force: true });
    }
  });

  test('a git repo with no installed runtime yields no refresh command instead of init -y', () => {
    const { resolveRuntimeRefreshCommand } = require('../../src/cli/commands/update');
    const root = makeRepo([]);

    const resolved = resolveRuntimeRefreshCommand(root);

    expect(resolved.args).toBeNull();
    expect(resolved.reason_code).toBe('installed-runtime-absent');
    expect(resolved.cwd).toBe(root);
  });

  test('the absent-runtime verdict still resolves from a subdirectory', () => {
    const { resolveRuntimeRefreshCommand } = require('../../src/cli/commands/update');
    const root = makeRepo([]);
    const subdir = path.join(root, 'packages', 'nested');
    fs.mkdirSync(subdir, { recursive: true });

    const resolved = resolveRuntimeRefreshCommand(subdir);

    expect(resolved.args).toBeNull();
    expect(resolved.reason_code).toBe('installed-runtime-absent');
    expect(resolved.cwd).toBe(root);
  });

  test('a parent workspace without its own runtime never emits --all-repos for child hosts', () => {
    const { resolveRuntimeRefreshCommand } = require('../../src/cli/commands/update');
    const { root, childRoots } = makeWorkspace({
      parentPlatforms: [],
      children: { repoA: ['claude'], repoB: [] },
    });

    const resolved = resolveRuntimeRefreshCommand(root);

    expect(resolved.args).toBeNull();
    expect(resolved.reason_code).toBe('child-repo-runtime-only');
    expect(JSON.stringify(resolved)).not.toContain('--all-repos');
    expect(resolved.child_runtime_repos).toEqual([
      expect.objectContaining({ git_root: childRoots.repoA, platforms: ['claude'] }),
    ]);
  });

  test('a parent workspace where nothing is installed anywhere reports absent runtime', () => {
    const { resolveRuntimeRefreshCommand } = require('../../src/cli/commands/update');
    const { root } = makeWorkspace({ parentPlatforms: [], children: { repoA: [], repoB: [] } });

    const resolved = resolveRuntimeRefreshCommand(root);

    expect(resolved.args).toBeNull();
    expect(resolved.reason_code).toBe('installed-runtime-absent');
  });

  test('a parent workspace with its own runtime still refreshes only the parent scope', () => {
    const { resolveRuntimeRefreshCommand } = require('../../src/cli/commands/update');
    const { root } = makeWorkspace({
      parentPlatforms: ['claude'],
      children: { repoA: ['codex'] },
    });

    const resolved = resolveRuntimeRefreshCommand(root);

    expect(resolved.args).toEqual(['init', '--claude', '-y']);
    expect(resolved.reason_code).toBe('parent-workspace');
    expect(resolved.args).not.toContain('--codex');
    expect(resolved.args).not.toContain('--all-repos');
  });

  // A runtime root can survive while its state.json does not (interrupted init, manual delete).
  // Detection correctly reports no refreshable host, but the message must not claim nothing is
  // installed while managed directories are sitting right there.
  test('a runtime root without state.json is reported as stranded, not absent', () => {
    const { resolveRuntimeRefreshCommand } = require('../../src/cli/commands/update');
    const root = makeRepo([]);
    fs.mkdirSync(path.join(root, '.claude', 'skills'), { recursive: true });

    const resolved = resolveRuntimeRefreshCommand(root);

    expect(resolved.args).toBeNull();
    expect(resolved.reason_code).toBe('installed-runtime-stateless');
    expect(resolved.stateless_runtime_roots).toEqual(['.claude']);
  });

  test('the arg builders refuse to synthesize a host-less init command', () => {
    const { buildRuntimeRefreshArgs, buildRuntimeRefreshArgsForPlatforms } = require('../../src/cli/commands/update');

    expect(buildRuntimeRefreshArgsForPlatforms([])).toBeNull();
    expect(buildRuntimeRefreshArgsForPlatforms([], ['--all-repos'])).toBeNull();
    expect(buildRuntimeRefreshArgs(makeRepo([]))).toBeNull();
    expect(buildRuntimeRefreshArgsForPlatforms(['claude'])).toEqual(['init', '--claude', '-y']);
  });
});

describe('spec-first update exits 0 and spawns no init when there is nothing to refresh', () => {
  function loadUpdateWithSpawnSpy() {
    jest.resetModules();
    const calls = [];
    jest.doMock('node:child_process', () => ({
      ...jest.requireActual('node:child_process'),
      spawnSync: (command, args, options) => {
        calls.push({ command, args, options });
        return { status: 0, error: null };
      },
    }));
    return { calls, update: require('../../src/cli/commands/update') };
  }

  function captureOutput() {
    const stdout = [];
    const stderr = [];
    const originalLog = console.log;
    const originalError = console.error;
    console.log = (...parts) => stdout.push(parts.join(' '));
    console.error = (...parts) => stderr.push(parts.join(' '));
    return {
      stdout,
      stderr,
      restore: () => {
        console.log = originalLog;
        console.error = originalError;
      },
    };
  }

  afterEach(() => {
    jest.dontMock('node:child_process');
    jest.resetModules();
  });

  test('an absent runtime is reported as skipped without installing anything', async () => {
    const { calls, update } = loadUpdateWithSpawnSpy();
    const refreshCalls = [];
    const output = captureOutput();
    let exitCode;
    try {
      exitCode = await update.runUpdate([], {
        runInstall: () => ({ status: 0, errorCode: null }),
        resolveInstalledCliPath: () => ({ ok: true, cliPath: '/global/spec-first/bin/spec-first.js' }),
        resolveRuntimeRefreshCommand: () => ({
          args: null,
          cwd: '/workspace/app',
          reason_code: 'installed-runtime-absent',
        }),
        runRuntimeRefresh: (...args) => {
          refreshCalls.push(args);
          return { status: 0, errorCode: null };
        },
        clearVersionReminderCooldown: () => {},
        resolveLang: () => 'en',
      });
    } finally {
      output.restore();
    }

    expect(exitCode).toBe(0);
    expect(refreshCalls).toHaveLength(0);
    expect(calls.some((call) => Array.isArray(call.args) && call.args.includes('init'))).toBe(false);
    expect(output.stdout.join('\n')).toContain('no spec-first runtime assets are installed');
    expect(output.stdout.join('\n')).not.toContain('Runtime refresh completed.');
  });

  test('absent runtime points at explicit host selection instead of a bare init -y', async () => {
    const { update } = loadUpdateWithSpawnSpy();
    const output = captureOutput();
    try {
      await update.runUpdate([], {
        runInstall: () => ({ status: 0, errorCode: null }),
        resolveInstalledCliPath: () => ({ ok: true, cliPath: '/global/spec-first/bin/spec-first.js' }),
        resolveRuntimeRefreshCommand: () => ({
          args: null,
          cwd: '/workspace/app',
          reason_code: 'installed-runtime-absent',
        }),
        clearVersionReminderCooldown: () => {},
        resolveLang: () => 'en',
      });
    } finally {
      output.restore();
    }

    const stderr = output.stderr.join('\n');
    // A bare `init -y` installs the -y default hosts. Telling a user with no runtime to run it
    // reintroduces the very silent-install this command must not perform.
    expect(stderr).not.toMatch(/spec-first init (--repo \S+ )?-y/);
    expect(stderr).toContain('Install commands:');
    expect(stderr).toContain('--claude');
  });

  test('an undetermined scope also avoids recommending a host-less init -y', async () => {
    const { update } = loadUpdateWithSpawnSpy();
    const output = captureOutput();
    try {
      await update.runUpdate([], {
        runInstall: () => ({ status: 0, errorCode: null }),
        resolveInstalledCliPath: () => ({ ok: true, cliPath: '/global/spec-first/bin/spec-first.js' }),
        resolveRuntimeRefreshCommand: () => ({
          args: null,
          cwd: '/somewhere',
          reason_code: 'scope-undetermined',
        }),
        clearVersionReminderCooldown: () => {},
        resolveLang: () => 'en',
      });
    } finally {
      output.restore();
    }

    const stderr = output.stderr.join('\n');
    expect(stderr).not.toMatch(/spec-first init (--repo \S+ )?-y/);
    expect(stderr).toContain('--claude');
  });

  test('child-only runtime prints per-child refresh commands and never --all-repos', async () => {
    const { update } = loadUpdateWithSpawnSpy();
    const output = captureOutput();
    let exitCode;
    try {
      exitCode = await update.runUpdate([], {
        runInstall: () => ({ status: 0, errorCode: null }),
        resolveInstalledCliPath: () => ({ ok: true, cliPath: '/global/spec-first/bin/spec-first.js' }),
        resolveRuntimeRefreshCommand: () => ({
          args: null,
          cwd: '/workspace',
          reason_code: 'child-repo-runtime-only',
          child_repo_count: 2,
          child_runtime_repos: [
            { git_root: '/workspace/repoA', workspace_relative_path: 'repoA', platforms: ['claude'] },
          ],
        }),
        clearVersionReminderCooldown: () => {},
        resolveLang: () => 'en',
      });
    } finally {
      output.restore();
    }

    const stderr = output.stderr.join('\n');
    expect(exitCode).toBe(0);
    expect(output.stdout.join('\n')).toContain('1 child repo');
    expect(stderr).toContain('spec-first init --claude --repo repoA -y -u <name>');
    expect(stderr).not.toContain('--all-repos');
  });
});
