'use strict';

const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '../..');
const readmePath = path.join(repoRoot, 'README.md');
const readmeEnPath = path.join(repoRoot, 'README.en.md');
const readmeZhCompatPath = path.join(repoRoot, 'README.zh-CN.md');
const demoZhPath = path.join(repoRoot, 'docs/assets/readme/spec-first-cli-workflow-demo.svg');
const demoEnPath = path.join(repoRoot, 'docs/assets/readme/spec-first-cli-workflow-demo.en.svg');
const readme = fs.readFileSync(readmePath, 'utf8');
const readmeEn = fs.readFileSync(readmeEnPath, 'utf8');
const readmeZhCompat = fs.readFileSync(readmeZhCompatPath, 'utf8');
const demoZh = fs.readFileSync(demoZhPath, 'utf8');
const demoEn = fs.readFileSync(demoEnPath, 'utf8');

function headings(markdown) {
  return [...markdown.matchAll(/^## (.+)$/gm)].map((match) => match[1]);
}

function section(markdown, heading) {
  const start = markdown.indexOf(`## ${heading}`);
  if (start < 0) return '';
  const remaining = markdown.slice(start);
  const next = remaining.indexOf('\n## ', 4);
  return next < 0 ? remaining : remaining.slice(0, next);
}

function expectOrdered(content, values) {
  let cursor = -1;
  for (const value of values) {
    const next = content.indexOf(value);
    expect(next).toBeGreaterThan(cursor);
    cursor = next;
  }
}

function repositoryLinks(markdown) {
  const root = 'https://github.com/sunrain520/spec-first/blob/master/';
  return [...markdown.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)]
    .map((match) => match[1])
    .map((target) => target.startsWith(root) ? target.slice(root.length) : target)
    .filter((target) => !/^(?:https?:|#|mailto:)/.test(target))
    .map((target) => decodeURIComponent(target.split('#')[0]));
}

describe('README community entry contract', () => {
  test('keeps Chinese as the default with an English entry and a compatible legacy path', () => {
    expect(headings(readme)).toEqual([
      '为什么使用 spec-first？',
      '快速开始',
      '选择合适的 Workflow',
      '从 Prompt 到可信变更',
      '仓库会留下什么',
      '信任如何建立',
      '宿主支持',
      '适用边界',
      'CLI 参考',
      '开发与贡献',
      '相关文档',
      '加入社区',
    ]);
    expect(headings(readmeEn)).toEqual([
      'Why spec-first?',
      'Quick start',
      'Choose the Right Workflow',
      'From Prompt to Trusted Change',
      'What Stays in the Repository',
      'How Trust Works',
      'Host Support',
      'When It Fits',
      'CLI Reference',
      'Development & Contributing',
      'Documentation',
      'Community',
    ]);
    expect(readme).toContain('把 AI coding 会话变成可信、由项目拥有的变更。');
    expect(readmeEn).toContain('Turn AI coding sessions into trusted, project-owned changes.');
    expect(readmeZhCompat).toBe(readme);
    for (const markdown of [readme, readmeEn, readmeZhCompat]) {
      expect(markdown).toContain('(README.en.md)');
      expect(markdown).toContain('(README.md)');
    }
    expect(Buffer.byteLength(readme)).toBeLessThanOrEqual(16 * 1024);
    expect(Buffer.byteLength(readmeEn)).toBeLessThanOrEqual(16 * 1024);
    expect(Buffer.byteLength(readmeZhCompat)).toBeLessThanOrEqual(16 * 1024);
  });

  test('keeps the first-run path short and observable', () => {
    expectOrdered(readmeEn, [
      'npm install -g spec-first',
      'spec-first quickstart',
      'Restart the selected host',
      'spec-runtime-setup',
      'spec-brainstorm "Improve CLI onboarding for new users"',
      'docs/plans/YYYY-MM-DD-NNN-<type>-<topic>-plan.md',
    ]);
    expectOrdered(readme, [
      'npm install -g spec-first',
      'spec-first quickstart',
      '重启已选择的宿主',
      'spec-runtime-setup',
      'spec-brainstorm "改进 CLI 新用户 onboarding"',
      'docs/plans/YYYY-MM-DD-NNN-<type>-<topic>-plan.md',
    ]);

    for (const quickstart of [section(readmeEn, 'Quick start'), section(readme, '快速开始')]) {
      expect(quickstart).toContain('Node.js `>=20.0.0`');
      expect(quickstart).toContain('spec-first init --codex -y -u <name> --lang <zh|en>');
      expect(quickstart).toContain('spec-first doctor --verbose');
      expect(quickstart).toContain('docs/catalog/runtime-capabilities.md');
      for (const implementationDetail of [
        'Graphify',
        'CodeGraph',
        'workspace-graph',
        'core.hooksPath',
        'opencode.json',
        'agent-browser',
        'CAS',
      ]) {
        expect(quickstart).not.toContain(implementationDetail);
      }
    }
    expect(section(readme, '快速开始')).toContain('workflow 可以合法地不创建文档；这不表示运行失败');
    expect(section(readmeEn, 'Quick start')).toContain(
      'the workflow may legitimately skip writing a document; that is not a failure',
    );
  });

  test('keeps core workflows, trust claims, and host posture equivalent', () => {
    const sharedClaims = [
      'spec-ideate',
      'spec-brainstorm',
      'spec-prd',
      'spec-plan',
      'spec-write-tasks',
      'spec-work',
      'spec-debug',
      'spec-doc-review',
      'spec-code-review',
      'spec-compound',
      'Claude Code',
      'Codex',
      'Kiro',
      'Qoder',
      'Cursor',
      'OpenCode',
      'generated_runtime_preview',
      'docs/contracts/source-runtime-customization-boundary.md',
      'docs/catalog/runtime-capabilities.md',
    ];
    for (const claim of sharedClaims) {
      expect(readme).toContain(claim);
      expect(readmeEn).toContain(claim);
      expect(readmeZhCompat).toContain(claim);
    }

    expect(readme).toContain('spec-prd');
    expect(readme).toContain('spec-doc-review');
    expect(readmeEn).toContain('spec-prd');
    expect(readmeEn).toContain('spec-doc-review');
    expect(section(readme, '从 Prompt 到可信变更')).toContain('已有 PRD 或 brownfield 请求的替代入口');
    expect(section(readmeEn, 'From Prompt to Trusted Change')).toContain(
      'the alternative entry for an existing PRD or brownfield request',
    );
    expect(section(readme, '从 Prompt 到可信变更')).toContain('跨阶段的可选 review lane');
    expect(section(readmeEn, 'From Prompt to Trusted Change')).toContain(
      'an optional cross-stage review lane',
    );

    for (const [markdown, heading] of [
      [readme, '宿主支持'],
      [readmeEn, 'Host Support'],
      [readmeZhCompat, '宿主支持'],
    ]) {
      const cliReference = section(markdown, heading);
      expect(cliReference).toContain('spec-first doctor --verbose');
      expect(cliReference).toContain('docs/catalog/runtime-capabilities.md');
      expect(cliReference).toContain('Cursor');
      expect(cliReference).toContain('OpenCode');
    }

    for (const markdown of [readme, readmeEn, readmeZhCompat]) {
      for (const referenceDetail of [
        '.opencode/commands/spec-*.md',
        'opencode.jsonc',
        'core.hooksPath',
        'workspace-child-hook-contract',
        'exact-origin-capability-unavailable',
      ]) {
        expect(markdown).not.toContain(referenceDetail);
      }
    }
  });

  test('keeps open-source trust signals and repository links valid', () => {
    for (const markdown of [readme, readmeEn, readmeZhCompat]) {
      expect(markdown).toContain('[![npm version]');
      expect(markdown).toContain('[![license]');
      expect(markdown).toContain('npm-install-matrix.yml');
      expect(markdown).toContain('http://spec-first.cn/');
      expect(markdown).not.toContain('docs/reviews');
      expect(markdown).not.toContain('blob/main');
      expect(markdown).not.toContain('/main/docs/');
      const targets = repositoryLinks(markdown);
      expect(targets.length).toBeGreaterThan(0);
      for (const target of targets) {
        expect(fs.existsSync(path.join(repoRoot, target))).toBe(true);
      }
    }
    expect(fs.existsSync(demoZhPath)).toBe(true);
    expect(fs.existsSync(demoEnPath)).toBe(true);
    expect(readme).toContain('docs/assets/readme/spec-first-cli-workflow-demo.svg)');
    expect(readmeEn).toContain('docs/assets/readme/spec-first-cli-workflow-demo.en.svg)');
    expect(readmeEn).not.toContain('docs/assets/readme/spec-first-cli-workflow-demo.svg)');

    for (const demo of [demoZh, demoEn]) {
      expect(demo).toContain('aria-labelledby="title desc"');
      for (const label of ['Scripts / Tools', 'LLM / Agents', 'Project owner', 'canonical source', 'verification evidence', 'durable knowledge']) {
        expect(demo).toContain(label);
      }
      expect(demo).not.toContain('@keyframes');
      expect(demo).not.toContain('findings resolved');
      expect(demo).not.toContain('spec-mcp-setup');
      expect(demo).not.toContain('reviews/');
    }
    expect(demoEn).not.toMatch(/[\u3400-\u9fff]/u);
  });
});
