'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { getSupportedPlatforms } = require('../../src/cli/adapters');
const {
  maskAllowedCodexOtherHostPaths,
} = require('../../src/cli/host-comparative-workflows');
const {
  normalizeSetupFacts,
} = require('../../src/cli/helpers/setup-facts');
const { WORKFLOW_RUNTIME_CONTRACT_TESTS } = require('../../scripts/run-ai-dev-quality-gate');
const { collectSetupFacts } = require('../../skills/spec-runtime-setup/scripts/lib/facts.cjs');
const {
  getEffectiveEntry,
  getEffectiveRegistry,
  loadRegistry,
} = require('../../skills/spec-runtime-setup/scripts/lib/registry.cjs');
const providers = require('../../skills/spec-runtime-setup/scripts/providers/registry.cjs');
const {
  LOCAL_CONFIG_CONSUMERS,
} = require('../../skills/spec-runtime-setup/scripts/lib/project-config.cjs');
const localizationProducer = require('../../scripts/check-ce-localization-review.cjs');

const repoRoot = path.resolve(__dirname, '../..');

function read(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

function tempRepo(label) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `spec-first-config-consumer-${label}-`));
  fs.mkdirSync(path.join(root, '.git'), { recursive: true });
  return root;
}

describe('spec-runtime-setup active config consumers', () => {
  test('binds every registered local key to an exact current source anchor without creating a global gate', () => {
    const { preflight } = localizationProducer.buildArtifacts();
    const inventory = preflight.consumer_inventory;

    expect(inventory.status).toBe('confirmed');
    expect(inventory.missing_keys).toEqual([]);
    expect(inventory.rows.map((entry) => entry.key).sort()).toEqual(
      Object.keys(LOCAL_CONFIG_CONSUMERS).sort(),
    );
    for (const row of inventory.rows) {
      expect(row).toMatchObject({
        source_ref: expect.any(String),
        source_line: expect.any(Number),
        source_excerpt: expect.stringContaining(row.key),
        fallback_boundary: 'consumer-owned',
        blocking_scope: 'consumer-local-only',
      });
      expect(row.source_line).toBeGreaterThan(0);
    }
  });

  test('documents every active Product Pulse scheduling key', () => {
    const template = read('skills/spec-runtime-setup/references/config-template.yaml');
    const pulse = read('skills/spec-product-pulse/SKILL.md');

    expect(pulse).toContain('pulse_schedule');
    expect(template).toContain('# pulse_schedule: manual');
    expect(template).toContain('daily | weekly | manual | ask-again-after-3-runs');
  });

  test('classifies every document rendering output key by its active workflow consumer', () => {
    const setup = read('skills/spec-runtime-setup/SKILL.md');
    const template = read('skills/spec-runtime-setup/references/config-template.yaml');
    const plan = read('skills/spec-plan/SKILL.md');
    const brainstorm = read('skills/spec-brainstorm/SKILL.md');
    const ideate = read('skills/spec-ideate/SKILL.md');

    expect(plan).toContain('active (non-commented)** `plan_output:`');
    expect(brainstorm).toContain('active (non-commented)** `brainstorm_output:`');
    expect(ideate).toContain('active (non-commented)** `ideate_output:`');
    expect(setup).toContain('`plan_output`、`brainstorm_output` 和 `ideate_output`');
    expect(setup).toContain('分别由 `spec-plan`、`spec-brainstorm` 和 `spec-ideate` 读取');
    expect(setup).toContain('分别回退到 `spec-plan=md`、`spec-brainstorm=md`、`spec-ideate=html`');
    expect(setup).toContain('Pipeline override 仍由各 consumer 自己决定');
    expect(setup).toContain('不调用对应 workflow');
    expect(setup).not.toContain('reserved future hints');
    expect(template).toContain('# plan_output: html       # active: md | html');
    expect(template).toContain('# brainstorm_output: html # active: md | html');
    expect(template).toContain('# ideate_output: html     # active: md | html');
    expect(template).not.toMatch(/^(plan_output|brainstorm_output|ideate_output):/m);
    expect(template).not.toContain('reserved: md | html');
  });

  test('does not expose retired browser runtime profile configuration', () => {
    const setup = read('skills/spec-runtime-setup/SKILL.md');
    const template = read('skills/spec-runtime-setup/references/config-template.yaml');

    expect(setup).not.toContain('browser_runtime_profile_path');
    expect(setup).not.toContain('browser runtime profile');
    expect(template).not.toContain('browser_runtime_profile_path');
    expect(template).not.toContain('Browser runtime autonomy');
  });
});

