
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const {
  buildFilteredAssetSet,
  inspectInstalledAssets,
  listBundledAgentSupportFiles,
  listBundledAgents,
  listBundledSkills,
  loadPluginManifest,
  planBundledAssetSync,
} = require('../plugin');
const {
  resolveChangelogAuthor,
  resolveDeveloperIdentity,
} = require('../developer');
const {
  buildFileWriteOperation,
  buildState,
  isLegacyManagedState,
  mergeOperationPlans,
  planHardResetManagedAssets,
  planObsoleteManagedAssetRemoval,
  planRetiredRuntimeAssetPrune,
  readState,
  readStateFileRaw,
  summarizeOperationPlan,
} = require('../state');
const { detectGlobalCodexHookPollution } = require('../adapters/codex');
const { applyManagedBlock, buildManagedBlock } = require('../lang-policy');
const { removeManagedCodingGuidelinesBlock } = require('../coding-guidelines');
const { buildInitialChangelog, formatChangelogTimestamp } = require('../changelog');
const { applySpecFirstGitignoreBlock } = require('../gitignore-policy');
const {
  inspectInstructionBootstrap,
  removeManagedBootstrapBlock,
} = require('../instruction-bootstrap');
const { removeManagedRuntimeToolsBlock } = require('../runtime-tools-index');
const {
  QODER_HOOK_ACTIVATION_UNVERIFIED_REASON_CODE,
} = require('../qoder-settings');
const {
  getClaudeSettingsPath,
  inspectManagedClaudeHooks,
  renderManagedClaudeHooksUpsert,
  validateClaudeSettingsFile,
} = require('../claude-settings');
const { resolveSelectedHosts } = require('./init-args');
const {
  planLegacyDeveloperProfileCleanup,
  readLegacyProjectDeveloperFiles,
  resolveGlobalDeveloperWriteAction,
} = require('./init-developer');
const { canonicalizeExistingPath } = require('./init-paths');


// 变更画像（相对当前磁盘状态）：scripts prepare facts——输出层只渲染。
// write_file/update_file 与磁盘现状逐项比对；remove 来自 preSync 与破坏性
// 重置计划。编码差异按"将更新"处理，不误报为不变。
function summarizeWritePlanChanges(projectRoot, plan) {
  const counts = { unchanged: 0, updated: 0, added: 0, removed: 0 };
  const removalPlans = [plan.destructiveResetPlan, plan.preSyncPlan];
  for (const removalPlan of removalPlans) {
    for (const operation of (removalPlan && removalPlan.operations) || []) {
      if (operation.kind === 'remove_file' || operation.kind === 'remove_dir') {
        counts.removed += 1;
      }
    }
  }
  for (const operation of (plan.writePlan && plan.writePlan.operations) || []) {
    if (operation.kind !== 'write_file' && operation.kind !== 'update_file') {
      continue;
    }
    const targetPath = path.join(projectRoot, operation.path);
    if (!fs.existsSync(targetPath)) {
      counts.added += 1;
      continue;
    }
    try {
      // 部分 managed 资产以 Buffer 写入（encoding='buffer'）；字符串与 Buffer
      // 混比会恒不等，必须分支比较，否则幂等刷新被误报为全部待更新。
      const isBuffer = operation.encoding === 'buffer' || Buffer.isBuffer(operation.contents);
      if (isBuffer) {
        const current = fs.readFileSync(targetPath);
        counts[current.equals(operation.contents) ? 'unchanged' : 'updated'] += 1;
      } else {
        const current = fs.readFileSync(targetPath, operation.encoding || 'utf8');
        counts[current === operation.contents ? 'unchanged' : 'updated'] += 1;
      }
    } catch (_error) {
      counts.updated += 1;
    }
  }
  return counts;
}

