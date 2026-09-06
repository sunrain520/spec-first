'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const {
  runProcess,
  runProcessSync,
  runProcessWithMirror,
} = require('../../skills/spec-runtime-setup/scripts/lib/process-runner.cjs');
const {
  compareMcpSection,
  extractMcpSection,
  removeMcpSection,
  upsertMcpSection,
} = require('../../skills/spec-runtime-setup/scripts/lib/toml-section-editor.cjs');
const {
  acquireConfigLock,
  applyHostConfig,
  inspectHostConfig,
  resolveHostConfigTarget,
} = require('../../skills/spec-runtime-setup/scripts/lib/host-config.cjs');
const {
  resolveHostAuthority,
} = require('../../skills/spec-runtime-setup/scripts/lib/host-authority.cjs');

function tempDir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `spec-mcp-u4-${label}-`));
}

function codedError(code, message = code) {
  return Object.assign(new Error(message), { code });
}

function jsonEntry(overrides = {}) {
  return {
    id: 'context7',
    detection: { key: 'context7' },
    host_config: {
      command: 'npx',
      args: ['-y', '@upstash/context7-mcp@latest'],
      targets: {
        project: {
          config_path: '.cursor/mcp.json',
          config_format: 'json',
          precedence: 10,
        },
        user: {
          config_path: '$HOME/.cursor/mcp.json',
          config_format: 'json',
          precedence: 20,
          requires_user_scope: true,
        },
      },
      fallback_order: ['project', 'user'],
    },
    ...overrides,
  };
}

function codexEntry(overrides = {}) {
  return {
    id: 'context7',
    detection: { key: 'context7' },
    host_config: {
      command: 'npx',
      args: ['-y', '@upstash/context7-mcp@latest'],
      startup_timeout_sec: 20,
      targets: {
        user: {
          config_path: '$HOME/.codex/config.toml',
          config_format: 'toml',
          precedence: 10,
        },
        system: {
          config_path: '$HOME/.codex/system.toml',
          config_format: 'toml',
          precedence: 20,
        },
      },
      fallback_order: ['user', 'system'],
    },
    ...overrides,
  };
}

function openCodeEntry(overrides = {}) {
  return {
    id: 'context7',
    detection: { key: 'context7' },
    host_config: {
      command: 'npx',
      args: ['-y', '@upstash/context7-mcp@latest'],
      env: { CONTEXT7_API_KEY: '${CONTEXT7_API_KEY}' },
      json_container_path: ['mcp'],
      server_representation: 'opencode-local',
      targets: {
        project: {
          config_path: 'opencode.json',
          config_format: 'json',
          precedence: 100,
          precedence_guards: [{
            config_path: 'opencode.jsonc',
            config_format: 'jsonc',
            precedence: 110,
            reason_code: 'host-config-jsonc-precedence-blocked',
          }],
        },
        user: {
          config_path: '${XDG_CONFIG_HOME}/opencode/opencode.json',
          config_format: 'json',
          precedence: 50,
          requires_user_scope_opt_in: true,
          precedence_guards: [{
            config_path: '${XDG_CONFIG_HOME}/opencode/opencode.jsonc',
            config_format: 'jsonc',
            precedence: 60,
            reason_code: 'host-config-jsonc-precedence-blocked',
          }],
        },
      },
      fallback_order: ['project'],
      uninstall_targets: ['project', 'user'],
    },
    ...overrides,
  };
}

function authority(host, scope) {
  return {
    ok: true,
    explicit: true,
    mutation_allowed: true,
    host,
    ...(scope ? { scope } : {}),
  };
}

describe('process-runner raw execution contract', () => {
  test('uses argv arrays, per-call env, bounded output, and redacts every returned surface', async () => {
    const original = process.env.SPEC_FIRST_U4_SECRET;
    delete process.env.SPEC_FIRST_U4_SECRET;

    try {
      const result = await runProcess({
        command: process.execPath,
        args: [
          '-e',
          'process.stdout.write(process.env.SPEC_FIRST_U4_SECRET + "\\n" + "x".repeat(100)); process.stderr.write("Authorization: Bearer token-123")',
          'token-123',
        ],
        env: {
          SPEC_FIRST_U4_SECRET: 'token-123',
        },
        redactValues: ['token-123'],
        maxOutputBytes: 32,
        invocationSource: 'primary',
      });

      expect(process.env.SPEC_FIRST_U4_SECRET).toBeUndefined();
      expect(result.exit_code).toBe(0);
      expect(result.argv.join(' ')).not.toContain('token-123');
      expect(JSON.stringify(result.env_overlay)).not.toContain('token-123');
      expect(result.stdout).not.toContain('token-123');
      expect(result.stderr).not.toContain('token-123');
      expect(result.stdout_truncated).toBe(true);
      expect(result.invocation_source).toBe('primary');
      expect(result).not.toHaveProperty('ready');
      expect(result).not.toHaveProperty('status');
    } finally {
      if (original === undefined) delete process.env.SPEC_FIRST_U4_SECRET;
      else process.env.SPEC_FIRST_U4_SECRET = original;
    }
  });

  test('returns nonzero and command-not-found as redacted raw facts without semantic mapping', async () => {
    const nonzero = await runProcess({
      command: process.execPath,
      args: ['-e', 'process.stderr.write("password=hunter2"); process.exit(7)'],
      redactValues: ['hunter2'],
    });
    expect(nonzero.exit_code).toBe(7);
    expect(nonzero.stderr).toContain('[REDACTED]');
    expect(nonzero).not.toHaveProperty('status');

    const missing = await runProcess({
      command: `spec-first-command-that-does-not-exist-${Date.now()}`,
      args: ['--token=literal-secret'],
      redactValues: ['literal-secret'],
    });
    expect(missing.exit_code).toBeNull();
    expect(missing.error.code).toBe('ENOENT');
    expect(JSON.stringify(missing)).not.toContain('literal-secret');
  });

  test('derives redaction values from sensitive argv pairs and inline credentials', () => {
    const secret = 'audit-super-secret-value-7391';
    const inlineSecret = 'inline-api-key-8842';
    const result = runProcessSync({
      command: process.execPath,
      args: [
        '-e',
        'process.stdout.write(process.argv.slice(1).join(" "))',
        '--',
        '--token',
        secret,
        `--api-key=${inlineSecret}`,
        `https://user:${secret}@example.test/resource`,
      ],
      timeoutMs: 10000,
    });

    expect(result.exit_code).toBe(0);
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(JSON.stringify(result)).not.toContain(inlineSecret);
    expect(result.argv.join(' ')).toContain('[REDACTED]');
    expect(result.stdout).toContain('[REDACTED]');
  });

  test('times out and terminates descendants instead of leaving a delayed child alive', async () => {
    const dir = tempDir('runner-tree');
    const marker = path.join(dir, 'descendant-survived');
    const grandchild = [
      'const fs = require("node:fs");',
      `setTimeout(() => fs.writeFileSync(${JSON.stringify(marker)}, "alive"), 650);`,
      'setTimeout(() => {}, 2000);',
    ].join('');
    const parent = [
      'const { spawn } = require("node:child_process");',
      `spawn(process.execPath, ["-e", ${JSON.stringify(grandchild)}], { stdio: "ignore" });`,
      'setTimeout(() => {}, 2000);',
    ].join('');

    const result = await runProcess({
      command: process.execPath,
      args: ['-e', parent],
      timeoutMs: 100,
      terminationGraceMs: 50,
    });

    expect(result.timed_out).toBe(true);
    expect(result.termination.attempted).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 850));
    expect(fs.existsSync(marker)).toBe(false);
  });

  test('mirror fallback affects only the second invocation and preserves both attempts', async () => {
    const result = await runProcessWithMirror({
      primary: {
        command: process.execPath,
        args: ['-e', 'process.exit(9)'],
        invocationSource: 'primary-registry',
      },
      mirror: {
        command: process.execPath,
        args: ['-e', 'process.stdout.write("mirror-ok")'],
        invocationSource: 'configured-mirror',
      },
    });

    expect(result.exit_code).toBe(0);
    expect(result.stdout).toBe('mirror-ok');
    expect(result.invocation_source).toBe('configured-mirror');
    expect(result.mirror_attempted).toBe(true);
    expect(result.attempts).toHaveLength(2);
    expect(result.attempts[0].exit_code).toBe(9);
    expect(result.attempts[1].exit_code).toBe(0);
  });
});

