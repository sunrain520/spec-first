
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { writeFileAtomic } = require('../atomic-write');
const {
  canonicalizeExistingPath,
  isPathWithin,
  nearestExistingPath,
  toWorkspaceRelativePath,
  validateContainedWorkspaceWritePath,
} = require('./init-paths');
const { SUPPORTED_HOST_IDS } = require('./init-args');
const { collectInitErrors, collectPlanErrorMessages } = require('./init-diagnostics');
const {
  applyProjectInitPlan,
  ensureGlobalDeveloperPrerequisite,
} = require('./init-apply');
const { buildProjectInitPlan } = require('./init-project-plan');
const { normalizeProjectInitResult } = require('./init-result');

// 物理写入事实与 child authority 分开表达，不能由路径位置推断 canonical/setup/readiness truth。
const PARENT_ARTIFACT_AUTHORITY = Object.freeze({
  physical_scope: 'workspace-root-local',
  instruction_scope: 'parent-session-governance',
  host_runtime_scope: 'parent-workspace',
  workspace_summary_authority: 'advisory',
  child_repo_canonical: false,
  child_repo_setup_truth: false,
  child_repo_readiness_truth: false,
});

function discoverChildGitRepos(workspaceRoot, maxDepth = 3) {
  const normalizedWorkspaceRoot = canonicalizeExistingPath(workspaceRoot);
  const candidates = [];
  const queue = [{ dir: normalizedWorkspaceRoot, depth: 0 }];
  const skipNames = new Set([
    '.agents',
    '.cache',
    '.claude',
    '.codex',
    '.kiro',
    '.qoder',
    '.direnv',
    '.git',
    '.spec-first',
    '.venv',
    '.worktrees',
    'coverage',
    'dist',
    'node_modules',
    'temp',
    'tmp',
    'vendor',
  ]);

  while (queue.length > 0) {
    const current = queue.shift();
    let entries = [];
    try {
      entries = fs.readdirSync(current.dir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .sort((left, right) => left.name.localeCompare(right.name));
    } catch (_error) {
      continue;
    }

    for (const entry of entries) {
      if (skipNames.has(entry.name)) continue;
      const childPath = path.join(current.dir, entry.name);
      if (hasGitMarker(childPath)) {
        addChildRepoCandidate(candidates, childPath, normalizedWorkspaceRoot);
        continue;
      }
      if (current.depth < maxDepth) {
        queue.push({ dir: childPath, depth: current.depth + 1 });
      }
    }
  }

  return candidates.sort((left, right) =>
    left.workspace_relative_path.localeCompare(right.workspace_relative_path)
  );
}

function addChildRepoCandidate(candidates, candidateRoot, workspaceRoot) {
  const gitRoot = canonicalizeExistingPath(candidateRoot);
  if (!isPathWithin(gitRoot, workspaceRoot)) return;
  if (candidates.some((candidate) => (
    gitRoot === candidate.git_root || isPathWithin(gitRoot, candidate.git_root)
  ))) {
    return;
  }
  const workspaceRelativePath = toWorkspaceRelativePath(gitRoot, workspaceRoot);
  candidates.push({
    repo_label: workspaceRelativePath,
    git_root: gitRoot,
    workspace_relative_path: workspaceRelativePath,
    relationship: 'child_git_repo',
  });
}

function findGitRoot(startPath) {
  let current = canonicalizeExistingPath(startPath);
  try {
    const stat = fs.statSync(current);
    if (!stat.isDirectory()) {
      current = path.dirname(current);
    }
  } catch (_error) {
    return '';
  }

  while (true) {
    if (hasGitMarker(current)) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return '';
    }
    current = parent;
  }
}

function hasGitMarker(dirPath) {
  return fs.existsSync(path.join(dirPath, '.git'));
}

function writeJsonFileAtomic(filePath, payload) {
  // 复用共享 atomic-write(带 crypto 随机临时后缀与失败清理),不再内联弱版实现。
  writeFileAtomic(filePath, `${JSON.stringify(payload, null, 2)}\n`);
}