describe('spec-runtime-setup active Node consumers', () => {
  test('loads helper metadata from setup-registry v9 without jq', () => {
    const registry = loadRegistry({ skillRoot: path.join(repoRoot, 'skills', 'spec-runtime-setup') });
    expect(registry.schema_version).toBe('setup-registry.v10');
    expect(registry.helpers.map((entry) => entry.id)).not.toContain('jq');

    const helpers = new Map(registry.helpers.map((entry) => [entry.id, entry]));
    expect(helpers.get('gh')).toMatchObject({ id: 'gh', baseline_blocking: true });
    for (const platform of ['macos', 'linux', 'windows']) {
      expect(getEffectiveEntry(registry, {
        kind: 'helper',
        id: 'agent-browser',
        host: 'codex',
        platform,
      }).installation.command).toEqual(expect.any(String));
    }
  });

  test('keeps downstream tool-facts normalization stable when fed by the Node facts owner', () => {
    const registry = loadRegistry({ skillRoot: path.join(repoRoot, 'skills', 'spec-runtime-setup') });
    const toolResults = registry.tools.map((entry) => ({
      id: entry.id,
      status: entry.required ? 'ready' : 'skipped',
      verified: true,
      source: 'post-mutation-probe',
    }));
    const helperResults = registry.helpers.map((entry) => ({
      id: entry.id,
      status: 'ready',
      verified: true,
      source: 'post-mutation-probe',
    }));
    const bundle = collectSetupFacts({
      repoRoot: '/repo',
      host: 'codex',
      platform: 'linux',
      registry,
      toolResults,
      helperResults,
      providerResults: [],
      configuredDependencies: [],
      now: new Date('2026-07-11T04:00:00.000Z'),
    });

    expect(normalizeSetupFacts(bundle.toolFacts, {
      now: new Date('2026-07-11T04:00:01.000Z'),
    })).toMatchObject({
      status: 'ready',
      reason_code: 'setup-facts-normalized',
      schema_versions: { tool_facts: 'tool-facts.v2' },
      host: 'codex',
      platform: 'linux',
      counts: { required_action: 0 },
    });
  });

  test('queries effective registry data for every setup-registry host', () => {
    const registry = loadRegistry({ skillRoot: path.join(repoRoot, 'skills', 'spec-runtime-setup') });
    const registryHosts = Object.keys(registry.hosts);
    expect(registryHosts.length).toBeGreaterThan(0);
    for (const host of registryHosts) {
      const effective = getEffectiveRegistry(registry, { host, platform: 'linux' });
      expect(effective.host_definition.id).toBe(host);
      expect(effective.tools.find((entry) => entry.id === 'context7').host_config.targets)
        .toBeDefined();
    }
    // setup-registry 覆盖面是受支持宿主的有意子集：pi 无原生 MCP 支持，
    // MCP_SETUP_HOST=pi 保持不支持，registry 不得新增 pi 定义（计划 KTD5；
    // 仅当 pi MCP 官方化时重评）。
    expect(getSupportedPlatforms().filter((platform) => !registryHosts.includes(platform)))
      .toEqual(['pi']);
  });

  test('host-authority surfaces stay bound to every setup host projection root', () => {
    const { getAdapter } = require('../../src/cli/adapters');
    const {
      CANONICAL_HOSTS,
      HOST_SKILL_SURFACES,
      resolveLoadedHostSurface,
    } = require('../../skills/spec-runtime-setup/scripts/lib/host-authority.cjs');

    // surface 登记面必须恰好覆盖 setup 支持宿主：多登记=放宽 fail-closed 绑定，
    // 少登记=该宿主 mutation 全部被 host-invocation-surface-unverified 阻断
    // （claude workflows 根 drift 曾导致此回归）。
    expect(Object.keys(HOST_SKILL_SURFACES).sort()).toEqual([...CANONICAL_HOSTS].sort());

    for (const host of CANONICAL_HOSTS) {
      const adapter = getAdapter(host);
      const surfaces = HOST_SKILL_SURFACES[host];
      expect(Array.isArray(surfaces)).toBe(true);
      // adapter 的 workflow 投射根（spec-runtime-setup 的实际生成面）必须登记。
      expect(surfaces).toContain(adapter.workflowsRoot);
      for (const surface of surfaces) {
        expect(surface).toBe(adapter.workflowsRoot);
      }
    }

    // 共享面语义：.agents/skills 同时确认 codex 与 zcode。
    const sharedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'spec-first-surface-guard-'));
    const sharedSkillRoot = path.join(sharedRoot, '.agents', 'skills', 'spec-runtime-setup');
    fs.mkdirSync(sharedSkillRoot, { recursive: true });
    const loaded = resolveLoadedHostSurface(sharedSkillRoot);
    expect(loaded).toMatchObject({
      surface_id: '.agents/skills',
      hosts: ['codex', 'zcode'],
    });

    // receipt schema 的 host enum 必须与 CANONICAL_HOSTS 同步
    // （zcode 接入时曾遗漏，confirmed zcode receipt 会违反已发布 schema）。
    const receiptSchema = JSON.parse(read('docs/contracts/verification/host-invocation-receipt.schema.json'));
    expect(receiptSchema.properties.host.enum.sort()).toEqual([...CANONICAL_HOSTS].sort());
  });

  test('routes Graphify project-skill installation through the trusted provider map', () => {
    expect(Object.keys(providers).sort()).toEqual(['codegraph', 'graphify']);
    const dependency = {
      ecosystem: 'pypi',
      package: 'graphifyy',
      version: '0.9.29',
      distribution: {
        wheel_url: 'https://files.pythonhosted.org/packages/f1/b1/0cbe4738ca9784850d40aae0d71c34547230e0445e52067f98b8d0b6c070/graphifyy-0.9.29-py3-none-any.whl',
        sha256: '143f4002f40d5c302ae43bd58487ad604191f2d0ac8216429894c6a913ecf27b',
        index_url: 'https://pypi.org/simple',
      },
    };
    const runner = (command) => command === 'python3'
      ? { exit_code: 0, status: 0, stdout: '3.12.4', stderr: '', signal: null, error: null, timed_out: false }
      : (command === 'uv'
        ? { exit_code: 0, status: 0, stdout: 'uv 0.8.0', stderr: '', signal: null, error: null, timed_out: false }
        : { exit_code: 1, status: 1, stdout: '', stderr: 'missing', signal: null, error: null, timed_out: false });
    const registryHosts = Object.keys(loadRegistry({ skillRoot: path.join(repoRoot, 'skills', 'spec-runtime-setup') }).hosts);
    for (const host of registryHosts) {
      const planRepoRoot = tempRepo(host);
      const plan = providers.graphify.plan({ selected: true, repoRoot: planRepoRoot, host, dependency, runner });
      if (host === 'qoder') {
        expect(plan.actions).toContainEqual(expect.objectContaining({ kind: 'install-qoder-adapter', command: null }));
        expect(plan.actions.some((entry) => entry.kind === 'install-project-skill')).toBe(false);
        continue;
      }
      const installSkill = plan.actions.find((entry) => entry.kind === 'install-project-skill');
      expect(installSkill).toMatchObject({
        command: 'graphify',
        args: ['install', '--project', '--platform', host],
      });
    }
  });

  test('masks only the unified Node entrypoint as comparative Claude runtime prose', () => {
    const nodePath = '.claude/spec-first/workflows/spec-runtime-setup/scripts/setup.cjs';
    expect(maskAllowedCodexOtherHostPaths(nodePath, 'spec-code-review')).toBe(
      '[allowed spec-code-review other-host path]',
    );
  });

  test('quality gate covers Node setup contracts without binding PowerShell assets', () => {
    expect(WORKFLOW_RUNTIME_CONTRACT_TESTS.some((file) => /powershell/i.test(file))).toBe(false);
    expect(WORKFLOW_RUNTIME_CONTRACT_TESTS).toEqual(expect.arrayContaining([
      'tests/unit/mcp-setup-node-contracts.test.js',
      'tests/unit/mcp-setup-entrypoint.test.js',
      'tests/unit/mcp-setup-registry.test.js',
      'tests/unit/mcp-setup-facts-renderer.test.js',
      'tests/unit/mcp-setup-providers.test.js',
    ]));
  });
});
