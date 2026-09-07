
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const {
  getGlobalDeveloperPath,
  readDeveloperFile,
  readGitUserName,
} = require('../developer');
const { getAdapter, getSupportedPlatforms } = require('../adapters');
const { checkPlatformCli } = require('./doctor');
const { getInitMessages } = require('../init-i18n');
const {
  INIT_PLATFORM_CHOICES,
  defaultInitPlatforms,
  formatInitHostFlagsForExample,
  formatInitTargetFlagsForExample,
  normalizeSupportedLang,
  resolveRememberedHosts,
} = require('./init-args');
const {
  canonicalizeExistingPath,
  isPathWithin,
} = require('./init-paths');
const {
  discoverChildGitRepos,
  findGitRoot,
} = require('./init-workspace');

// 本机实际可用的宿主：复用 doctor 的 PATH 探测，只有 PASS（确认可调用）才
// 参与预勾选；探测异常按未安装处理，不阻塞交互。
function detectInstalledHosts() {
  return getSupportedPlatforms().filter((platform) => {
    try {
      return checkPlatformCli(platform).level === 'PASS';
    } catch (_error) {
      return false;
    }
  });
}

async function collectInitInput({
  workspaceRoot,
  promptApi,
  parsed,
  defaults = null,
  defaultLang = '',
  messages = null,
  explicitTarget = null,
  onLangSelected = null,
}) {
  const root = canonicalizeExistingPath(workspaceRoot);
  const resolvedDefaults = defaults || resolveDeveloperDefaults(root);
  const initMessages = messages || getInitMessages(defaultLang || parsed.lang || resolvedDefaults.lang);

  const existingGlobal = readDeveloperFile(getGlobalDeveloperPath());
  const hasGlobalProfile = Boolean(existingGlobal && existingGlobal.name);
  const hasExplicitIdentity = Boolean(parsed.name) || Boolean(parsed.lang);
  // 全局 profile 已存在且未显式覆盖时,默认沿用,不再无条件先弹语言/名字提问。
  const reuseGlobalProfile = hasGlobalProfile && !parsed.yes && !hasExplicitIdentity;

  const promptLang = async () => promptApi.select(initMessages.languageSelect, [
    { label: 'Chinese / 中文 (zh)', value: 'zh' },
    { label: 'English (en)', value: 'en' },
  ], {
    defaultIndex: resolvedDefaults.lang === 'en' ? 1 : 0,
    hint: initMessages.selectHint,
  });

  let lang;
  if (parsed.lang) {
    lang = parsed.lang;
  } else if (parsed.yes) {
    lang = resolvedDefaults.lang;
  } else if (reuseGlobalProfile) {
    // 延后到沿用确认分支决定;先用全局值,选 No 时再弹语言选择。
    lang = resolvedDefaults.lang;
  } else {
    lang = await promptLang();
  }
  if (typeof onLangSelected === 'function') {
    onLangSelected(lang);
  }
  let activeMessages = getInitMessages(lang);
  // 交互多选框预勾选 = 本机探测到（PASS）∪ 上次记录过的宿主 ∪ 静态默认。
  // 探测只在交互多选框前进行一次（约每宿主一次 PATH 检查）；--yes 与显式
  // flag 路径不经过多选框，不承担探测成本，行为不变。
  const rememberedHosts = resolveRememberedHosts(existingGlobal);
  const detectedHosts = parsed.platforms.length > 0 || parsed.yes
    ? []
    : detectInstalledHosts();
  const platforms = parsed.platforms.length > 0
    ? parsed.platforms
    : parsed.yes
      ? defaultInitPlatforms()
      : await promptApi.checkbox(activeMessages.selectHosts, INIT_PLATFORM_CHOICES.map((choice) => ({
        label: choice.label,
        value: choice.id,
        checked: detectedHosts.includes(choice.id)
          || rememberedHosts.includes(choice.id)
          || choice.defaultChecked,
      })), {
        minSelected: 1,
        hint: activeMessages.checkboxHint,
        onMinError: activeMessages.minSelectedError,
      });

  if (!Array.isArray(platforms) || platforms.length === 0) {
    return null;
  }

  const adapters = platforms.map((platform) => getAdapter(platform));

  let name;
  if (parsed.name) {
    name = parsed.name;
  } else if (parsed.yes) {
    name = resolvedDefaults.name;
  } else if (reuseGlobalProfile) {
    const confirmedReuse = await promptApi.confirm(
      activeMessages.reuseGlobalProfile(existingGlobal.name, existingGlobal.lang),
      { default: true },
    );
    if (confirmedReuse) {
      name = existingGlobal.name;
      lang = existingGlobal.lang;
    } else {
      // 选择不沿用:补回语言选择,再确认名字。
      lang = await promptLang();
      activeMessages = getInitMessages(lang);
      name = await promptApi.textInput(activeMessages.developerName, {
        default: resolvedDefaults.name,
        validate: (value) => (String(value || '').trim().length > 0 ? true : activeMessages.nameRequired),
      });
    }
    if (typeof onLangSelected === 'function') {
      onLangSelected(lang);
    }
  } else {
    name = await promptApi.textInput(activeMessages.developerName, {
      default: resolvedDefaults.name,
      validate: (value) => (String(value || '').trim().length > 0 ? true : activeMessages.nameRequired),
    });
  }
  const userLanguageSyncPreference = await resolveUserLanguageSyncPreference({
    parsed,
    promptApi,
    messages: activeMessages,
    existingGlobal,
  });
  const target = explicitTarget || (parsed.allRepos || parsed.repo
    ? collectExplicitInitTarget(root, parsed)
    : parsed.yes
      ? collectDefaultInitTarget(root)
      : await collectInteractiveInitTarget(root, promptApi, activeMessages));
  if (!target) {
    return { cancelled: true, lang };
  }
  if (target.error) {
    return { error: target.error, exitCode: 2, lang };
  }

  const globalProfileConfirmed = await maybeConfirmGlobalProfileOverwrite({
    parsed,
    promptApi,
    name,
    lang,
    messages: activeMessages,
  });

  return {
    projectRoot: target.projectRoot || root,
    workspaceRoot: target.workspaceRoot || root,
    platforms,
    name,
    lang,
    dryRun: parsed.dryRun,
    target,
    globalProfileConfirmed,
    // 只有命令行 flag 才算显式身份;交互输入的身份变更由
    // globalProfileConfirmed 表达,两者共同决定是否覆写全局 profile。
    explicitName: Boolean(parsed.explicitName),
    explicitLang: Boolean(parsed.explicitLang),
    userLanguageSyncPreference,
  };
}