function buildWorkspaceInitPlan({
  platform,
  adapter,
  workspaceRoot,
  candidates,
  selectionSource = 'programmatic-all-repos',
  platformCount = 1,
  name = '',
  user = '',
  lang = '',
  platforms = [],
  dryRun = false,
  globalProfileConfirmed = false,
  explicitName = false,
  explicitLang = false,
}) {
  const normalizedWorkspaceRoot = canonicalizeExistingPath(workspaceRoot);
  const parentPlan = buildProjectInitPlan({
    projectRoot: normalizedWorkspaceRoot,
    platform,
    adapter,
    name,
    user,
    lang,
    platforms,
    dryRun,
    globalProfileConfirmed,
    explicitName,
    explicitLang,
    gitRootTopology: 'multi-repo-workspace',
  });
  const childPlans = candidates.map((candidate) => ({
    candidate,
    plan: buildProjectInitPlan({
      projectRoot: candidate.git_root,
      platform,
      adapter,
      name,
      user,
      lang,
      platforms,
      dryRun,
      globalProfileConfirmed,
      explicitName,
      explicitLang,
      gitRootTopology: 'single-repo',
    }),
  }));

  return {
    schema_version: 'spec-first-init-plan.v1',
    mode: 'all-repos',
    workspaceRoot: normalizedWorkspaceRoot,
    platform,
    platformCount,
    platforms,
    adapterId: adapter.id,
    dryRun: Boolean(dryRun),
    selectionSource,
    candidates,
    parentPlan,
    childPlans,
    errors: [
      ...(parentPlan.errors || []),
      ...childPlans.flatMap((entry) => entry.plan.errors || []),
    ],
    diagnostics: [
      ...(parentPlan.diagnostics || []),
      ...childPlans.flatMap((entry) => entry.plan.diagnostics || []),
    ],
    summary: {
      parent: parentPlan.summary || {},
      children: childPlans.map((entry) => ({
        repo_label: entry.candidate.repo_label,
        summary: entry.plan.summary || {},
      })),
    },
  };
}

