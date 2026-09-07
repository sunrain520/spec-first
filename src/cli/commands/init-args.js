'use strict';

const { getPlatformDisplayName, getSupportedPlatforms } = require('../adapters');

// init 特有的选择行为（默认勾选、-y 默认宿主）是本地配置；宿主 id 集合与
// 显示名从 platform registry 派生，新增宿主自动进入 init 的选择面与解析面，
// 未配置默认行为的宿主按 { defaultChecked: false, defaultForYes: false } 兜底。
const INIT_PLATFORM_DEFAULTS = {
  claude: { defaultChecked: false, defaultForYes: true },
  codex: { defaultChecked: false, defaultForYes: true },
  cursor: { defaultChecked: false, defaultForYes: false },
  kiro: { defaultChecked: false, defaultForYes: false },
  qoder: { defaultChecked: false, defaultForYes: false },
  opencode: { defaultChecked: false, defaultForYes: false },
  // 显式条目保持清单完整（未配置宿主有同值兜底，但列出可读性更好）。
  pi: { defaultChecked: false, defaultForYes: false },
};

const INIT_PLATFORM_CHOICES = getSupportedPlatforms().map((id) => ({
  id,
  flag: id,
  label: getPlatformDisplayName(id),
  ...(INIT_PLATFORM_DEFAULTS[id] || { defaultChecked: false, defaultForYes: false }),
}));

const SUPPORTED_HOST_IDS = new Set(INIT_PLATFORM_CHOICES.map((choice) => choice.id));

function parseInitArgs(args) {
  const parsed = {
    help: false,
    yes: false,
    dryRun: false,
    allRepos: false,
    repo: '',
    platforms: [],
    name: '',
    lang: '',
    // 用户是否真的在命令行给出身份:name/lang 的"已解析值"带有 global profile、
    // git user.name、'zh' 等回落,永不为空,不能用来判断显式输入。
    explicitName: false,
    explicitLang: false,
    syncUserLanguage: null,
    syncUserLanguageExplicit: false,
    error: '',
  };
  const platforms = new Set();

  const readValue = (index, optionName) => {
    const value = args[index + 1];
    if (!value || value.startsWith('-')) {
      parsed.error = `init: missing value for ${optionName}`;
      return '';
    }
    return value;
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '-h' || arg === '--help') {
      parsed.help = true;
      continue;
    }
    if (arg === '-y' || arg === '--yes') {
      parsed.yes = true;
      continue;
    }
    if (arg === '--dry-run') {
      parsed.dryRun = true;
      continue;
    }
    if (arg === '--sync-user-language') {
      parsed.syncUserLanguage = true;
      parsed.syncUserLanguageExplicit = true;
      continue;
    }
    if (arg === '--no-sync-user-language') {
      parsed.syncUserLanguage = false;
      parsed.syncUserLanguageExplicit = true;
      continue;
    }
    if (arg === '--all-repos') {
      parsed.allRepos = true;
      continue;
    }
    if (arg === '--repo') {
      const value = readValue(index, arg);
      if (parsed.error) break;
      parsed.repo = value;
      index += 1;
      continue;
    }
    if (arg.startsWith('--repo=')) {
      parsed.repo = arg.slice('--repo='.length);
      if (!parsed.repo) parsed.error = 'init: missing value for --repo';
      if (parsed.error) break;
      continue;
    }
    if (arg === '-u' || arg === '--user') {
      const value = readValue(index, arg);
      if (parsed.error) break;
      parsed.name = value;
      parsed.explicitName = true;
      index += 1;
      continue;
    }
    if (arg.startsWith('--user=')) {
      parsed.name = arg.slice('--user='.length);
      if (!parsed.name) parsed.error = 'init: missing value for --user';
      if (parsed.error) break;
      parsed.explicitName = true;
      continue;
    }
    if (arg === '--lang') {
      const value = readValue(index, arg);
      if (parsed.error) break;
      parsed.lang = value;
      parsed.explicitLang = true;
      index += 1;
      continue;
    }
    if (arg.startsWith('--lang=')) {
      parsed.lang = arg.slice('--lang='.length);
      if (!parsed.lang) parsed.error = 'init: missing value for --lang';
      if (parsed.error) break;
      parsed.explicitLang = true;
      continue;
    }
    const platformChoice = INIT_PLATFORM_CHOICES.find((choice) => arg === `--${choice.flag}`);
    if (platformChoice) {
      platforms.add(platformChoice.id);
      continue;
    }
    parsed.error = `init: unknown option ${arg}`;
    break;
  }

  if (!parsed.error && parsed.lang && parsed.lang !== 'zh' && parsed.lang !== 'en') {
    parsed.error = 'init: --lang must be zh or en';
  }
  if (!parsed.error && parsed.allRepos && parsed.repo) {
    parsed.error = 'init: Cannot combine --repo and --all-repos.';
  }
  if (!parsed.error && args.includes('--sync-user-language') && args.includes('--no-sync-user-language')) {
    parsed.error = 'init: Cannot combine --sync-user-language and --no-sync-user-language.';
  }

  parsed.platforms = [...platforms];
  return parsed;
}