async function resolveUserLanguageSyncPreference({
  parsed,
  promptApi,
  messages = getInitMessages('zh'),
  existingGlobal = null,
}) {
  if (parsed.syncUserLanguageExplicit) {
    return {
      value: parsed.syncUserLanguage,
      source: 'explicit',
    };
  }

  if (existingGlobal && typeof existingGlobal.syncUserLanguage === 'boolean') {
    return {
      value: existingGlobal.syncUserLanguage,
      source: 'stored',
    };
  }

  if (parsed.yes) {
    return {
      value: null,
      source: 'unset',
    };
  }

  const confirmed = await promptApi.confirm(messages.syncUserLanguageConsent, { default: false });
  return {
    value: Boolean(confirmed),
    source: 'interactive',
  };
}

async function maybeConfirmGlobalProfileOverwrite({ parsed, promptApi, name, lang, messages = getInitMessages(lang) }) {
  const existing = readDeveloperFile(getGlobalDeveloperPath());
  if (!existing || !existing.name) {
    return false;
  }
  const sameName = !name || name === existing.name;
  const sameLang = !lang || lang === existing.lang;
  if (sameName && sameLang) {
    return false;
  }
  if (parsed.yes) {
    return Boolean(parsed.name) || Boolean(parsed.lang);
  }
  const display = `${existing.name} (${existing.lang})`;
  return promptApi.confirm(
    messages.globalProfileOverwrite(display, name, lang),
    { default: false },
  );
}