function applyWorkspaceInitPlan(workspaceRoot, plan, context = {}) {
  if (collectInitErrors(plan).length > 0) {
    return {
      exit_code: 1,
      workspace_summary: null,
      workspace_summary_paths: [],
      globalDeveloperWriteResult: null,
    };
  }
  const prerequisite = ensureGlobalDeveloperPrerequisite([plan], context);
  const projectContext = {
    ...context,
    globalDeveloperWriteHandled: true,
    effectiveGlobalDeveloperWrite: prerequisite.effectiveGlobalDeveloperWrite,
    globalDeveloperWriteResult: prerequisite.globalDeveloperWriteResult,
  };
  const normalizedWorkspaceRoot = canonicalizeExistingPath(workspaceRoot || plan.workspaceRoot);
  let parentRuntime = {
    exit_code: 0,
    overall_status: 'ready',
    reason_code: null,
    diagnostic: '',
  };

  try {
    const parentResult = normalizeProjectInitResult(applyProjectInitPlan(
      plan.parentPlan.projectRoot,
      plan.parentPlan,
      projectContext,
    ));
    parentRuntime = {
      exit_code: parentResult.exit_code,
      overall_status: parentResult.exit_code === 0 ? 'ready' : 'action-required',
      reason_code: parentResult.exit_code === 0 ? null : 'parent-runtime-init-failed',
      diagnostic: collectPlanErrorMessages(plan.parentPlan),
    };
  } catch (error) {
    parentRuntime = {
      exit_code: 1,
      overall_status: 'action-required',
      reason_code: 'parent-runtime-init-exception',
      diagnostic: error instanceof Error ? error.message : String(error),
    };
  }

  const results = [];
  for (const entry of plan.childPlans) {
    const { candidate } = entry;
    try {
      const projectResult = normalizeProjectInitResult(applyProjectInitPlan(
        entry.plan.projectRoot,
        entry.plan,
        projectContext,
      ));
      results.push({
        repo_label: candidate.repo_label,
        workspace_relative_path: candidate.workspace_relative_path,
        git_root: candidate.git_root,
        exit_code: projectResult.exit_code,
        overall_status: projectResult.exit_code === 0 ? 'ready' : 'action-required',
        reason_code: projectResult.exit_code === 0 ? null : 'init-failed',
        diagnostic: collectPlanErrorMessages(entry.plan),
      });
    } catch (error) {
      results.push({
        repo_label: candidate.repo_label,
        workspace_relative_path: candidate.workspace_relative_path,
        git_root: candidate.git_root,
        exit_code: 1,
        overall_status: 'action-required',
        reason_code: 'init-exception',
        diagnostic: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const summary = buildWorkspaceInitSummary({
    workspaceRoot: normalizedWorkspaceRoot,
    plan,
    parentRuntime,
    results,
  });

  if (!plan.dryRun) {
    const writeResult = writeWorkspaceInitSummaryFiles(normalizedWorkspaceRoot, summary);
    if (!writeResult.ok) {
      return {
        exit_code: 1,
        workspace_summary: summary,
        workspace_summary_paths: [],
        globalDeveloperWriteResult: prerequisite.globalDeveloperWriteResult,
        error: `workspace init summary path is unsafe (${writeResult.reason_code})`,
      };
    }
    summary.workspace_summary_index = writeResult.index_summary || null;
    summary.workspace_summary_paths = writeResult.paths;
  }

  const actionRequiredCount = summary.counts.action_required + summary.counts.parent_runtime_action_required;
  return {
    exit_code: actionRequiredCount === 0 ? 0 : 1,
    workspace_summary: summary,
    workspace_summary_paths: summary.workspace_summary_paths || [],
    globalDeveloperWriteResult: prerequisite.globalDeveloperWriteResult,
  };
}

function buildWorkspaceInitSummary({
  workspaceRoot,
  plan,
  parentRuntime,
  results,
}) {
  const readyCount = results.filter((result) => result.overall_status === 'ready').length;
  const childActionRequiredCount = results.length - readyCount;
  const parentActionRequiredCount = parentRuntime.overall_status === 'ready' ? 0 : 1;
  const actionRequiredCount = childActionRequiredCount + parentActionRequiredCount;
  const overallStatus = actionRequiredCount === 0
    ? 'ready'
    : readyCount > 0
      ? 'partial'
      : 'action-required';

  return {
    schema_version: 'workspace-init-summary.v1',
    generated_at: new Date().toISOString(),
    advisory: true,
    workflow_mode: 'all-repos',
    selection_source: plan.selectionSource,
    workspace_root: workspaceRoot,
    parent_writes_repo_local_artifacts: true,
    parent_writes_host_runtime_assets: true,
    parent_artifact_authority: buildParentArtifactAuthority(),
    parent_host_runtime: parentRuntime,
    dry_run: Boolean(plan.dryRun),
    platform: plan.platform,
    platforms: Array.isArray(plan.platforms) && plan.platforms.length > 0
      ? [...new Set(plan.platforms)].sort((left, right) => left.localeCompare(right))
      : [plan.platform],
    platform_count: Number.isInteger(plan.platformCount) && plan.platformCount > 0
      ? plan.platformCount
      : 1,
    results,
    counts: {
      total: results.length,
      ready: readyCount,
      action_required: childActionRequiredCount,
      parent_runtime_ready: parentRuntime.overall_status === 'ready' ? 1 : 0,
      parent_runtime_action_required: parentActionRequiredCount,
    },
    overall_status: overallStatus,
    reason_code: actionRequiredCount === 0 ? null : 'all-repos-partial-or-action-required',
    next_action: actionRequiredCount === 0
      ? 'Parent workspace bootstrap and all child repos completed init.'
      : 'Inspect per-child reason_code and rerun init for action-required repos.',
  };
}

function persistWorkspaceUserLanguageSyncSummaries(plans, results, userLanguageSyncResult) {
  const failures = [];
  const summary = buildUserLanguageSyncSummary(userLanguageSyncResult);
  plans.forEach((plan, index) => {
    const result = results[index];
    if (!plan || plan.mode !== 'all-repos' || !result || !result.workspace_summary) {
      return;
    }
    result.workspace_summary.user_language_sync = summary;
    const writeResult = writeWorkspaceInitSummaryFiles(plan.workspaceRoot, result.workspace_summary);
    if (!writeResult.ok) {
      failures.push({
        platform: plan.platform,
        reason_code: writeResult.reason_code,
      });
      return;
    }
    result.workspace_summary.workspace_summary_index = writeResult.index_summary || null;
    result.workspace_summary.workspace_summary_paths = writeResult.paths;
    result.workspace_summary_paths = writeResult.paths;
  });
  return failures;
}

function buildUserLanguageSyncSummary(result) {
  if (!result || typeof result !== 'object') {
    return {
      schema_version: 'user-language-sync-summary.v1',
      status: 'skipped',
      reason_code: 'user-language-sync-unset',
      operations: [],
      profile: null,
    };
  }
  return {
    schema_version: 'user-language-sync-summary.v1',
    status: result.status || 'unknown',
    reason_code: result.reason_code || null,
    operations: (Array.isArray(result.operations) ? result.operations : []).map((operation) => ({
      host: operation.host,
      action: operation.action,
      status: operation.status,
      reason_code: operation.reason || null,
      display_path: operation.displayPath,
      basis: operation.basis || null,
      override_display_path: operation.overrideDisplayPath || null,
      error: operation.error || null,
    })),
    profile: result.profileOperation ? {
      action: result.profileOperation.action,
      status: result.profileOperation.status,
      reason_code: result.profileOperation.reason || null,
      path: result.profileOperation.globalPath,
      value: result.profileOperation.value,
      error: result.profileOperation.error || null,
    } : null,
  };
}

function writeWorkspaceInitSummaryFiles(workspaceRoot, summary) {
  const workspaceDir = path.join(workspaceRoot, '.spec-first', 'workspace');
  const platformSummaryPath = path.join(workspaceDir, workspaceInitSummaryFileName(summary.platform));
  const summaryPath = path.join(workspaceDir, 'init-summary.json');

  for (const candidatePath of [platformSummaryPath, summaryPath]) {
    const guard = validateContainedWorkspaceWritePath(workspaceRoot, candidatePath);
    if (!guard.ok) {
      return { ok: false, reason_code: guard.reason_code, paths: [] };
    }
  }

  writeJsonFileAtomic(platformSummaryPath, summary);
  const platformRelativePath = toWorkspaceRelativePath(platformSummaryPath, workspaceRoot);
  const multiPlatform = (Array.isArray(summary.platforms) && summary.platforms.length > 1)
    || (Number.isInteger(summary.platform_count) && summary.platform_count > 1);

  if (!multiPlatform) {
    writeJsonFileAtomic(summaryPath, summary);
    return {
      ok: true,
      paths: [
        toWorkspaceRelativePath(summaryPath, workspaceRoot),
        platformRelativePath,
      ],
      index_summary: null,
    };
  }

  const indexSummary = buildWorkspaceInitSummaryIndex({
    workspaceRoot,
    summaryPath,
    currentSummary: summary,
    currentSummaryRelativePath: platformRelativePath,
  });
  writeJsonFileAtomic(summaryPath, indexSummary);
  return {
    ok: true,
    paths: [
      toWorkspaceRelativePath(summaryPath, workspaceRoot),
      platformRelativePath,
    ],
    index_summary: indexSummary,
  };
}

function workspaceInitSummaryFileName(platform) {
  const safePlatform = SUPPORTED_HOST_IDS.has(platform) ? platform : 'unknown';
  return `init-summary-${safePlatform}.json`;
}

function buildWorkspaceInitSummaryIndex({
  workspaceRoot,
  summaryPath,
  currentSummary,
  currentSummaryRelativePath,
}) {
  const existing = readWorkspaceInitSummaryIndex(summaryPath, workspaceRoot);
  const platforms = {
    ...(existing.platforms || {}),
    [currentSummary.platform]: buildWorkspaceInitPlatformEntry(currentSummary, currentSummaryRelativePath),
  };
  const entries = Object.values(platforms).sort((left, right) => (
    String(left.platform || '').localeCompare(String(right.platform || ''))
  ));
  const readyCount = entries.filter((entry) => entry.overall_status === 'ready').length;
  const actionRequiredCount = entries.length - readyCount;
  const childTotal = entries.reduce((total, entry) => total + entry.counts.total, 0);
  const childReady = entries.reduce((total, entry) => total + entry.counts.ready, 0);
  const childActionRequired = entries.reduce((total, entry) => total + entry.counts.action_required, 0);
  const parentRuntimeReady = entries.reduce((total, entry) => total + entry.counts.parent_runtime_ready, 0);
  const parentRuntimeActionRequired = entries.reduce((total, entry) => total + entry.counts.parent_runtime_action_required, 0);

  return {
    schema_version: 'workspace-init-summary-index.v1',
    generated_at: new Date().toISOString(),
    advisory: true,
    workflow_mode: 'all-repos',
    selection_source: currentSummary.selection_source,
    workspace_root: workspaceRoot,
    parent_writes_repo_local_artifacts: true,
    parent_writes_host_runtime_assets: true,
    parent_artifact_authority: buildParentArtifactAuthority(),
    platforms: entries.reduce((memo, entry) => {
      memo[entry.platform] = entry;
      return memo;
    }, {}),
    user_language_sync: currentSummary.user_language_sync || null,
    counts: {
      platform_total: entries.length,
      platform_ready: readyCount,
      platform_action_required: actionRequiredCount,
      total: childTotal,
      ready: childReady,
      action_required: childActionRequired,
      parent_runtime_ready: parentRuntimeReady,
      parent_runtime_action_required: parentRuntimeActionRequired,
    },
    overall_status: actionRequiredCount === 0
      ? 'ready'
      : readyCount > 0
        ? 'partial'
        : 'action-required',
    reason_code: actionRequiredCount === 0 ? null : 'all-repos-partial-or-action-required',
    next_action: actionRequiredCount === 0
      ? 'Parent workspace bootstrap and all child repos completed init for all selected platforms.'
      : 'Inspect per-platform reason_code and rerun init for action-required platforms.',
  };
}

function readWorkspaceInitSummaryIndex(summaryPath, workspaceRoot) {
  if (!fs.existsSync(summaryPath)) {
    return { platforms: {}, parent_artifact_authority: null };
  }
  try {
    const payload = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
    if (payload && payload.schema_version === 'workspace-init-summary-index.v1' && payload.platforms && typeof payload.platforms === 'object') {
      return {
        platforms: payload.platforms,
        parent_artifact_authority: readParentArtifactAuthority(payload),
      };
    }
    if (payload && payload.schema_version === 'workspace-init-summary.v1' && payload.platform) {
      return {
        platforms: {
          [payload.platform]: buildWorkspaceInitPlatformEntry(
            payload,
            toWorkspaceRelativePath(summaryPath, workspaceRoot),
          ),
        },
        parent_artifact_authority: readParentArtifactAuthority(payload),
      };
    }
  } catch (_error) {
    return { platforms: {}, parent_artifact_authority: null };
  }
  return { platforms: {}, parent_artifact_authority: null };
}

function buildParentArtifactAuthority() {
  return { ...PARENT_ARTIFACT_AUTHORITY };
}

function readParentArtifactAuthority(payload) {
  const authority = payload && payload.parent_artifact_authority;
  return authority && typeof authority === 'object' && !Array.isArray(authority)
    ? { ...authority }
    : null;
}

function buildWorkspaceInitPlatformEntry(summary, summaryRelativePath) {
  const counts = summary.counts || {};
  return {
    platform: summary.platform,
    path: summaryRelativePath,
    generated_at: summary.generated_at,
    overall_status: summary.overall_status,
    reason_code: summary.reason_code,
    user_language_sync: summary.user_language_sync || null,
    counts: {
      total: numberOrZero(counts.total),
      ready: numberOrZero(counts.ready),
      action_required: numberOrZero(counts.action_required),
      parent_runtime_ready: numberOrZero(counts.parent_runtime_ready),
      parent_runtime_action_required: numberOrZero(counts.parent_runtime_action_required),
    },
  };
}

function numberOrZero(value) {
  return Number.isFinite(value) ? value : 0;
}

module.exports = {
  addChildRepoCandidate,
  applyWorkspaceInitPlan,
  buildUserLanguageSyncSummary,
  buildWorkspaceInitPlan,
  buildWorkspaceInitPlatformEntry,
  buildWorkspaceInitSummary,
  buildWorkspaceInitSummaryIndex,
  canonicalizeExistingPath,
  discoverChildGitRepos,
  findGitRoot,
  hasGitMarker,
  isPathWithin,
  nearestExistingPath,
  numberOrZero,
  persistWorkspaceUserLanguageSyncSummaries,
  readWorkspaceInitSummaryIndex,
  toWorkspaceRelativePath,
  validateContainedWorkspaceWritePath,
  workspaceInitSummaryFileName,
  writeJsonFileAtomic,
  writeWorkspaceInitSummaryFiles,
};