function buildProjectInitPlan({
  projectRoot,
  platform,
  adapter,
  name = '',
  user = '',
  lang = '',
  platforms = [],
  gitRootTopology = 'single-repo',
  dryRun = false,
  globalProfileConfirmed = false,
  explicitName = false,
  explicitLang = false,
}) {
  const normalizedRoot = canonicalizeExistingPath(projectRoot);
  const errors = [];
  const diagnostics = [];
  const bundledAgentPaths = listBundledAgents();
  const bundledAgentSupportFiles = listBundledAgentSupportFiles();

  if (platform === 'claude') {
    const duplicateBareNames = findDuplicateClaudeAgentNames(bundledAgentPaths);
    if (duplicateBareNames.length > 0) {
      errors.push({
        code: 'duplicate_claude_agent_names',
        message: `Error: Claude runtime requires unique bare agent names, but found duplicates: ${duplicateBareNames.join(', ')}`,
      });
      return buildErroredProjectInitPlan({
        projectRoot: normalizedRoot,
        platform,
        adapter,
        dryRun,
        gitRootTopology,
        errors,
        diagnostics,
      });
    }
  }
  if (platform === 'cursor') {
    diagnostics.push({
      level: 'warn',
      code: 'cursor_generated_runtime_preview',
      message: 'Warning: Cursor support is generated-runtime preview. Local Cursor skill discovery/invocation is not verified on this machine, so generated skills may not load.',
    });
  }
  if (platform === 'opencode') {
    diagnostics.push({
      level: 'warn',
      code: 'opencode_generated_runtime_preview',
      message: 'Warning: OpenCode support is generated-runtime preview. Command and skill loader behavior has not been verified for the installed OpenCode version.',
    });
  }
  if (platform === 'pi') {
    diagnostics.push({
      level: 'warn',
      code: 'pi_generated_runtime_preview',
      message: 'Warning: Pi support is preview (skills discovery from the shared .agents/skills projection and the trust gate are live-verified on pi 0.85.0; AGENTS.md injection and model-mediated /skill: invocation remain docs-verified only). '
        + 'Activation gate: pi loads project-level .agents/skills only after the project is trusted — run `pi` in this project and confirm the trust prompt (or trust once with `pi -a`); without trust, project skills stay silent.',
    });
  }
  if (platform === 'qoder') {
    diagnostics.push({
      level: 'warn',
      code: QODER_HOOK_ACTIVATION_UNVERIFIED_REASON_CODE,
      message: `Warning [${QODER_HOOK_ACTIVATION_UNVERIFIED_REASON_CODE}]: the qodercli 1.0.41 evidence baseline confirms the hook settings and command protocol, but authenticated event execution and shared IDE loader safety are not verified. Hook scripts are generated while settings entries remain intentionally omitted, so SessionStart and PRD guard hooks stay inactive.`,
    });
  }

  const commandDir = adapter.hasCommands ? path.join(normalizedRoot, adapter.commandRoot) : '';
  let previousState = null;
  let legacyStateDetected = false;
  let rawManagedState = null;
  let destructiveResetPlan = null;
  let destructiveResetReason = '';
  try {
    previousState = readState(normalizedRoot, adapter);
  } catch (error) {
    rawManagedState = tryReadRawManagedState(normalizedRoot, adapter);
    if (isLegacyManagedState(rawManagedState)) {
      legacyStateDetected = true;
    } else {
      diagnostics.push({
        level: 'warn',
        code: 'managed_state_unreadable',
        message: `Warning: could not read existing spec-first state; continuing with a fresh sync. (${error instanceof Error ? error.message : String(error)})`,
      });
    }
  }
  const manifest = loadPluginManifest();
  const filteredAssetSet = buildFilteredAssetSet(adapter.id);
  const runtimeCommands = adapter.hasCommands
    ? filteredAssetSet.commands.map((command) => ({
      ...command,
      filename: adapter.commandFilename(command),
    }))
    : [];
  let developer;
  try {
    developer = resolveDeveloperIdentity(normalizedRoot, {
      user: user || name,
      lang,
    });
    // 持久化用户本次勾选的 host 列表(数据源是勾选列表,非磁盘 runtime 状态,R2)。
    developer = { ...developer, hosts: resolveSelectedHosts(platforms) };
  } catch (error) {
    errors.push({
      code: 'developer_identity_unresolved',
      message: error instanceof Error ? error.message : String(error),
    });
    return buildErroredProjectInitPlan({
      projectRoot: normalizedRoot,
      platform,
      adapter,
      dryRun,
      gitRootTopology,
      errors,
      diagnostics,
    });
  }

  const commandSkillNames = new Set(manifest.commands.map((cmd) => cmd.skill));
  const assetSync = planBundledAssetSync(normalizedRoot, adapter, filteredAssetSet);
  const runtimeSyncPlan = adapter.planRuntimeFilesSync(normalizedRoot, { manifest, filteredAssetSet });
  if (runtimeSyncPlan && Array.isArray(runtimeSyncPlan.diagnostics)) {
    diagnostics.push(...runtimeSyncPlan.diagnostics);
  }
  if (runtimeSyncPlan && runtimeSyncPlan.skippedHookWrite) {
    diagnostics.push({
      level: 'warn',
      code: 'codex_home_hook_write_skipped',
      message: 'This directory\'s .codex is the Codex global hook location (CODEX_HOME). '
        + 'Skipping SessionStart hook install here to avoid double-injecting into every project. '
        + 'skills/AGENTS.md were still installed. Run init inside an actual project to install the project hook.',
    });
  }
  if (runtimeSyncPlan && runtimeSyncPlan.skippedConfigWrite) {
    diagnostics.push({
      level: 'warn',
      code: 'zcode_config_write_skipped',
      message: `Warning: the managed ZCode SessionStart entry was NOT written. ${runtimeSyncPlan.configWriteBlockReason || '.zcode/config.json could not be read.'} Fix or remove the file, then rerun init --zcode. skills/AGENTS.md were still installed.`,
    });
  } else if (runtimeSyncPlan && runtimeSyncPlan.hooksDisabledByUser) {
    diagnostics.push({
      level: 'warn',
      code: 'zcode_hooks_disabled_by_user',
      message: 'Warning: .zcode/config.json has hooks.enabled=false, so the managed ZCode SessionStart entry is installed but stays inactive. Remove the flag or set it to true to activate spec-first session injection.',
    });
  } else if (platform === 'codex') {
    // High-touch existing-pollution bridge (U2b): a normal project init is a frequent action,
    // so surface a pre-existing global SessionStart pollution here instead of waiting for the
    // user to remember to run doctor. Read-only advisory; never auto-deletes.
    try {
      const pollution = detectGlobalCodexHookPollution();
      if (pollution && pollution.polluted) {
        diagnostics.push({
          level: 'warn',
          code: 'codex_global_hook_pollution_detected',
          message: `A spec-first SessionStart hook exists in the Codex global hook location (${pollution.hooksJsonPath}); `
            + 'it double-injects into every project. Run `spec-first doctor --codex` for details, or remove that entry / '
            + `run \`spec-first clean --codex\` in ${pollution.codexHome}.`,
        });
      }
    } catch {
      // Advisory only; never block init on detection failure.
    }
  }
  const previewState = buildState(manifest.version, {
    ...assetSync.syncedAssets,
    platform,
  });

  if (platform === 'claude') {
    try {
      validateClaudeSettingsFile(normalizedRoot);
    } catch (error) {
      errors.push({
        code: 'invalid_claude_settings_json',
        message: `Could not read Claude settings before init. ${error instanceof Error ? error.message : String(error)}`,
      });
      errors.push({
        code: 'invalid_claude_settings_fix',
        message: 'Fix `.claude/settings.json` so it contains valid JSON, then rerun `spec-first init` and choose Claude Code when prompted.',
      });
      return buildErroredProjectInitPlan({
        projectRoot: normalizedRoot,
        platform,
        adapter,
        dryRun,
        gitRootTopology,
        errors,
        diagnostics,
      });
    }
  }

  if (legacyStateDetected) {
    diagnostics.push({
      level: 'warn',
      code: 'legacy_state_detected',
      message: 'Detected legacy spec-first state; performing managed hard reset before re-init.',
    });
    const legacyResetState = buildLegacyHardResetState({
      adapter,
      rawManagedState,
      runtimeCommands,
      bundledSkillNames: listBundledSkills(),
      commandSkillNames: [...commandSkillNames],
      bundledAgentPaths,
      bundledAgentSupportFiles,
    });
    destructiveResetPlan = planHardResetManagedAssets(normalizedRoot, legacyResetState, adapter);
    destructiveResetReason = 'legacy_state_detected';
    previousState = null;
  } else if (previousState) {
    const currentRuntimeDrift = inspectCurrentRuntimeDrift(normalizedRoot, adapter);
    if (currentRuntimeDrift.detected) {
      diagnostics.push({
        level: 'warn',
        code: 'current_runtime_drift',
        message: `Detected current spec-first runtime drift; performing managed hard reset before re-init. (${currentRuntimeDrift.reasons.join(', ')})`,
        reasons: currentRuntimeDrift.reasons,
      });
      destructiveResetPlan = planHardResetManagedAssets(normalizedRoot, previousState, adapter);
      destructiveResetReason = 'current_runtime_drift';
      previousState = null;
    }
  }

  const preSyncPlan = mergeOperationPlans(
    planObsoleteManagedAssetRemoval(normalizedRoot, previousState, previewState, adapter),
    planRetiredRuntimeAssetPrune(normalizedRoot, adapter),
    planLegacyDeveloperProfileCleanup(normalizedRoot),
  );
  const initWritePlan = buildInitWritePlan({
    projectRoot: normalizedRoot,
    adapter,
    developer,
    nextState: previewState,
    platform,
    assetPlan: assetSync.plan,
    runtimePlan: runtimeSyncPlan,
    gitRootTopology,
  });

  const operationPlan = mergeOperationPlans(destructiveResetPlan, preSyncPlan, initWritePlan);
  // 显式性必须来自 parseInitArgs 的 flag 事实与交互确认结果,不能从已解析的
  // name/lang 反推:后者带 global profile / git user.name / 'zh' 回落,永不为空,
  // 会让 preserve 分支永久不可达,并把每次 init 都报成 overwrite。
  const globalDeveloperWrite = resolveGlobalDeveloperWriteAction(developer, {
    explicitName: !!explicitName,
    explicitLang: !!explicitLang,
    confirmedOverwrite: !!globalProfileConfirmed,
  });
  return {
    schema_version: 'spec-first-init-plan.v1',
    mode: 'single-repo',
    projectRoot: normalizedRoot,
    platform,
    gitRootTopology,
    dryRun: Boolean(dryRun),
    adapterId: adapter.id,
    commandDir,
    developer,
    previousState,
    previewState,
    destructiveResetPlan,
    destructiveResetReason,
    legacyStateDetected,
    preSyncPlan,
    writePlan: initWritePlan,
    changeSummary: summarizeWritePlanChanges(normalizedRoot, {
      destructiveResetPlan,
      preSyncPlan,
      writePlan: initWritePlan,
    }),
    operationPlan,
    syncedAssets: assetSync.syncedAssets,
    changelogCreated: !fs.existsSync(path.join(normalizedRoot, 'CHANGELOG.md')),
    diagnostics,
    errors,
    summary: operationPlan.summary,
    globalDeveloperWrite,
  };
}