function resolveUserLanguageSyncProjectRoot(input = {}) {
  if (input.target && input.target.mode === 'all-repos') {
    return input.workspaceRoot || input.projectRoot || process.cwd();
  }
  return input.projectRoot || input.workspaceRoot || process.cwd();
}

function collectDefaultInitTarget(workspaceRoot) {
  const cwdGitRoot = findGitRoot(workspaceRoot);
  const candidates = discoverChildGitRepos(workspaceRoot);

  // 含 child repo 的非 Git 目录是显式 workspace 边界，即使它位于无关的祖先 Git 仓库内。
  // 当前目录不是 workspace root 时，仍保留普通 Git 子目录定位到 Git 根的行为。
  if (!hasGitMarker(workspaceRoot) && candidates.length > 0) {
    return buildWorkspaceOnlyInitTarget(workspaceRoot, 'parent-workspace-default');
  }

  if (cwdGitRoot) {
    return {
      mode: 'single-repo',
      projectRoot: cwdGitRoot,
      selectionSource: 'cwd-git-or-monorepo',
    };
  }

  if (candidates.length > 0) {
    return buildWorkspaceOnlyInitTarget(workspaceRoot, 'parent-workspace-default');
  }

  return {
    mode: 'single-repo',
    projectRoot: workspaceRoot,
    selectionSource: 'cwd-directory-non-interactive',
  };
}

function collectExplicitInitTarget(workspaceRoot, parsed) {
  if (parsed.allRepos) {
    if (findGitRoot(workspaceRoot)) {
      return { error: 'Error: --all-repos must be run from a parent workspace, not inside a Git repo.' };
    }
    const candidates = discoverChildGitRepos(workspaceRoot);
    if (candidates.length === 0) {
      return { error: 'Error: --all-repos requires a parent workspace containing child Git repos.' };
    }
    return {
      mode: 'all-repos',
      workspaceRoot,
      candidates,
      selectionSource: 'explicit-all-repos',
    };
  }

  if (parsed.repo) {
    const targetPath = path.resolve(workspaceRoot, parsed.repo);
    if (!fs.existsSync(targetPath)) {
      return { error: `Error: --repo target does not exist: ${parsed.repo}` };
    }
    const realWorkspace = canonicalizeExistingPath(workspaceRoot);
    const realTarget = canonicalizeExistingPath(targetPath);
    if (!isPathWithin(realTarget, realWorkspace)) {
      return { error: 'Error: --repo target must be inside the current workspace.' };
    }
    const gitRoot = findGitRoot(realTarget);
    if (!gitRoot || !isPathWithin(gitRoot, realWorkspace)) {
      return { error: 'Error: --repo target must resolve to a Git repo inside the current workspace.' };
    }
    return {
      mode: 'single-repo',
      projectRoot: gitRoot,
      selectionSource: 'explicit-repo',
    };
  }

  return null;
}

async function collectInteractiveInitTarget(workspaceRoot, promptApi, messages = getInitMessages('zh')) {
  const cwdGitRoot = findGitRoot(workspaceRoot);
  const candidates = discoverChildGitRepos(workspaceRoot);

  if (cwdGitRoot && (hasGitMarker(workspaceRoot) || candidates.length === 0)) {
    return {
      mode: 'single-repo',
      projectRoot: cwdGitRoot,
      selectionSource: 'cwd-git-or-monorepo',
    };
  }

  if (candidates.length === 0) {
    return {
      mode: 'single-repo',
      projectRoot: workspaceRoot,
      selectionSource: 'cwd-directory',
    };
  }

  return promptApi.select(messages.workspaceTarget, [
    {
      label: messages.workspaceRootOnly(candidates.length),
      value: buildWorkspaceOnlyInitTarget(workspaceRoot, 'workspace-interactive-parent-only'),
    },
    {
      label: messages.workspaceAllRepos(candidates.length),
      value: {
        mode: 'all-repos',
        workspaceRoot,
        candidates,
        selectionSource: 'workspace-interactive-all-repos',
      },
    },
    ...candidates.map((candidate) => ({
      label: candidate.workspace_relative_path,
      value: {
        mode: 'single-repo',
        projectRoot: candidate.git_root,
        selectionSource: 'workspace-interactive-single-repo',
      },
    })),
    {
      label: messages.workspaceCancel,
      value: null,
    },
  ], { requireExplicit: true, hint: messages.selectHint });
}

