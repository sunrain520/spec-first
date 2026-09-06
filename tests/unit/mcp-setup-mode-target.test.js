'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const argsModule = '../../skills/spec-runtime-setup/scripts/lib/args.cjs';
const modePolicyModule = '../../skills/spec-runtime-setup/scripts/lib/mode-policy.cjs';
const hostAuthorityModule = '../../skills/spec-runtime-setup/scripts/lib/host-authority.cjs';
const projectTargetModule = '../../skills/spec-runtime-setup/scripts/lib/project-target.cjs';

function createWorkspace() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'spec-first-mode-target-'));
}

function createRepo(root, relativePath = '.') {
  const repo = path.resolve(root, relativePath);
  fs.mkdirSync(repo, { recursive: true });
  const result = spawnSync('git', ['init', '-q', repo], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git init failed: ${result.stderr || result.stdout}`);
  return repo;
}

describe('spec-runtime-setup GNU argument parsing', () => {
  test('normalizes documented flags and comma-separated selections', () => {
    const { parseArgs } = require(argsModule);

    expect(parseArgs([
      '--only=codegraph,graphify',
      '--repo',
      'child',
      '--requirement-workspace=packages/api',
      '--user-scope',
      '--repair-host-config',
    ])).toMatchObject({
      only: ['codegraph', 'graphify'],
      repo: 'child',
      requirementWorkspace: 'packages/api',
      userScope: true,
      repairHostConfig: true,
      errors: [],
    });
  });

  test('reports unknown flags and missing values without guessing', () => {
    const { parseArgs } = require(argsModule);

    expect(parseArgs(['--repo'])).toMatchObject({
      errors: [{ reason_code: 'missing-option-value', option: '--repo' }],
    });
    expect(parseArgs(['--status'])).toMatchObject({
      errors: [{ reason_code: 'unknown-option', option: '--status' }],
    });
    expect(parseArgs(['--only=,,,'])).toMatchObject({
      errors: [{ reason_code: 'missing-option-value', option: '--only' }],
    });
  });
});

describe('spec-runtime-setup action policy', () => {
  test('binds every action to an explicit capability', () => {
    const { buildActionPlan } = require(modePolicyModule);
    const plan = buildActionPlan({
      argv: ['--only', 'codegraph'],
      knownIds: ['codegraph', 'graphify'],
    });

    expect(plan).toMatchObject({
      blocked: false,
      mode: 'only',
      mutation: true,
      capabilities: ['install-tools', 'write-host-config', 'provider-mutation', 'write-setup-facts'],
    });
    expect(plan.actions.length).toBeGreaterThan(0);
    for (const action of plan.actions) {
      expect(action).toEqual(expect.objectContaining({
        id: expect.any(String),
        capability: expect.any(String),
        mutation: expect.any(Boolean),
      }));
      if (action.mutation) {
        expect(plan.capabilities).toContain(action.capability);
      }
    }
  });

  test('keeps facts and project config mutations in separate capabilities', () => {
    const { buildActionPlan } = require(modePolicyModule);

    expect(buildActionPlan({ argv: ['--verify-only'] })).toMatchObject({
      mode: 'verify',
      capabilities: ['write-setup-facts'],
      actions: expect.arrayContaining([
        expect.objectContaining({ capability: 'write-setup-facts', mutation: true }),
      ]),
    });
    expect(buildActionPlan({ argv: ['--refresh-facts'] })).toMatchObject({
      mode: 'verify',
      capabilities: ['write-setup-facts'],
    });
    expect(buildActionPlan({ argv: ['--project-config'] })).toMatchObject({
      mode: 'project-config',
      capabilities: ['write-project-config'],
      actions: expect.arrayContaining([
        expect.objectContaining({ capability: 'write-project-config', mutation: true }),
      ]),
    });
  });

  test('allows --only to narrow a read-only install preview', () => {
    const { buildActionPlan } = require(modePolicyModule);

    expect(buildActionPlan({
      argv: ['--plan', '--only', 'graphify'],
      knownIds: ['codegraph', 'graphify'],
    })).toMatchObject({
      blocked: false,
      mode: 'plan',
      mutation: false,
      capabilities: [],
      selected_ids: ['graphify'],
    });
  });

  test('allows an explicit graphify refresh to be previewed without mutation', () => {
    const { buildActionPlan } = require(modePolicyModule);

    expect(buildActionPlan({
      argv: ['--plan', '--only', 'graphify', '--refresh'],
      knownIds: ['codegraph', 'graphify'],
    })).toMatchObject({
      blocked: false,
      mode: 'plan',
      mutation: false,
      capabilities: [],
      selected_ids: ['graphify'],
      args: { refresh: true },
    });
  });

  test('selects required providers by default for plan and verify while keeping bare Node mode diagnostic', () => {
    const { buildActionPlan } = require(modePolicyModule);
    const input = { knownIds: ['codegraph', 'graphify'], defaultIds: ['codegraph', 'graphify'] };

    expect(buildActionPlan({ ...input, argv: [] })).toMatchObject({
      mode: 'bare',
      selected_ids: [],
    });
    expect(buildActionPlan({ ...input, argv: ['--plan'] })).toMatchObject({
      mode: 'plan',
      selected_ids: ['codegraph', 'graphify'],
    });
    expect(buildActionPlan({ ...input, argv: ['--verify-only'] })).toMatchObject({
      mode: 'verify',
      selected_ids: ['codegraph', 'graphify'],
    });
  });

  test('treats host config repair as an explicit mutation mode or an --only modifier', () => {
    const { buildActionPlan } = require(modePolicyModule);

    expect(buildActionPlan({ argv: ['--repair-host-config'] })).toMatchObject({
      blocked: false,
      mode: 'host-config-repair',
      capabilities: ['write-host-config', 'write-setup-facts'],
      args: { repairHostConfig: true },
    });
    expect(buildActionPlan({
      argv: ['--only', 'codegraph', '--repair-host-config'],
      knownIds: ['codegraph', 'graphify'],
    })).toMatchObject({
      blocked: false,
      mode: 'only',
      selected_ids: ['codegraph'],
      args: { repairHostConfig: true },
    });
  });

  test.each([
    [['--check', '--plan'], 'mode-conflict'],
    [['--refresh'], 'refresh-without-only-graphify'],
    [['--only', 'codegraph', '--refresh'], 'refresh-without-only-graphify'],
    [['--check', '--refresh'], 'refresh-without-only-graphify'],
    [['--verify-only', '--refresh'], 'refresh-without-only-graphify'],
    [['--refresh-facts', '--refresh'], 'refresh-without-only-graphify'],
    [['--check', '--only', 'graphify', '--refresh'], 'mode-conflict'],
    [['--verify-only', '--only', 'graphify', '--refresh'], 'mode-conflict'],
    [['--refresh-facts', '--only', 'graphify', '--refresh'], 'mode-conflict'],
    [['--only', 'graphify', '--check'], 'mode-conflict'],
    [['--check', '--repair-host-config'], 'repair-host-config-mode-conflict'],
    [['--verify-only', '--repair-host-config'], 'repair-host-config-mode-conflict'],
    [['--project-config', '--repair-host-config'], 'repair-host-config-mode-conflict'],
    [['--workspace-graph', '--workspace-graph-status', '--only', 'codegraph,graphify'], 'workspace-graph-action-conflict'],
    [['--workspace-graph-clean', '--workspace-graph-status'], 'workspace-graph-action-conflict'],
    [['--repos', 'api'], 'repos-requires-workspace-graph-action'],
    [['--workspace-graph', '--all-repos', '--only', 'codegraph,graphify'], 'workspace-graph-all-repos-conflict'],
    [['--workspace-graph-status', '--repo', 'api'], 'workspace-graph-target-conflict'],
    [['--workspace-graph-clean', '--check'], 'workspace-graph-mode-conflict'],
    [['--workspace-graph'], 'workspace-graph-requires-codegraph-graphify'],
    [['--workspace-graph', '--only', 'graphify'], 'workspace-graph-provider-selection-invalid'],
  ])('fails closed for %j', (argv, reasonCode) => {
    const { buildActionPlan } = require(modePolicyModule);

    expect(buildActionPlan({ argv, knownIds: ['codegraph', 'graphify'] })).toMatchObject({
      blocked: true,
      mutation: false,
      reason_code: reasonCode,
      actions: [],
    });
  });

  test('gives workspace build, status, and clean explicit action modes', () => {
    const { buildActionPlan } = require(modePolicyModule);
    const knownIds = ['codegraph', 'graphify'];
    expect(buildActionPlan({ argv: ['--only', 'codegraph,graphify', '--workspace-graph'], knownIds })).toMatchObject({
      blocked: false,
      mode: 'workspace-graph-build',
      mutation: true,
    });
    expect(buildActionPlan({ argv: ['--workspace-graph-status'], knownIds })).toMatchObject({
      blocked: false,
      mode: 'workspace-graph-status',
      mutation: false,
    });
    expect(buildActionPlan({ argv: ['--workspace-graph-clean'], knownIds })).toMatchObject({
      blocked: false,
      mode: 'workspace-graph-clean',
      mutation: true,
    });
  });
});

describe('spec-runtime-setup host authority', () => {
  test.each(['production', 'test'])(
    'public main rejects a host pin that disagrees with the loaded Skill root when NODE_ENV=%s',
    (nodeEnv) => {
      const workspace = fs.realpathSync(createRepo(createWorkspace()));
      const loadedRoot = path.join(workspace, '.agents', 'skills', 'spec-runtime-setup');
      fs.mkdirSync(path.dirname(loadedRoot), { recursive: true });
      fs.cpSync(path.resolve(__dirname, '../../skills/spec-runtime-setup'), loadedRoot, { recursive: true });

      const result = spawnSync(process.execPath, [
        path.join(loadedRoot, 'scripts', 'setup.cjs'),
        '--only', 'graphify',
        '--repair-host-config',
        '--repo', workspace,
        '--json',
      ], {
        cwd: workspace,
        env: {
          ...process.env,
          NODE_ENV: nodeEnv,
          MCP_SETUP_HOST: 'claude',
        },
        encoding: 'utf8',
      });

      expect(result.status).toBe(2);
      expect(JSON.parse(result.stdout)).toMatchObject({
        status: 'blocked',
        mutation_authorized: false,
        reason_code: 'host-invocation-surface-mismatch',
        invocation_receipt: {
          schema_version: 'host-invocation-receipt/v1',
          verification_status: 'rejected',
          host: 'claude',
          loaded_host: 'codex',
          surface_id: '.agents/skills',
          enforcement_status: 'loaded-root-checked',
          receipt_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        },
      });
    },
  );

  test('binds mutation authority to the loaded host Skill root and emits a hashed receipt', () => {
    const { resolveHostAuthority } = require(hostAuthorityModule);
    const workspace = createWorkspace();
    const codexRoot = path.join(workspace, '.agents', 'skills', 'spec-runtime-setup');
    fs.mkdirSync(codexRoot, { recursive: true });
    const now = new Date('2026-08-20T08:00:00.000Z');

    expect(resolveHostAuthority({
      env: { MCP_SETUP_HOST: 'codex' },
      mutationRequested: true,
      candidates: ['codex'],
      skillRoot: codexRoot,
      targetIdentity: workspace,
      enforceSurfaceBinding: true,
      now,
    })).toMatchObject({
      status: 'ready',
      host: 'codex',
      mutation_authorized: true,
      reason_code: 'host-authority-loaded-root-bound',
      invocation_receipt: {
        schema_version: 'host-invocation-receipt/v1',
        verification_status: 'confirmed',
        host: 'codex',
        surface_id: '.agents/skills',
        skill_root: fs.realpathSync(codexRoot),
        target_identity: workspace,
        issued_at: '2026-08-20T08:00:00.000Z',
        freshness_expires_at: '2026-08-20T08:05:00.000Z',
        receipt_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
    });

    expect(resolveHostAuthority({
      env: { MCP_SETUP_HOST: 'claude' },
      mutationRequested: true,
      candidates: ['claude'],
      skillRoot: codexRoot,
      targetIdentity: workspace,
      enforceSurfaceBinding: true,
      now,
    })).toMatchObject({
      status: 'blocked',
      mutation_authorized: false,
      reason_code: 'host-invocation-surface-mismatch',
      invocation_receipt: {
        verification_status: 'rejected',
        loaded_host: 'codex',
      },
    });
  });

  test('confirms a claude pin loaded from the claude workflows projection root', () => {
    const { resolveHostAuthority } = require(hostAuthorityModule);
    const workspace = createWorkspace();
    // Claude 投射 workflow skill 到 managed workflows 根（command 投射面），
    // 不是 skills 根；binding 必须接受实际投射根作为 invocation surface。
    const claudeRoot = path.join(workspace, '.claude', 'spec-first', 'workflows', 'spec-runtime-setup');
    fs.mkdirSync(claudeRoot, { recursive: true });
    const now = new Date('2026-09-06T08:00:00.000Z');

    expect(resolveHostAuthority({
      env: { MCP_SETUP_HOST: 'claude' },
      mutationRequested: true,
      candidates: ['claude'],
      skillRoot: claudeRoot,
      targetIdentity: workspace,
      enforceSurfaceBinding: true,
      now,
    })).toMatchObject({
      status: 'ready',
      host: 'claude',
      mutation_authorized: true,
      reason_code: 'host-authority-loaded-root-bound',
      invocation_receipt: {
        schema_version: 'host-invocation-receipt/v1',
        verification_status: 'confirmed',
        host: 'claude',
        surface_id: '.claude/spec-first/workflows',
        skill_root: fs.realpathSync(claudeRoot),
        enforcement_status: 'loaded-root-checked',
        receipt_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
    });

    expect(resolveHostAuthority({
      env: { MCP_SETUP_HOST: 'codex' },
      mutationRequested: true,
      candidates: ['codex'],
      skillRoot: claudeRoot,
      targetIdentity: workspace,
      enforceSurfaceBinding: true,
      now,
    })).toMatchObject({
      status: 'blocked',
      mutation_authorized: false,
      reason_code: 'host-invocation-surface-mismatch',
      invocation_receipt: {
        verification_status: 'rejected',
        loaded_host: 'claude',
        surface_id: '.claude/spec-first/workflows',
      },
    });
  });

  test('accepts only canonical MCP_SETUP_HOST pins for mutation', () => {
    const { resolveHostAuthority } = require(hostAuthorityModule);

    expect(resolveHostAuthority({
      env: { MCP_SETUP_HOST: 'Codex' },
      mutationRequested: true,
      candidates: ['codex'],
    })).toMatchObject({
      status: 'blocked',
      host: null,
      reason_code: 'host-authority-invalid',
    });
    expect(resolveHostAuthority({
      env: { MCP_SETUP_HOST: 'codex' },
      mutationRequested: true,
      candidates: ['claude'],
    })).toMatchObject({
      status: 'ready',
      host: 'codex',
      authority_source: 'MCP_SETUP_HOST',
    });
  });

  test('keeps auto-detected candidates advisory on read-only paths', () => {
    const { resolveHostAuthority } = require(hostAuthorityModule);

    expect(resolveHostAuthority({
      env: {},
      mutationRequested: false,
      candidates: ['codex', 'claude', 'codex', 'unknown'],
    })).toEqual(expect.objectContaining({
      status: 'advisory',
      host: null,
      candidates: ['codex', 'claude'],
      mutation_authorized: false,
    }));
  });
});

describe('spec-runtime-setup project target resolution', () => {
  test('uses the current repo when cwd is a Git root', () => {
    const { resolveProjectTarget } = require(projectTargetModule);
    const repo = createRepo(createWorkspace());

    expect(resolveProjectTarget({ cwd: repo })).toMatchObject({
      mode: 'git-repo',
      target_kind: 'git-repo',
      selection_source: 'cwd-git-root',
      state_write_allowed: true,
      workspace_root: repo,
      target_root: repo,
    });
  });

  test('supports explicit repo and explicit non-git folder targets', () => {
    const { resolveProjectTarget } = require(projectTargetModule);
    const workspace = createWorkspace();
    const repo = createRepo(workspace, 'services/api');
    const folder = path.join(workspace, 'notes');
    fs.mkdirSync(folder, { recursive: true });

    expect(resolveProjectTarget({ cwd: workspace, repo: 'services/api' })).toMatchObject({
      mode: 'git-repo',
      selection_source: 'explicit-repo',
      target_root: repo,
      state_write_allowed: true,
    });
    expect(resolveProjectTarget({ cwd: workspace, folder: 'notes' })).toMatchObject({
      mode: 'non-git-folder',
      selection_source: 'explicit-folder',
      target_root: folder,
      artifact_root: folder,
      runtime_projection_root: folder,
      enclosing_git_root: null,
      state_write_allowed: true,
      git_health: {
        status: 'not-git',
        reason_code: 'not-git',
      },
    });
  });

  test('keeps an explicit nested folder exact while reusing its enclosing Git runtime projection', () => {
    const { resolveProjectTarget } = require(projectTargetModule);
    const workspace = createRepo(createWorkspace());
    const nested = path.join(workspace, 'vibops');
    fs.mkdirSync(nested, { recursive: true });

    expect(resolveProjectTarget({ cwd: nested, folder: nested })).toMatchObject({
      mode: 'non-git-folder',
      repo_status: 'not-git-repo',
      target_kind: 'non-git-folder',
      selection_source: 'explicit-folder',
      state_write_allowed: true,
      selected_folder_root: nested,
      target_root: nested,
      artifact_root: nested,
      runtime_projection_root: workspace,
      enclosing_git_root: workspace,
      git_health: {
        status: 'not-git',
        reason_code: 'not-git',
      },
    });
  });

  test('fails closed instead of promoting an explicit nested path to its ancestor Git root', () => {
    const { resolveProjectTarget } = require(projectTargetModule);
    const workspace = createRepo(createWorkspace());
    const nested = path.join(workspace, 'vibops');
    fs.mkdirSync(nested, { recursive: true });

    expect(resolveProjectTarget({ cwd: nested, repo: nested })).toMatchObject({
      mode: 'invalid-target',
      reason_code: 'repo-target-not-git-root',
      state_write_allowed: false,
      requested_repo_root: nested,
      resolved_git_root: workspace,
    });
  });

  test('discovers child repos for default-all and explicit-all selection', () => {
    const { resolveProjectTarget } = require(projectTargetModule);
    const workspace = createWorkspace();
    const first = createRepo(workspace, 'apps/first');
    const second = createRepo(workspace, 'packages/second');

    const defaultAll = resolveProjectTarget({ cwd: workspace });
    expect(defaultAll).toMatchObject({
      mode: 'workspace-all-repos',
      selection_source: 'workspace-default-all-repos',
      state_write_allowed: true,
    });
    expect(defaultAll.candidates.map((entry) => entry.git_root)).toEqual([first, second]);

    expect(resolveProjectTarget({ cwd: workspace, allRepos: true })).toMatchObject({
      mode: 'workspace-all-repos',
      selection_source: 'explicit-all-repos',
      state_write_allowed: true,
      candidates: expect.arrayContaining([
        expect.objectContaining({ git_root: first }),
        expect.objectContaining({ git_root: second }),
      ]),
    });
  });

  test('fails closed for outside and symlinked explicit targets', () => {
    const { resolveProjectTarget } = require(projectTargetModule);
    const workspace = createWorkspace();
    const outside = createRepo(createWorkspace());
    const link = path.join(workspace, 'linked-repo');
    fs.symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir');

    expect(resolveProjectTarget({ cwd: workspace, repo: outside })).toMatchObject({
      mode: 'invalid-target',
      reason_code: 'repo-target-outside-workspace',
      state_write_allowed: false,
    });
    expect(resolveProjectTarget({ cwd: workspace, repo: link })).toMatchObject({
      mode: 'invalid-target',
      reason_code: 'repo-target-symlink-escape',
      state_write_allowed: false,
    });
  });

  test('uses shared worktree health and refuses mutation for a broken gitdir pointer', () => {
    const { resolveProjectTarget } = require(projectTargetModule);
    const workspace = createWorkspace();
    const broken = path.join(workspace, 'broken');
    fs.mkdirSync(broken, { recursive: true });
    fs.writeFileSync(path.join(broken, '.git'), 'gitdir: ../missing-admin/worktrees/broken\n');

    expect(resolveProjectTarget({ cwd: broken })).toMatchObject({
      mode: 'git-repo',
      state_write_allowed: false,
      reason_code: 'broken-worktree',
      git_health: {
        status: 'broken-worktree',
        reason_code: 'broken-worktree',
        git_entry_type: 'file',
      },
    });

    expect(resolveProjectTarget({ cwd: workspace })).toMatchObject({
      mode: 'workspace-all-repos',
      candidates: [expect.objectContaining({
        git_root: broken,
        git_health: expect.objectContaining({ status: 'broken-worktree' }),
      })],
    });
  });

  test('treats an empty non-Git cwd as a writable single-folder target by default', () => {
    const { resolveProjectTarget } = require(projectTargetModule);
    const workspace = createWorkspace();

    expect(resolveProjectTarget({ cwd: workspace })).toMatchObject({
      mode: 'non-git-folder',
      selection_source: 'cwd-non-git-folder',
      reason_code: '',
      state_write_allowed: true,
      target_root: workspace,
      artifact_root: workspace,
      runtime_projection_root: workspace,
      enclosing_git_root: null,
    });
  });

  test('keeps explicit --all-repos fail-closed when no child Git repositories exist', () => {
    const { resolveProjectTarget } = require(projectTargetModule);
    const workspace = createWorkspace();

    expect(resolveProjectTarget({ cwd: workspace, allRepos: true })).toMatchObject({
      mode: 'workspace-no-git-candidates',
      selection_source: 'explicit-all-repos',
      reason_code: 'workspace-no-git-candidates',
      state_write_allowed: false,
      candidates: [],
    });
  });
});
