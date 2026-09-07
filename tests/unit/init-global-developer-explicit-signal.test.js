'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// The global developer profile at ~/.spec-first/.developer must only be rewritten when the user
// actually expressed a new identity. `explicitName`/`explicitLang` used to be derived from the
// RESOLVED name/lang, which always carry fallbacks (global profile, git user.name, 'zh'), so both
// were permanently true, `preserve` was unreachable from the CLI, and every init rewrote the file
// while printing a misleading "overwrite".
describe('init global developer profile honours real explicit input', () => {
  const tempDirs = [];
  let homeSpy;

  function makeHome({ name = 'Ada', lang = 'en', hosts = 'claude,codex' } = {}) {
    const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'spec-first-home-')));
    tempDirs.push(home);
    fs.mkdirSync(path.join(home, '.spec-first'), { recursive: true });
    fs.writeFileSync(
      path.join(home, '.spec-first', '.developer'),
      `name=${name}\nlang=${lang}\ninitialized_at=2020-01-01T00:00:00.000Z\nversion=0.0.1\nhosts=${hosts}\n`,
      'utf8',
    );
    homeSpy = jest.spyOn(os, 'homedir').mockReturnValue(home);
    return home;
  }

  function makeRepo() {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'spec-first-repo-')));
    tempDirs.push(root);
    fs.mkdirSync(path.join(root, '.git'), { recursive: true });
    return root;
  }

  function loadPlanBuilders() {
    jest.resetModules();
    return require('../../src/cli/commands/init-plan');
  }

  afterEach(() => {
    if (homeSpy) homeSpy.mockRestore();
    homeSpy = null;
    jest.resetModules();
    while (tempDirs.length > 0) {
      fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
    }
  });

  test('a resolved-only identity preserves the existing profile instead of overwriting it', () => {
    makeHome({ name: 'Ada', lang: 'en' });
    const projectRoot = makeRepo();
    const { buildInitPlan } = loadPlanBuilders();

    // Exactly what the real CLI passes on `init -y` with no -u/--lang: resolved values.
    const plan = buildInitPlan({
      projectRoot,
      platform: 'claude',
      name: 'Ada',
      lang: 'en',
      platforms: ['claude', 'codex'],
    });

    expect(plan.globalDeveloperWrite.action).toBe('preserve');
  });

  test('an explicit -u name overwrites the profile', () => {
    makeHome({ name: 'Ada', lang: 'en' });
    const projectRoot = makeRepo();
    const { buildInitPlan } = loadPlanBuilders();

    const plan = buildInitPlan({
      projectRoot,
      platform: 'claude',
      user: 'Grace',
      name: 'Grace',
      lang: 'en',
      explicitName: true,
      platforms: ['claude', 'codex'],
    });

    expect(plan.globalDeveloperWrite.action).toBe('overwrite');
    expect(plan.globalDeveloperWrite.developer.name).toBe('Grace');
  });

  test('an explicit --lang overwrites the profile', () => {
    makeHome({ name: 'Ada', lang: 'en' });
    const projectRoot = makeRepo();
    const { buildInitPlan } = loadPlanBuilders();

    const plan = buildInitPlan({
      projectRoot,
      platform: 'claude',
      name: 'Ada',
      lang: 'zh',
      explicitLang: true,
      platforms: ['claude', 'codex'],
    });

    expect(plan.globalDeveloperWrite.action).toBe('overwrite');
    expect(plan.globalDeveloperWrite.developer.lang).toBe('zh');
  });

  test('an interactively confirmed identity change still overwrites', () => {
    makeHome({ name: 'Ada', lang: 'en' });
    const projectRoot = makeRepo();
    const { buildInitPlan } = loadPlanBuilders();

    // Interactive rename: the user typed a new name at the prompt, so no -u flag was parsed,
    // but maybeConfirmGlobalProfileOverwrite captured the confirmation.
    const plan = buildInitPlan({
      projectRoot,
      platform: 'claude',
      name: 'Grace',
      lang: 'en',
      globalProfileConfirmed: true,
      platforms: ['claude', 'codex'],
    });

    expect(plan.globalDeveloperWrite.action).toBe('overwrite');
    expect(plan.globalDeveloperWrite.developer.name).toBe('Grace');
  });

  // resolveEffectiveGlobalDeveloperWrite cross-validates every plan and throws
  // global_developer_write_conflict when any comparable field disagrees. Threading the explicit
  // signal to only some construction sites would make multi-host and --all-repos init throw where
  // it used to succeed, so every plan must agree.
  test('multi-host plans agree on the write action with no explicit identity', () => {
    makeHome({ name: 'Ada', lang: 'en' });
    const projectRoot = makeRepo();
    jest.resetModules();
    const { buildInitPlan } = require('../../src/cli/commands/init-plan');
    const { resolveEffectiveGlobalDeveloperWrite } = require('../../src/cli/commands/init-developer');

    const plans = ['claude', 'codex'].map((platform) => buildInitPlan({
      projectRoot,
      platform,
      name: 'Ada',
      lang: 'en',
      platforms: ['claude', 'codex'],
    }));

    expect(plans.map((plan) => plan.globalDeveloperWrite.action)).toEqual(['preserve', 'preserve']);
    expect(() => resolveEffectiveGlobalDeveloperWrite(plans)).not.toThrow();
    expect(resolveEffectiveGlobalDeveloperWrite(plans).action).toBe('preserve');
  });

  test('workspace parent and child plans agree on the write action', () => {
    makeHome({ name: 'Ada', lang: 'en', hosts: 'claude' });
    const workspaceRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'spec-first-ws-')));
    tempDirs.push(workspaceRoot);
    const childRoot = path.join(workspaceRoot, 'repoA');
    fs.mkdirSync(path.join(childRoot, '.git'), { recursive: true });
    jest.resetModules();
    const { buildInitPlan } = require('../../src/cli/commands/init-plan');
    const { resolveEffectiveGlobalDeveloperWrite } = require('../../src/cli/commands/init-developer');

    const plan = buildInitPlan({
      projectRoot: workspaceRoot,
      platform: 'claude',
      name: 'Ada',
      lang: 'en',
      platforms: ['claude'],
      target: {
        mode: 'all-repos',
        workspaceRoot,
        selectionSource: 'test-all-repos',
      },
    });

    expect(plan.mode).toBe('all-repos');
    expect(plan.parentPlan.globalDeveloperWrite.action).toBe('preserve');
    for (const entry of plan.childPlans) {
      expect(entry.plan.globalDeveloperWrite.action).toBe('preserve');
    }
    expect(() => resolveEffectiveGlobalDeveloperWrite([plan])).not.toThrow();
  });

  test('an interactive rename reaches workspace child plans instead of being dropped', () => {
    makeHome({ name: 'Ada', lang: 'en', hosts: 'claude' });
    const workspaceRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'spec-first-ws-')));
    tempDirs.push(workspaceRoot);
    fs.mkdirSync(path.join(workspaceRoot, 'repoA', '.git'), { recursive: true });
    jest.resetModules();
    const { buildInitPlan } = require('../../src/cli/commands/init-plan');
    const { resolveEffectiveGlobalDeveloperWrite } = require('../../src/cli/commands/init-developer');

    const plan = buildInitPlan({
      projectRoot: workspaceRoot,
      platform: 'claude',
      name: 'Grace',
      lang: 'en',
      globalProfileConfirmed: true,
      platforms: ['claude'],
      target: {
        mode: 'all-repos',
        workspaceRoot,
        selectionSource: 'test-all-repos',
      },
    });

    // Without forwarding globalProfileConfirmed the workspace path sees no explicit signal at all,
    // silently discarding the name the user just confirmed.
    expect(plan.parentPlan.globalDeveloperWrite.action).toBe('overwrite');
    expect(plan.parentPlan.globalDeveloperWrite.developer.name).toBe('Grace');
    for (const entry of plan.childPlans) {
      expect(entry.plan.globalDeveloperWrite.action).toBe('overwrite');
    }
    expect(resolveEffectiveGlobalDeveloperWrite([plan]).developer.name).toBe('Grace');
  });

  test('changing the host selection still persists without an explicit identity', () => {
    makeHome({ name: 'Ada', lang: 'en', hosts: 'claude' });
    const projectRoot = makeRepo();
    const { buildInitPlan } = loadPlanBuilders();

    const plan = buildInitPlan({
      projectRoot,
      platform: 'claude',
      name: 'Ada',
      lang: 'en',
      platforms: ['claude', 'codex'],
    });

    expect(plan.globalDeveloperWrite.action).toBe('overwrite');
    expect(plan.globalDeveloperWrite.developer.hosts).toEqual(['claude', 'codex']);
  });
});