function buildWorkspaceOnlyInitTarget(workspaceRoot, selectionSource) {
  return {
    mode: 'single-repo',
    projectRoot: workspaceRoot,
    workspaceRoot,
    gitRootTopology: 'multi-repo-workspace',
    selectionSource,
  };
}

function hasGitMarker(dirPath) {
  return fs.existsSync(path.join(dirPath, '.git'));
}

function resolveDeveloperDefaults(projectRoot) {
  const globalDeveloper = readDeveloperFile(getGlobalDeveloperPath());
  const gitUserName = readGitUserName(projectRoot);
  const name =
    (globalDeveloper && globalDeveloper.name) ||
    gitUserName ||
    '';
  const lang =
    normalizeSupportedLang(globalDeveloper && globalDeveloper.lang) ||
    'zh';

  return {
    name,
    lang,
  };
}

function collectNonInteractiveExplicitTarget(workspaceRoot, parsed) {
  if (!parsed.yes || (!parsed.allRepos && !parsed.repo)) {
    return null;
  }
  return collectExplicitInitTarget(workspaceRoot, parsed);
}

function resolveNonInteractiveDeveloperDefaultsRoot(workspaceRoot, parsed, explicitTarget = null) {
  if (!parsed.yes || parsed.name || !parsed.repo) {
    return workspaceRoot;
  }

  if (explicitTarget && !explicitTarget.error && explicitTarget.mode === 'single-repo' && explicitTarget.projectRoot) {
    return explicitTarget.projectRoot;
  }
  return workspaceRoot;
}

function buildNonInteractiveDeveloperIdentityError(parsed, defaults, lang = 'zh') {
  if (!parsed.yes || parsed.name || (defaults && defaults.name)) {
    return '';
  }

  const hostFlags = formatInitHostFlagsForExample(parsed.platforms);
  const targetFlags = formatInitTargetFlagsForExample(parsed);
  const normalizedLang = lang === 'en' ? 'en' : 'zh';
  const example = `spec-first init ${hostFlags}${targetFlags} -y -u <name> --lang ${normalizedLang}`;
  const interactive = `spec-first init ${hostFlags}${targetFlags}`;

  if (normalizedLang === 'en') {
    return [
      'Unable to determine developer name. Non-interactive `spec-first init -y` cannot prompt for one.',
      'Pass it explicitly with `-u <name>`, for example:',
      `  ${example}`,
      'Or remove `-y` and run interactive init:',
      `  ${interactive}`,
    ].join('\n');
  }

  return [
    '无法确定 developer name。非交互 `spec-first init -y` 无法提示输入姓名。',
    '请显式传入 `-u <name>`，例如：',
    `  ${example}`,
    '或去掉 `-y` 运行交互式初始化：',
    `  ${interactive}`,
  ].join('\n');
}

module.exports = {
  buildNonInteractiveDeveloperIdentityError,
  buildWorkspaceOnlyInitTarget,
  collectDefaultInitTarget,
  collectExplicitInitTarget,
  collectInitInput,
  collectInteractiveInitTarget,
  collectNonInteractiveExplicitTarget,
  resolveDeveloperDefaults,
  resolveNonInteractiveDeveloperDefaultsRoot,
  resolveUserLanguageSyncProjectRoot,
  resolveUserLanguageSyncPreference,
};