function buildErroredProjectInitPlan({
  projectRoot,
  platform,
  adapter,
  dryRun = false,
  gitRootTopology = 'single-repo',
  errors = [],
  diagnostics = [],
}) {
  const emptyPlan = mergeOperationPlans();
  return {
    schema_version: 'spec-first-init-plan.v1',
    mode: 'single-repo',
    projectRoot,
    platform,
    gitRootTopology,
    dryRun: Boolean(dryRun),
    adapterId: adapter.id,
    commandDir: adapter.hasCommands ? path.join(projectRoot, adapter.commandRoot) : '',
    developer: null,
    previousState: null,
    previewState: null,
    destructiveResetPlan: null,
    destructiveResetReason: '',
    legacyStateDetected: false,
    preSyncPlan: emptyPlan,
    writePlan: emptyPlan,
    operationPlan: emptyPlan,
    syncedAssets: {
      commands: [],
      skills: [],
      workflowSkills: [],
      internalSkills: [],
      agents: [],
      agentSupportFiles: [],
    },
    changelogCreated: false,
    diagnostics,
    errors,
    summary: emptyPlan.summary,
  };
}

function tryReadRawManagedState(projectRoot, adapter) {
  try {
    return readStateFileRaw(projectRoot, adapter);
  } catch (_error) {
    return null;
  }
}