describe('grammar-bounded Codex TOML section editor', () => {
  test('handles BOM, CRLF, quoted/dotted table keys, multiline-string fake headers, and preserves non-target bytes', () => {
    const text = [
      '\uFEFF# lead',
      'title = "demo"',
      'note = """',
      '[mcp_servers.context7]',
      'not = "a real table"',
      '"""',
      '',
      '["mcp_servers"."context7"]',
      'command = "old"',
      'args = ["--old"]',
      'metadata = { owner = "user", flags = ["a", "b"] } # preserve',
      '',
      '[other.section]',
      'value = [1, 2, 3]',
      '',
    ].join('\r\n');

    const extracted = extractMcpSection(text, 'context7');
    expect(extracted.ok).toBe(true);
    expect(extracted.found).toBe(true);
    expect(extracted.section).toContain('command = "old"');

    const updated = upsertMcpSection(text, 'context7', {
      command: 'npx',
      args: ['-y', '@upstash/context7-mcp@latest'],
      startup_timeout_sec: 20,
    });
    expect(updated.ok).toBe(true);
    expect(updated.text.startsWith('\uFEFF')).toBe(true);
    expect(updated.text).toContain('\r\n');
    expect(updated.text).toContain('metadata = { owner = "user", flags = ["a", "b"] } # preserve');
    expect(updated.text).toContain('[other.section]\r\nvalue = [1, 2, 3]');
    expect(updated.text).toContain('note = """\r\n[mcp_servers.context7]\r\nnot = "a real table"\r\n"""');
    expect(compareMcpSection(updated.text, 'context7', {
      command: 'npx',
      args: ['-y', '@upstash/context7-mcp@latest'],
      startup_timeout_sec: 20,
    })).toMatchObject({ ok: true, matches: true });
  });

  test('fails closed on duplicate target tables and malformed multiline grammar', () => {
    const duplicate = [
      '[mcp_servers.context7]',
      'command = "one"',
      '[mcp_servers."context7"]',
      'command = "two"',
      '',
    ].join('\n');
    expect(extractMcpSection(duplicate, 'context7')).toMatchObject({
      ok: false,
      reason_code: 'toml-target-table-duplicate',
    });

    const malformed = 'note = """unterminated\n[mcp_servers.context7]\ncommand = "fake"\n';
    expect(upsertMcpSection(malformed, 'context7', { command: 'npx', args: [] })).toMatchObject({
      ok: false,
      reason_code: 'toml-grammar-ambiguous',
    });
  });

  test('removes only the target table and preserves unrelated sections and line endings', () => {
    const text = [
      '[mcp_servers.alpha]',
      'command = "alpha"',
      '',
      '[mcp_servers."context7"]',
      'command = "npx"',
      'args = ["-y"]',
      '',
      '[mcp_servers.omega]',
      'command = "omega"',
      '',
    ].join('\r\n');
    const removed = removeMcpSection(text, 'context7');
    expect(removed.ok).toBe(true);
    expect(removed.changed).toBe(true);
    expect(removed.text).toContain('[mcp_servers.alpha]\r\ncommand = "alpha"');
    expect(removed.text).toContain('[mcp_servers.omega]\r\ncommand = "omega"');
    expect(removed.text).not.toContain('mcp_servers."context7"');
  });
});