function defaultInitPlatforms() {
  return INIT_PLATFORM_CHOICES
    .filter((choice) => choice.defaultForYes)
    .map((choice) => choice.id);
}

function resolveRememberedHosts(existingGlobal) {
  const recorded = Array.isArray(existingGlobal && existingGlobal.hosts)
    ? existingGlobal.hosts
    : [];
  return recorded.filter((host) => SUPPORTED_HOST_IDS.has(host));
}

function resolveSelectedHosts(platforms) {
  const selected = Array.isArray(platforms) ? platforms : [];
  const filtered = selected.filter((host) => SUPPORTED_HOST_IDS.has(host));
  return [...new Set(filtered)].sort((a, b) => a.localeCompare(b));
}

function formatInitHostFlagsForExample(platforms = []) {
  const selectedPlatforms = Array.isArray(platforms) && platforms.length > 0
    ? platforms
    : defaultInitPlatforms();
  return selectedPlatforms.map((platform) => `--${platform}`).join(' ') || '--codex';
}

function formatInitTargetFlagsForExample(parsed) {
  if (parsed.allRepos) {
    return ' --all-repos';
  }
  if (parsed.repo) {
    return ` --repo ${quoteInitExampleArg(parsed.repo)}`;
  }
  return '';
}

function quoteInitExampleArg(value) {
  const raw = String(value || '');
  return /^[A-Za-z0-9_./:-]+$/.test(raw) ? raw : JSON.stringify(raw);
}

function normalizeSupportedLang(value) {
  return value === 'zh' || value === 'en' ? value : '';
}

function normalizeInitPlatform(platform) {
  if (SUPPORTED_HOST_IDS.has(platform)) {
    return platform;
  }
  throw new Error(`Unknown init platform: ${platform || ''}`);
}

function initPlatformLabel(platform) {
  const choice = INIT_PLATFORM_CHOICES.find((candidate) => candidate.id === platform);
  return choice ? choice.label : platform;
}

function hostDisplayName(platform) {
  return getPlatformDisplayName(platform);
}

function hostMcpSetupCommand(platform) {
  return '`spec-runtime-setup`';
}

module.exports = {
  INIT_PLATFORM_CHOICES,
  SUPPORTED_HOST_IDS,
  defaultInitPlatforms,
  formatInitHostFlagsForExample,
  formatInitTargetFlagsForExample,
  hostDisplayName,
  hostMcpSetupCommand,
  initPlatformLabel,
  normalizeInitPlatform,
  normalizeSupportedLang,
  parseInitArgs,
  resolveRememberedHosts,
  resolveSelectedHosts,
};