function inspectCurrentRuntimeDrift(projectRoot, adapter) {
  const reasons = [];
  const installedAssets = inspectInstalledAssets(projectRoot, adapter);
  for (const key of ['commands', 'skills', 'agents', 'agentSupportFiles']) {
    const status = installedAssets[key] || {};
    if (Array.isArray(status.missing) && status.missing.length > 0) {
      reasons.push(`${key}_missing`);
    }
    if (Array.isArray(status.drifted) && status.drifted.length > 0) {
      reasons.push(`${key}_drifted`);
    }
  }

  const bootstrapStatus = inspectInstructionBootstrap(projectRoot, adapter);
  if (bootstrapStatus.status !== 'installed') {
    reasons.push(`bootstrap_${bootstrapStatus.status}`);
  }

  for (const check of adapter.inspectRuntimeFiles(projectRoot)) {
    if (check.level !== 'PASS' && check.drift !== false) {
      reasons.push(`runtime_file_${String(check.name || 'unknown').replace(/[^a-z0-9]+/gi, '_').toLowerCase()}`);
    }
  }

  if (adapter.id === 'claude') {
    for (const settingsStatus of inspectManagedClaudeHooks(projectRoot)) {
      if (settingsStatus.status !== 'installed') {
        const eventName = String(settingsStatus.eventName || 'unknown')
          .replace(/[^a-z0-9]+/gi, '_')
          .toLowerCase();
        reasons.push(`claude_settings_${eventName}_${settingsStatus.status}`);
      }
    }
  }

  return {
    detected: reasons.length > 0,
    reasons: [...new Set(reasons)],
  };
}