describe('host config resolution, inspection, and transaction', () => {
  test('resolves OpenCode project config by default and requires explicit user scope with XDG fallback', () => {
    const repoRoot = tempDir('opencode-target-repo');
    const homeDir = tempDir('opencode-target-home');
    const entry = openCodeEntry();

    expect(resolveHostConfigTarget({
      entry,
      host: 'opencode',
      authority: authority('opencode'),
      repoRoot,
      homeDir,
      env: {},
    })).toMatchObject({
      ok: true,
      scope: 'project',
      config_path: path.join(repoRoot, 'opencode.json'),
      json_container_path: ['mcp'],
      server_representation: 'opencode-local',
    });

    expect(resolveHostConfigTarget({
      entry,
      host: 'opencode',
      scope: 'user',
      authority: authority('opencode', 'user'),
      repoRoot,
      homeDir,
      env: {},
      userScope: false,
    })).toMatchObject({ ok: false, reason_code: 'host-user-scope-not-authorized' });

    expect(resolveHostConfigTarget({
      entry,
      host: 'opencode',
      authority: authority('opencode'),
      repoRoot,
      homeDir,
      env: {},
      userScope: true,
    })).toMatchObject({
      ok: true,
      scope: 'user',
      config_path: path.join(homeDir, '.config', 'opencode', 'opencode.json'),
    });

    const xdgConfigHome = tempDir('opencode-custom-xdg');
    expect(resolveHostConfigTarget({
      entry,
      host: 'opencode',
      authority: authority('opencode'),
      repoRoot,
      homeDir,
      env: { XDG_CONFIG_HOME: xdgConfigHome },
      userScope: true,
    })).toMatchObject({
      ok: true,
      scope: 'user',
      config_path: path.join(xdgConfigHome, 'opencode', 'opencode.json'),
    });
  });

  test('writes the OpenCode native mcp container and local server representation', () => {
    const repoRoot = tempDir('opencode-json-repo');
    const homeDir = tempDir('opencode-json-home');
    const entry = openCodeEntry();
    const target = resolveHostConfigTarget({
      entry,
      host: 'opencode',
      authority: authority('opencode'),
      repoRoot,
      homeDir,
      env: {},
    });
    const original = '\uFEFF{\r\n  "theme": "dark",\r\n  "mcp": {\r\n    "keep": { "type": "remote", "url": "https://example.test/mcp" }\r\n  }\r\n}\r\n';
    fs.writeFileSync(target.config_path, original);
    fs.chmodSync(target.config_path, 0o640);

    expect(applyHostConfig({ entry, target })).toMatchObject({
      ok: true,
      changed: true,
      reason_code: 'host-config-updated',
      post_write_verified: true,
    });
    const written = fs.readFileSync(target.config_path, 'utf8');
    expect(written.startsWith('\uFEFF')).toBe(true);
    expect(written).toContain('\r\n');
    const parsed = JSON.parse(written.slice(1));
    expect(parsed.theme).toBe('dark');
    expect(parsed.mcp.keep).toEqual({ type: 'remote', url: 'https://example.test/mcp' });
    expect(parsed.mcp.context7).toEqual({
      type: 'local',
      command: ['npx', '-y', '@upstash/context7-mcp@latest'],
      environment: { CONTEXT7_API_KEY: '${CONTEXT7_API_KEY}' },
    });
    expect(parsed).not.toHaveProperty('mcpServers');
    if (process.platform !== 'win32') expect(fs.statSync(target.config_path).mode & 0o777).toBe(0o640);
  });

  test('blocks OpenCode JSON mutation when a higher-precedence JSONC sibling exists', () => {
    const repoRoot = tempDir('opencode-jsonc-repo');
    const homeDir = tempDir('opencode-jsonc-home');
    const entry = openCodeEntry();
    const target = resolveHostConfigTarget({
      entry,
      host: 'opencode',
      authority: authority('opencode'),
      repoRoot,
      homeDir,
      env: {},
    });
    const jsoncPath = path.join(repoRoot, 'opencode.jsonc');
    const jsonc = '{\n  // user-owned\n  "mcp": {}\n}\n';
    fs.writeFileSync(jsoncPath, jsonc);

    expect(inspectHostConfig({ entry, target })).toMatchObject({
      ok: false,
      configured: false,
      reason_code: 'host-config-jsonc-precedence-blocked',
      blocking_path: jsoncPath,
    });
    expect(applyHostConfig({ entry, target })).toMatchObject({
      ok: false,
      reason_code: 'host-config-jsonc-precedence-blocked',
    });
    expect(fs.existsSync(target.config_path)).toBe(false);
    expect(fs.readFileSync(jsoncPath, 'utf8')).toBe(jsonc);
    expect(fs.readdirSync(repoRoot).filter((name) => name.includes('.spec-first.'))).toEqual([]);
  });

  test('uses OpenCode 1.18.7 project-over-user precedence and does not mistake user config for the effective project target', () => {
    const repoRoot = tempDir('opencode-project-precedence-repo');
    const homeDir = tempDir('opencode-project-precedence-home');
    const xdgRoot = path.join(homeDir, 'xdg');
    const entry = openCodeEntry();
    const projectTarget = resolveHostConfigTarget({
      entry,
      host: 'opencode',
      authority: authority('opencode'),
      repoRoot,
      homeDir,
      env: { XDG_CONFIG_HOME: xdgRoot },
    });
    const userTarget = resolveHostConfigTarget({
      entry,
      host: 'opencode',
      authority: authority('opencode'),
      repoRoot,
      homeDir,
      env: { XDG_CONFIG_HOME: xdgRoot },
      userScope: true,
    });

    fs.mkdirSync(path.dirname(userTarget.config_path), { recursive: true });
    fs.writeFileSync(userTarget.config_path, JSON.stringify({
      mcp: {
        context7: {
          type: 'local',
          command: ['/usr/bin/false'],
        },
      },
    }));
    fs.writeFileSync(projectTarget.config_path, JSON.stringify({
      mcp: {
        context7: projectTarget.server,
      },
    }));

    expect(inspectHostConfig({ entry, target: projectTarget })).toMatchObject({
      ok: true,
      configured: true,
      reason_code: 'host-config-current',
      effective_scope: 'project',
      effective_path: projectTarget.config_path,
    });
    expect(inspectHostConfig({ entry, target: userTarget })).toMatchObject({
      ok: true,
      configured: true,
      reason_code: 'host-config-higher-precedence-current',
      effective_scope: 'project',
      effective_path: projectTarget.config_path,
    });
  });

  test('requires explicit matching authority and user-scope opt-in', () => {
    const repoRoot = tempDir('authority-repo');
    const homeDir = tempDir('authority-home');
    const entry = jsonEntry();

    expect(resolveHostConfigTarget({
      entry,
      host: 'cursor',
      authority: { host: 'cursor', explicit: false },
      repoRoot,
      homeDir,
    })).toMatchObject({ ok: false, reason_code: 'host-authority-not-explicit' });

    expect(resolveHostConfigTarget({
      entry,
      host: 'cursor',
      scope: 'user',
      authority: authority('cursor', 'user'),
      repoRoot,
      homeDir,
      userScope: false,
    })).toMatchObject({ ok: false, reason_code: 'host-user-scope-not-authorized' });

    expect(resolveHostConfigTarget({
      entry,
      host: 'cursor',
      authority: authority('codex'),
      repoRoot,
      homeDir,
    })).toMatchObject({ ok: false, reason_code: 'host-authority-mismatch' });

    expect(resolveHostConfigTarget({
      entry,
      host: 'cursor',
      authority: {
        status: 'ready',
        host: 'cursor',
        authority_source: 'MCP_SETUP_HOST',
        mutation_authorized: true,
      },
      repoRoot,
      homeDir,
    })).toMatchObject({ ok: true, reason_code: 'host-config-target-resolved' });

    const optInEntry = jsonEntry();
    optInEntry.host_config.targets.user = {
      ...optInEntry.host_config.targets.user,
      requires_user_scope: undefined,
      requires_user_scope_opt_in: true,
    };
    expect(resolveHostConfigTarget({
      entry: optInEntry,
      host: 'cursor',
      scope: 'user',
      authority: authority('cursor', 'user'),
      repoRoot,
      homeDir,
      userScope: false,
    })).toMatchObject({ ok: false, reason_code: 'host-user-scope-not-authorized' });
  });

  test.each([
    // claude 以 workflow_command 投射 spec-runtime-setup 到 managed workflows 根，
    // 不是 skills 根（旧表用 .claude/skills 与实际投射不符，掩盖了 surface drift）。
    ['claude', '.claude/spec-first/workflows'],
    ['codex', '.agents/skills'],
    ['cursor', '.cursor/skills'],
    ['kiro', '.kiro/skills'],
    ['qoder', '.qoder/skills'],
    ['opencode', '.opencode/skills'],
  ])('accepts confirmed loaded-root-bound authority for %s', (host, surfaceId) => {
    const repoRoot = tempDir(`${host}-surface-bound-repo`);
    const homeDir = tempDir(`${host}-surface-bound-home`);
    const skillRoot = path.join(repoRoot, surfaceId, 'spec-runtime-setup');
    fs.mkdirSync(skillRoot, { recursive: true });
    const authority = resolveHostAuthority({
      env: { MCP_SETUP_HOST: host },
      mutationRequested: true,
      candidates: [host],
      skillRoot,
      targetIdentity: repoRoot,
      enforceSurfaceBinding: true,
    });

    expect(resolveHostConfigTarget({
      entry: jsonEntry(),
      host,
      authority,
      repoRoot,
      homeDir,
    })).toMatchObject({
      ok: true,
      reason_code: 'host-config-target-resolved',
    });
  });

  test('accepts confirmed loaded-root-bound authority without weakening the host gate', () => {
    const repoRoot = tempDir('surface-bound-repo');
    const homeDir = tempDir('surface-bound-home');
    const skillRoot = path.join(repoRoot, '.agents', 'skills', 'spec-runtime-setup');
    fs.mkdirSync(skillRoot, { recursive: true });
    const authority = resolveHostAuthority({
      env: { MCP_SETUP_HOST: 'codex' },
      mutationRequested: true,
      candidates: ['codex'],
      skillRoot,
      targetIdentity: repoRoot,
      enforceSurfaceBinding: true,
    });

    expect(authority).toMatchObject({
      status: 'ready',
      host: 'codex',
      authority_source: 'MCP_SETUP_HOST+loaded-skill-root',
      mutation_authorized: true,
      invocation_receipt: {
        verification_status: 'confirmed',
        host: 'codex',
        loaded_host: 'codex',
        enforcement_status: 'loaded-root-checked',
      },
    });
    expect(resolveHostConfigTarget({
      entry: codexEntry(),
      host: 'codex',
      authority,
      repoRoot,
      homeDir,
    })).toMatchObject({
      ok: true,
      scope: 'user',
      config_path: path.join(homeDir, '.codex', 'config.toml'),
    });

    expect(resolveHostConfigTarget({
      entry: codexEntry(),
      host: 'codex',
      authority: {
        ...authority,
        invocation_receipt: {
          ...authority.invocation_receipt,
          verification_status: 'unverified',
        },
      },
      repoRoot,
      homeDir,
    })).toMatchObject({ ok: false, reason_code: 'host-authority-not-explicit' });

    const forgedReceipt = {
      ...authority.invocation_receipt,
      target_identity: `${repoRoot}-tampered`,
    };
    forgedReceipt.receipt_sha256 = crypto.createHash('sha256')
      .update(JSON.stringify(Object.fromEntries(
        Object.entries(forgedReceipt).filter(([key]) => key !== 'receipt_sha256'),
      )))
      .digest('hex');
    expect(resolveHostConfigTarget({
      entry: codexEntry(),
      host: 'codex',
      authority: {
        ...authority,
        invocation_receipt: forgedReceipt,
      },
      repoRoot,
      homeDir,
    })).toMatchObject({ ok: false, reason_code: 'host-authority-not-explicit' });
  });

  test('skips an unavailable preferred target and selects the next writable fallback', () => {
    const repoRoot = tempDir('fallback-repo');
    const homeDir = tempDir('fallback-home');
    const entry = jsonEntry();
    entry.host_config.scope = 'project';
    entry.host_config.targets.project = {
      config_path: path.join(repoRoot, 'missing-parent', 'managed.json'),
      config_format: 'json',
      precedence: 100,
      writable_check: 'file-only',
    };
    entry.host_config.targets.local = {
      config_path: '.cursor/mcp.json',
      config_format: 'json',
      precedence: 50,
      writable_check: 'parent-or-file',
    };
    entry.host_config.fallback_order = ['project', 'local'];

    expect(resolveHostConfigTarget({
      entry,
      host: 'cursor',
      authority: authority('cursor'),
      repoRoot,
      homeDir,
    })).toMatchObject({
      ok: true,
      scope: 'local',
      config_path: path.join(repoRoot, '.cursor', 'mcp.json'),
    });
  });

  test('finds an effective lower-precedence config when the selected inspection target is missing', () => {
    const repoRoot = tempDir('inspection-repo');
    const homeDir = tempDir('inspection-home');
    const entry = jsonEntry();
    entry.host_config.targets.project.precedence = 100;
    entry.host_config.targets.user = {
      config_path: '$HOME/.cursor/mcp.json',
      config_format: 'json',
      precedence: 10,
    };

    const userPath = path.join(homeDir, '.cursor', 'mcp.json');
    fs.mkdirSync(path.dirname(userPath), { recursive: true });
    fs.writeFileSync(userPath, JSON.stringify({
      mcpServers: {
        context7: {
          command: 'npx',
          args: ['-y', '@upstash/context7-mcp@latest'],
        },
      },
    }));

    const target = resolveHostConfigTarget({
      entry,
      host: 'cursor',
      authority: authority('cursor'),
      repoRoot,
      homeDir,
      requireWritable: false,
    });
    expect(target).toMatchObject({ ok: true, scope: 'project' });
    expect(inspectHostConfig({ entry, target })).toMatchObject({
      ok: true,
      configured: true,
      reason_code: 'host-config-current',
      effective_scope: 'user',
      effective_path: userPath,
    });
  });

  test('treats user-scope as an explicit user target and still inspects unselected higher precedence config', () => {
    const repoRoot = tempDir('user-scope-repo');
    const homeDir = tempDir('user-scope-home');
    const entry = jsonEntry();

    expect(resolveHostConfigTarget({
      entry,
      host: 'cursor',
      authority: authority('cursor'),
      repoRoot,
      homeDir,
      userScope: true,
    })).toMatchObject({
      ok: true,
      scope: 'user',
      config_path: path.join(homeDir, '.cursor', 'mcp.json'),
    });

    const userPath = path.join(homeDir, '.cursor', 'mcp.json');
    fs.mkdirSync(path.dirname(userPath), { recursive: true });
    fs.writeFileSync(userPath, JSON.stringify({
      mcpServers: { context7: { command: 'user-owned', args: [] } },
    }));
    const projectTarget = resolveHostConfigTarget({
      entry,
      host: 'cursor',
      authority: authority('cursor'),
      repoRoot,
      homeDir,
      userScope: false,
    });
    expect(projectTarget.scope).toBe('project');
    expect(inspectHostConfig({ entry, target: projectTarget })).toMatchObject({
      ok: false,
      reason_code: 'host-config-higher-precedence-conflict',
      blocking_scope: 'user',
    });
  });

  test('resolves registry target, rejects symlink escape, and reports higher-precedence conflicts', () => {
    const repoRoot = tempDir('target-repo');
    const homeDir = tempDir('target-home');
    fs.mkdirSync(path.join(repoRoot, '.cursor'), { recursive: true });
    const outside = tempDir('target-outside');
    const symlinkPath = path.join(repoRoot, '.cursor', 'mcp.json');
    try {
      fs.symlinkSync(path.join(outside, 'mcp.json'), symlinkPath);
      expect(resolveHostConfigTarget({
        entry: jsonEntry(),
        host: 'cursor',
        authority: authority('cursor', 'project'),
        repoRoot,
        homeDir,
      })).toMatchObject({ ok: false, reason_code: 'host-config-symlink-rejected' });
    } finally {
      try { fs.unlinkSync(symlinkPath); } catch (_error) { /* 平台可能拒绝 symlink */ }
    }

    const entry = codexEntry();
    const systemPath = path.join(homeDir, '.codex', 'system.toml');
    fs.mkdirSync(path.dirname(systemPath), { recursive: true });
    fs.writeFileSync(systemPath, '[mcp_servers.context7]\ncommand = "different"\nargs = []\n');
    const target = resolveHostConfigTarget({
      entry,
      host: 'codex',
      scope: 'user',
      authority: authority('codex', 'user'),
      repoRoot,
      homeDir,
    });
    expect(target.ok).toBe(true);
    expect(inspectHostConfig({ entry, target })).toMatchObject({
      ok: false,
      reason_code: 'host-config-higher-precedence-conflict',
      blocking_scope: 'system',
    });

    fs.rmSync(systemPath, { force: true });
    fs.mkdirSync(systemPath);
    expect(inspectHostConfig({ entry, target })).toMatchObject({
      ok: false,
      reason_code: 'host-config-higher-precedence-unreadable',
      blocking_scope: 'system',
      cause_reason_code: 'host-config-unreadable',
    });
  });

  test('JSON upsert is idempotent, preserves other servers/mode, guards conflicts and literals secrets', () => {
    const repoRoot = tempDir('json-repo');
    const homeDir = tempDir('json-home');
    const target = resolveHostConfigTarget({
      entry: jsonEntry(),
      host: 'cursor',
      authority: authority('cursor', 'project'),
      repoRoot,
      homeDir,
    });
    fs.mkdirSync(path.dirname(target.config_path), { recursive: true });
    fs.writeFileSync(target.config_path, JSON.stringify({
      theme: 'dark',
      mcpServers: { existing: { command: 'existing', args: [] } },
    }, null, 2));
    fs.chmodSync(target.config_path, 0o640);
    const originalReadonly = (fs.statSync(target.config_path).mode & 0o222) === 0;

    const first = applyHostConfig({ entry: jsonEntry(), target });
    expect(first).toMatchObject({ ok: true, changed: true, reason_code: 'host-config-updated' });
    const parsed = JSON.parse(fs.readFileSync(target.config_path, 'utf8'));
    expect(parsed.theme).toBe('dark');
    expect(parsed.mcpServers.existing.command).toBe('existing');
    expect(parsed.mcpServers.context7.command).toBe('npx');
    const writtenMode = fs.statSync(target.config_path).mode & 0o777;
    expect((writtenMode & 0o222) === 0).toBe(originalReadonly);
    if (process.platform !== 'win32') expect(writtenMode).toBe(0o640);

    expect(applyHostConfig({ entry: jsonEntry(), target })).toMatchObject({
      ok: true,
      changed: false,
      reason_code: 'host-config-already-current',
    });

    parsed.mcpServers.context7.command = 'user-owned';
    fs.writeFileSync(target.config_path, JSON.stringify(parsed, null, 2));
    expect(applyHostConfig({ entry: jsonEntry(), target })).toMatchObject({
      ok: false,
      reason_code: 'host-config-conflict',
    });
    expect(inspectHostConfig({ entry: jsonEntry(), target })).toMatchObject({
      conflict: true,
      reason_code: 'host-config-conflict',
      conflict_fields: ['command'],
    });
    expect(applyHostConfig({ entry: jsonEntry(), target, overwrite: true })).toMatchObject({
      ok: true,
      changed: true,
    });

    const secretEntry = jsonEntry({
      host_config: {
        ...jsonEntry().host_config,
        env: { API_TOKEN: 'super-private-credential-42' },
      },
    });
    expect(applyHostConfig({ entry: secretEntry, target, overwrite: true })).toMatchObject({
      ok: false,
      reason_code: 'host-config-literal-secret-rejected',
    });
    expect(JSON.stringify(applyHostConfig({ entry: secretEntry, target, overwrite: true })))
      .not.toContain('super-private-credential-42');
  });

  test('reports TOML conflict fields without exposing conflicting values', () => {
    const repoRoot = tempDir('toml-conflict-repo');
    const homeDir = tempDir('toml-conflict-home');
    const entry = codexEntry();
    const target = resolveHostConfigTarget({
      entry,
      host: 'codex',
      authority: authority('codex', 'user'),
      repoRoot,
      homeDir,
    });
    fs.mkdirSync(path.dirname(target.config_path), { recursive: true });
    fs.writeFileSync(target.config_path, [
      '[mcp_servers.context7]',
      'command = "user-owned"',
      'args = []',
      'startup_timeout_sec = 10',
      '',
    ].join('\n'));

    const inspected = inspectHostConfig({ entry, target });
    expect(inspected).toMatchObject({
      conflict: true,
      reason_code: 'host-config-conflict',
      conflict_fields: expect.arrayContaining(['command', 'args', 'startup_timeout_sec']),
    });
    expect(JSON.stringify(inspected)).not.toContain('user-owned');
  });

  test('retries a transient Windows replace and preserves verified read-only semantics', () => {
    const repoRoot = tempDir('windows-retry-repo');
    const homeDir = tempDir('windows-retry-home');
    const entry = jsonEntry();
    const target = resolveHostConfigTarget({
      entry,
      host: 'cursor',
      authority: authority('cursor', 'project'),
      repoRoot,
      homeDir,
    });
    fs.mkdirSync(path.dirname(target.config_path), { recursive: true });
    fs.writeFileSync(target.config_path, JSON.stringify({
      mcpServers: { keep: { command: 'keep', args: [] } },
    }, null, 2));
    fs.chmodSync(target.config_path, 0o444);
    const renameCalls = [];
    const sleep = jest.fn();
    const renameSync = (sourcePath, destinationPath, context) => {
      renameCalls.push({ sourcePath, destinationPath, ...context });
      if (context.stage === 'direct-replace' && context.attempt === 1) {
        throw codedError('EPERM', 'injected transient Windows contention');
      }
      if (context.stage === 'direct-replace' && fs.existsSync(destinationPath)) {
        fs.chmodSync(destinationPath, 0o666);
        fs.rmSync(destinationPath, { force: true });
      }
      fs.renameSync(sourcePath, destinationPath);
    };

    const result = applyHostConfig({
      entry,
      target,
      replace: {
        platform: 'win32',
        retryAttempts: 3,
        retryDelayMs: 0,
        renameSync,
        sleep,
      },
    });

    expect(result).toMatchObject({
      ok: true,
      changed: true,
      reason_code: 'host-config-updated',
      post_write_verified: true,
      lock_release_status: 'released',
    });
    expect(renameCalls.filter((call) => call.stage === 'direct-replace')).toHaveLength(2);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(fs.statSync(target.config_path).mode & 0o222).toBe(0);
    expect(inspectHostConfig({ entry, target })).toMatchObject({
      ok: true,
      configured: true,
      reason_code: 'host-config-current',
    });
  });

  test('restores original bytes when the bounded Windows replace retries are exhausted', () => {
    const repoRoot = tempDir('windows-exhausted-repo');
    const homeDir = tempDir('windows-exhausted-home');
    const entry = jsonEntry();
    const target = resolveHostConfigTarget({
      entry,
      host: 'cursor',
      authority: authority('cursor', 'project'),
      repoRoot,
      homeDir,
    });
    fs.mkdirSync(path.dirname(target.config_path), { recursive: true });
    const original = '{\n  "mcpServers": {\n    "keep": { "command": "keep", "args": [] }\n  }\n}\n';
    fs.writeFileSync(target.config_path, original);
    fs.chmodSync(target.config_path, 0o640);
    const originalMode = fs.statSync(target.config_path).mode & 0o777;
    const renameCalls = [];
    const renameSync = (sourcePath, destinationPath, context) => {
      renameCalls.push({ sourcePath, destinationPath, ...context });
      if (['direct-replace', 'install-replacement'].includes(context.stage)) {
        throw codedError('EACCES', `injected ${context.stage} contention`);
      }
      fs.renameSync(sourcePath, destinationPath);
    };

    const result = applyHostConfig({
      entry,
      target,
      replace: {
        platform: 'win32',
        retryAttempts: 3,
        retryDelayMs: 0,
        renameSync,
        sleep() {},
      },
    });

    expect(result).toMatchObject({
      ok: false,
      changed: false,
      reason_code: 'host-config-write-failed',
      error: { code: 'EACCES' },
      lock_release_status: 'released',
    });
    expect(renameCalls.filter((call) => call.stage === 'direct-replace')).toHaveLength(3);
    expect(renameCalls.filter((call) => call.stage === 'install-replacement')).toHaveLength(3);
    expect(renameCalls.filter((call) => call.stage === 'restore-displaced-original')).toHaveLength(1);
    expect(fs.readFileSync(target.config_path, 'utf8')).toBe(original);
    expect((fs.statSync(target.config_path).mode & 0o222) === 0).toBe((originalMode & 0o222) === 0);
    expect(fs.readdirSync(path.dirname(target.config_path)).filter((name) => name.includes('.spec-first.'))).toEqual([]);
  });

  test('keeps POSIX replace failures single-attempt and leaves the original untouched', () => {
    const repoRoot = tempDir('posix-replace-repo');
    const homeDir = tempDir('posix-replace-home');
    const entry = jsonEntry();
    const target = resolveHostConfigTarget({
      entry,
      host: 'cursor',
      authority: authority('cursor', 'project'),
      repoRoot,
      homeDir,
    });
    fs.mkdirSync(path.dirname(target.config_path), { recursive: true });
    const original = '{\n  "mcpServers": {\n    "keep": { "command": "keep", "args": [] }\n  }\n}\n';
    fs.writeFileSync(target.config_path, original);
    const renameSync = jest.fn(() => {
      throw codedError('EPERM', 'injected POSIX rename failure');
    });
    const sleep = jest.fn();

    const result = applyHostConfig({
      entry,
      target,
      replace: {
        platform: 'linux',
        retryAttempts: 5,
        renameSync,
        sleep,
      },
    });

    expect(result).toMatchObject({
      ok: false,
      changed: false,
      reason_code: 'host-config-write-failed',
      lock_release_status: 'released',
    });
    expect(renameSync).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
    expect(fs.readFileSync(target.config_path, 'utf8')).toBe(original);
  });

  test('read-only inspection accepts a current config even when the file is not writable', () => {
    const repoRoot = tempDir('readonly-config-repo');
    const homeDir = tempDir('readonly-config-home');
    const entry = jsonEntry();
    const configPath = path.join(repoRoot, '.cursor', 'mcp.json');
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify({
      mcpServers: {
        context7: { command: 'npx', args: ['-y', '@upstash/context7-mcp@latest'] },
      },
    }));
    fs.chmodSync(configPath, 0o444);

    const target = resolveHostConfigTarget({
      entry,
      host: 'cursor',
      authority: authority('cursor'),
      repoRoot,
      homeDir,
      requireWritable: false,
    });
    expect(target).toMatchObject({ ok: true, scope: 'project' });
    expect(inspectHostConfig({ entry, target })).toMatchObject({
      ok: true,
      configured: true,
      reason_code: 'host-config-current',
    });
  });

  test('rejects invalid JSON and supports exact remove without disturbing siblings', () => {
    const repoRoot = tempDir('remove-repo');
    const homeDir = tempDir('remove-home');
    const entry = jsonEntry();
    const target = resolveHostConfigTarget({
      entry,
      host: 'cursor',
      authority: authority('cursor', 'project'),
      repoRoot,
      homeDir,
    });
    fs.mkdirSync(path.dirname(target.config_path), { recursive: true });
    fs.writeFileSync(target.config_path, '{ invalid');
    expect(applyHostConfig({ entry, target })).toMatchObject({
      ok: false,
      reason_code: 'host-config-json-invalid',
    });

    fs.writeFileSync(target.config_path, JSON.stringify({
      mcpServers: {
        context7: { command: 'npx', args: ['-y', '@upstash/context7-mcp@latest'] },
        keep: { command: 'keep', args: [] },
      },
    }, null, 2));
    expect(applyHostConfig({ entry, target, operation: 'remove' })).toMatchObject({
      ok: true,
      changed: true,
      reason_code: 'host-config-removed',
    });
    expect(JSON.parse(fs.readFileSync(target.config_path, 'utf8')).mcpServers)
      .toEqual({ keep: { command: 'keep', args: [] } });
  });

  test('preserves conflicting JSON and TOML entries during uninstall', () => {
    const repoRoot = tempDir('remove-conflict-repo');
    const homeDir = tempDir('remove-conflict-home');
    const json = jsonEntry();
    const jsonTarget = resolveHostConfigTarget({
      entry: json,
      host: 'cursor',
      authority: authority('cursor', 'project'),
      repoRoot,
      homeDir,
    });
    fs.mkdirSync(path.dirname(jsonTarget.config_path), { recursive: true });
    const jsonOriginal = '{\n  "mcpServers": {\n    "context7": { "command": "user-owned", "args": [] },\n    "keep": { "command": "keep", "args": [] }\n  }\n}\n';
    fs.writeFileSync(jsonTarget.config_path, jsonOriginal);

    expect(applyHostConfig({ entry: json, target: jsonTarget, operation: 'remove' })).toMatchObject({
      ok: false,
      changed: false,
      reason_code: 'host-config-uninstall-conflict',
    });
    expect(fs.readFileSync(jsonTarget.config_path, 'utf8')).toBe(jsonOriginal);

    const toml = codexEntry();
    const tomlTarget = resolveHostConfigTarget({
      entry: toml,
      host: 'codex',
      authority: authority('codex', 'user'),
      repoRoot,
      homeDir,
    });
    fs.mkdirSync(path.dirname(tomlTarget.config_path), { recursive: true });
    const tomlOriginal = [
      '[mcp_servers.context7]',
      'command = "user-owned"',
      'args = []',
      '',
      '[other]',
      'keep = true',
      '',
    ].join('\n');
    fs.writeFileSync(tomlTarget.config_path, tomlOriginal);

    expect(applyHostConfig({ entry: toml, target: tomlTarget, operation: 'remove' })).toMatchObject({
      ok: false,
      changed: false,
      reason_code: 'host-config-uninstall-conflict',
    });
    expect(fs.readFileSync(tomlTarget.config_path, 'utf8')).toBe(tomlOriginal);
  });

  test('treats extra JSON and TOML entry fields as uninstall conflicts', () => {
    const repoRoot = tempDir('remove-extra-field-repo');
    const homeDir = tempDir('remove-extra-field-home');
    const json = jsonEntry();
    const jsonTarget = resolveHostConfigTarget({
      entry: json,
      host: 'cursor',
      authority: authority('cursor', 'project'),
      repoRoot,
      homeDir,
    });
    fs.mkdirSync(path.dirname(jsonTarget.config_path), { recursive: true });
    const jsonOriginal = JSON.stringify({
      mcpServers: {
        context7: {
          command: 'npx',
          args: ['-y', '@upstash/context7-mcp@latest'],
          metadata: { owner: 'user' },
        },
      },
    }, null, 2);
    fs.writeFileSync(jsonTarget.config_path, jsonOriginal);

    expect(inspectHostConfig({ entry: json, target: jsonTarget })).toMatchObject({
      ok: true,
      configured: true,
    });
    expect(applyHostConfig({ entry: json, target: jsonTarget, operation: 'remove' })).toMatchObject({
      ok: false,
      reason_code: 'host-config-uninstall-conflict',
      conflict_fields: ['extra:metadata'],
    });
    expect(fs.readFileSync(jsonTarget.config_path, 'utf8')).toBe(jsonOriginal);

    const toml = codexEntry();
    const tomlTarget = resolveHostConfigTarget({
      entry: toml,
      host: 'codex',
      authority: authority('codex', 'user'),
      repoRoot,
      homeDir,
    });
    fs.mkdirSync(path.dirname(tomlTarget.config_path), { recursive: true });
    const tomlOriginal = [
      '[mcp_servers.context7]',
      'command = "npx"',
      'args = ["-y", "@upstash/context7-mcp@latest"]',
      'startup_timeout_sec = 20',
      'metadata = { owner = "user" }',
      '',
    ].join('\n');
    fs.writeFileSync(tomlTarget.config_path, tomlOriginal);

    expect(inspectHostConfig({ entry: toml, target: tomlTarget })).toMatchObject({
      ok: true,
      configured: true,
    });
    expect(applyHostConfig({ entry: toml, target: tomlTarget, operation: 'remove' })).toMatchObject({
      ok: false,
      reason_code: 'host-config-uninstall-conflict',
      conflict_fields: ['extra:metadata'],
    });
    expect(fs.readFileSync(tomlTarget.config_path, 'utf8')).toBe(tomlOriginal);
  });

  test('TOML transaction preserves unrelated content, recovers stale locks, and verifies after replace', () => {
    const repoRoot = tempDir('toml-repo');
    const homeDir = tempDir('toml-home');
    const entry = codexEntry();
    const target = resolveHostConfigTarget({
      entry,
      host: 'codex',
      scope: 'user',
      authority: authority('codex', 'user'),
      repoRoot,
      homeDir,
    });
    fs.mkdirSync(path.dirname(target.config_path), { recursive: true });
    fs.writeFileSync(target.config_path, '\uFEFFtheme = "dark"\r\n[other]\r\nvalue = { nested = [1, 2] }\r\n');

    const lockPath = `${target.config_path}.spec-first.lock`;
    fs.mkdirSync(lockPath, { mode: 0o700 });
    fs.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify({
      pid: 99999999,
      created_at: new Date(Date.now() - 120000).toISOString(),
      target: target.config_path,
    }), { mode: 0o600 });

    const result = applyHostConfig({
      entry,
      target,
      lock: { timeoutMs: 100, staleMs: 1000 },
    });
    expect(result).toMatchObject({
      ok: true,
      changed: true,
      stale_lock_recovered: true,
      post_write_verified: true,
    });
    const written = fs.readFileSync(target.config_path, 'utf8');
    expect(written.startsWith('\uFEFF')).toBe(true);
    expect(written).toContain('theme = "dark"\r\n[other]');
    expect(compareMcpSection(written, 'context7', {
      command: 'npx',
      args: ['-y', '@upstash/context7-mcp@latest'],
      startup_timeout_sec: 20,
    })).toMatchObject({ ok: true, matches: true });
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  test('lock metadata is owner-only and a live lock fails within the bounded wait', () => {
    const dir = tempDir('lock');
    const configPath = path.join(dir, 'config.json');
    const held = acquireConfigLock({ configPath, timeoutMs: 50, staleMs: 60000 });
    expect(held.ok).toBe(true);
    const metadataPath = path.join(held.lock_path, 'owner.json');
    const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
    expect(metadata.pid).toBe(process.pid);
    expect(metadata.target).toBe(configPath);
    if (process.platform !== 'win32') {
      expect(fs.statSync(metadataPath).mode & 0o777).toBe(0o600);
    }
    expect(acquireConfigLock({ configPath, timeoutMs: 30, staleMs: 60000 })).toMatchObject({
      ok: false,
      reason_code: 'host-config-lock-timeout',
    });
    held.release();
  });

  test('stale-lock quarantine cannot delete a replacement live lock from a second contender', () => {
    const dir = tempDir('stale-lock-contenders');
    const configPath = path.join(dir, 'config.json');
    const lockPath = `${configPath}.spec-first.lock`;
    fs.mkdirSync(lockPath, { mode: 0o700 });
    fs.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify({
      pid: 99999999,
      created_at: new Date(Date.now() - 120000).toISOString(),
      target: configPath,
    }), { mode: 0o600 });
    let liveContender = null;
    let injected = false;

    const staleContender = acquireConfigLock({
      configPath,
      timeoutMs: 0,
      staleMs: 1000,
      faultInjector(stage) {
        if (stage !== 'after-stale-lock-inspection' || injected) return;
        injected = true;
        liveContender = acquireConfigLock({ configPath, timeoutMs: 50, staleMs: 1000 });
      },
    });

    expect(liveContender).toMatchObject({ ok: true, stale_lock_recovered: true });
    expect(staleContender).toMatchObject({
      ok: false,
      reason_code: 'host-config-lock-timeout',
    });
    expect(JSON.parse(fs.readFileSync(path.join(lockPath, 'owner.json'), 'utf8')).token)
      .toBe(liveContender.owner.token);
    expect(fs.readdirSync(dir).filter((name) => name.includes('.quarantine.'))).toEqual([]);
    expect(liveContender.release()).toMatchObject({ status: 'released' });
  });

  test('revalidates lock ownership before replace, commit, and restore', () => {
    const runWithOwnershipLoss = (stage) => {
      const repoRoot = tempDir(`lock-owner-${stage}-repo`);
      const homeDir = tempDir(`lock-owner-${stage}-home`);
      const entry = jsonEntry();
      const target = resolveHostConfigTarget({
        entry,
        host: 'cursor',
        authority: authority('cursor', 'project'),
        repoRoot,
        homeDir,
      });
      fs.mkdirSync(path.dirname(target.config_path), { recursive: true });
      const original = '{\n  "mcpServers": {\n    "keep": { "command": "keep", "args": [] }\n  }\n}\n';
      fs.writeFileSync(target.config_path, original);
      const lockPath = `${target.config_path}.spec-first.lock`;
      const result = applyHostConfig({
        entry,
        target,
        faultInjector(currentStage) {
          if (currentStage !== stage) return;
          const ownerPath = path.join(lockPath, 'owner.json');
          const owner = JSON.parse(fs.readFileSync(ownerPath, 'utf8'));
          fs.writeFileSync(ownerPath, JSON.stringify({ ...owner, token: `replacement-${stage}` }));
        },
      });
      return { original, lockPath, result, target };
    };

    const beforeReplace = runWithOwnershipLoss('before-replace');
    expect(beforeReplace.result).toMatchObject({
      ok: false,
      changed: false,
      reason_code: 'host-config-lock-ownership-lost',
      lock_release_status: 'skipped',
      lock_release_reason_code: 'host-config-lock-owner-changed',
    });
    expect(fs.readFileSync(beforeReplace.target.config_path, 'utf8')).toBe(beforeReplace.original);
    fs.rmSync(beforeReplace.lockPath, { recursive: true, force: true });

    const beforeCommit = runWithOwnershipLoss('before-commit');
    expect(beforeCommit.result).toMatchObject({
      ok: false,
      changed: true,
      reason_code: 'host-config-restore-failed',
      backup_path: expect.any(String),
      restore: { status: 'failed' },
      lock_release_status: 'skipped',
      lock_release_reason_code: 'host-config-lock-owner-changed',
    });
    expect(fs.readFileSync(beforeCommit.result.backup_path, 'utf8')).toBe(beforeCommit.original);
    fs.rmSync(beforeCommit.result.backup_path, { force: true });
    fs.rmSync(beforeCommit.lockPath, { recursive: true, force: true });
  });

  test('reports lock release cleanup failure without overriding a verified transaction', () => {
    const repoRoot = tempDir('lock-release-repo');
    const homeDir = tempDir('lock-release-home');
    const entry = jsonEntry();
    const target = resolveHostConfigTarget({
      entry,
      host: 'cursor',
      authority: authority('cursor', 'project'),
      repoRoot,
      homeDir,
    });
    const lockPath = `${target.config_path}.spec-first.lock`;

    const result = applyHostConfig({
      entry,
      target,
      lock: {
        releaseRemove() {
          throw codedError('EACCES', 'injected lock cleanup denial');
        },
      },
    });

    expect(result).toMatchObject({
      ok: true,
      changed: true,
      reason_code: 'host-config-updated',
      post_write_verified: true,
      lock_release_status: 'failed',
      lock_release_reason_code: 'host-config-lock-release-failed',
      lock_path: lockPath,
      lock_release_error: { code: 'EACCES' },
    });
    expect(result.lock_release_next_action).toContain(lockPath);
    expect(inspectHostConfig({ entry, target })).toMatchObject({ ok: true, configured: true });
    expect(fs.existsSync(lockPath)).toBe(true);
    fs.rmSync(lockPath, { recursive: true, force: true });
  });

  test('post-replace failure restores original bytes; restore failure is explicit', () => {
    const repoRoot = tempDir('rollback-repo');
    const homeDir = tempDir('rollback-home');
    const entry = jsonEntry();
    const target = resolveHostConfigTarget({
      entry,
      host: 'cursor',
      authority: authority('cursor', 'project'),
      repoRoot,
      homeDir,
    });
    fs.mkdirSync(path.dirname(target.config_path), { recursive: true });
    const original = '{\n  "mcpServers": {\n    "keep": { "command": "keep", "args": [] }\n  }\n}\n';
    fs.writeFileSync(target.config_path, original);

    const failed = applyHostConfig({
      entry,
      target,
      faultInjector(stage) {
        if (stage === 'after-replace') throw new Error('injected post replace failure');
      },
    });
    expect(failed).toMatchObject({
      ok: false,
      reason_code: 'host-config-write-failed',
      restore: { status: 'restored' },
    });
    expect(fs.readFileSync(target.config_path, 'utf8')).toBe(original);

    const restoreFailed = applyHostConfig({
      entry,
      target,
      faultInjector(stage) {
        if (stage === 'after-replace') throw new Error('write failed');
        if (stage === 'before-restore') throw new Error('restore failed');
      },
    });
    expect(restoreFailed).toMatchObject({
      ok: false,
      reason_code: 'host-config-restore-failed',
      restore: {
        status: 'failed',
        backup_path: expect.any(String),
        recovery: { status: 'manual-required' },
      },
      backup_path: expect.any(String),
      recovery: { status: 'manual-required' },
      lock_release_status: 'released',
    });
    expect(restoreFailed.recovery.next_action).toContain(restoreFailed.backup_path);
    expect(fs.readFileSync(restoreFailed.backup_path, 'utf8')).toBe(original);
    if (process.platform !== 'win32') {
      expect(fs.statSync(restoreFailed.backup_path).mode & 0o777).toBe(0o600);
    }
    fs.rmSync(restoreFailed.backup_path, { force: true });
  });

  test('rechecks containment before replace when the target leaf changes to a symlink', () => {
    const repoRoot = tempDir('commit-recheck-repo');
    const homeDir = tempDir('commit-recheck-home');
    const outside = tempDir('commit-recheck-outside');
    const entry = jsonEntry();
    const target = resolveHostConfigTarget({
      entry,
      host: 'cursor',
      authority: authority('cursor', 'project'),
      repoRoot,
      homeDir,
    });

    const result = applyHostConfig({
      entry,
      target,
      faultInjector(stage) {
        if (stage === 'after-write-temp') {
          fs.symlinkSync(outside, target.config_path, process.platform === 'win32' ? 'junction' : 'dir');
        }
      },
    });

    expect(result).toMatchObject({
      ok: false,
      reason_code: 'host-config-symlink-rejected',
      changed: false,
    });
    expect(fs.readdirSync(outside)).toEqual([]);
  });
});