function buildLegacyHardResetState({
  adapter,
  rawManagedState,
  runtimeCommands,
  bundledSkillNames,
  commandSkillNames,
  bundledAgentPaths,
  bundledAgentSupportFiles,
}) {
  const rawState = rawManagedState && typeof rawManagedState === 'object' ? rawManagedState : {};
  const legacyTrackedSkills = mergeStringArrays(rawState.skills, rawState.workflowSkills);

  return {
    commands: mergeStringArrays(
      rawState.commands,
      runtimeCommands.map((command) => command.filename),
    ),
    skills: adapter.workflowsRoot === adapter.skillsRoot
      ? mergeStringArrays(bundledSkillNames, legacyTrackedSkills)
      : mergeStringArrays(bundledSkillNames, rawState.skills),
    workflowSkills: adapter.workflowsRoot === adapter.skillsRoot
      ? []
      : mergeStringArrays(commandSkillNames, rawState.workflowSkills),
    agents: mergeStringArrays(rawState.agents, bundledAgentPaths),
    agentSupportFiles: mergeStringArrays(rawState.agentSupportFiles, bundledAgentSupportFiles),
  };
}

function mergeStringArrays(...values) {
  return [...new Set(values.flatMap((value) => (
    Array.isArray(value)
      ? value.filter((entry) => typeof entry === 'string' && entry.length > 0)
      : []
  )))].sort((a, b) => a.localeCompare(b));
}

function findDuplicateClaudeAgentNames(agentPaths) {
  const seen = new Set();
  const duplicates = new Set();

  for (const agentPath of agentPaths) {
    const bareName = path.basename(agentPath, '.md');
    if (seen.has(bareName)) {
      duplicates.add(bareName);
      continue;
    }
    seen.add(bareName);
  }

  return [...duplicates].sort();
}

function buildInitWritePlan({
  projectRoot,
  adapter,
  developer,
  nextState,
  platform,
  assetPlan,
  runtimePlan,
  gitRootTopology = 'single-repo',
}) {
  return mergeOperationPlans(
    assetPlan,
    runtimePlan || buildInitRuntimePreviewPlan(projectRoot, adapter),
    buildInitGitignorePlan(projectRoot),
    buildInitMetadataPlan({ projectRoot, adapter, developer, nextState, platform, gitRootTopology }),
  );
}

function buildInitRuntimePreviewPlan(projectRoot, adapter) {
  return adapter.planRuntimeFilesSync(projectRoot);
}

function buildInitGitignorePlan(projectRoot) {
  const gitignorePath = path.join(projectRoot, '.gitignore');
  const existingGitignore = fs.existsSync(gitignorePath)
    ? fs.readFileSync(gitignorePath, 'utf8')
    : '';
  const gitignoreResult = applySpecFirstGitignoreBlock(existingGitignore);

  if (gitignoreResult.status === 'already-current') {
    return {
      operations: [],
      summary: summarizeOperationPlan([]),
    };
  }

  const operation = buildFileWriteOperation(
    projectRoot,
    gitignorePath,
    gitignoreResult.content,
    'managed_gitignore_policy',
  );
  operation.gitignoreStatus = gitignoreResult.status;

  return {
    operations: [operation],
    summary: summarizeOperationPlan([operation]),
  };
}

function buildInitMetadataPlan({
  projectRoot,
  adapter,
  developer,
  nextState,
  platform,
  gitRootTopology = 'single-repo',
}) {
  const operations = [];
  const instructionPath = path.join(projectRoot, adapter.instructionFile);
  const existingInstruction = fs.existsSync(instructionPath)
    ? fs.readFileSync(instructionPath, 'utf8')
    : '';
  const instructionWithoutLegacyRuntimeTools = removeManagedRuntimeToolsBlock(existingInstruction);
  const instructionWithoutLegacyCodingGuidelines = removeManagedCodingGuidelinesBlock(
    instructionWithoutLegacyRuntimeTools,
  );
  const instructionWithoutLegacyBootstrap = removeManagedBootstrapBlock(
    instructionWithoutLegacyCodingGuidelines,
  );
  const instructionWithLang = applyManagedBlock(
    instructionWithoutLegacyBootstrap,
    buildManagedBlock(developer.lang),
  );
  operations.push(buildPlanFileOperation(
    projectRoot,
    adapter.instructionFile,
    instructionWithLang,
    'managed_instruction_file',
  ));

  operations.push(buildPlanFileOperation(
    projectRoot,
    adapter.stateFile,
    `${JSON.stringify(nextState, null, 2)}\n`,
    'managed_state_file',
  ));

  const changelogPath = path.join(projectRoot, 'CHANGELOG.md');
  if (!fs.existsSync(changelogPath)) {
    const changelogAuthor = resolveChangelogAuthor(projectRoot, {
      platform,
    });
    operations.push(buildPlanFileOperation(
      projectRoot,
      'CHANGELOG.md',
      buildInitialChangelog(
        formatChangelogTimestamp(new Date()),
        changelogAuthor.name || developer.name,
        developer.version,
      ),
      'bootstrap_changelog',
    ));
  }

  if (platform === 'claude') {
    const rendered = renderManagedClaudeHooksUpsert(projectRoot);
    operations.push(buildPlanFileOperation(
      projectRoot,
      path.relative(projectRoot, getClaudeSettingsPath(projectRoot)),
      rendered.contents,
      'managed_claude_hook_matchers',
    ));
  }

  return {
    operations,
    summary: summarizeOperationPlan(operations),
  };
}

function buildPlanFileOperation(projectRoot, relativePath, contents, reason) {
  const absolutePath = path.join(projectRoot, relativePath);
  return buildFileWriteOperation(projectRoot, absolutePath, contents, reason);
}

module.exports = {
  buildInitWritePlan,
  buildProjectInitPlan,
  summarizeWritePlanChanges,
  findDuplicateClaudeAgentNames,
  inspectCurrentRuntimeDrift,
  mergeStringArrays,
  readLegacyProjectDeveloperFiles,
  resolveGlobalDeveloperWriteAction,
};
