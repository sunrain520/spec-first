'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const CANONICAL_HOSTS = Object.freeze(['claude', 'codex', 'cursor', 'kiro', 'opencode', 'qoder', 'zcode']);
const CANONICAL_HOST_SET = new Set(CANONICAL_HOSTS);
// 每个宿主登记 spec-runtime-setup 的全部 generated 投射根（相对 repo 根的正斜杠路径）。
// Claude 以 workflow_command 投射到 managed workflows 根；其余宿主 workflow 根即
// skills 根。保持与 src/cli adapters 的 skillsRoot/workflowsRoot 同步——
// tests/unit/mcp-setup-config-consumers.test.js 的 drift-guard 用例强制这一一致性。
const HOST_SKILL_SURFACES = Object.freeze({
  claude: Object.freeze(['.claude/spec-first/workflows']),
  codex: Object.freeze(['.agents/skills']),
  cursor: Object.freeze(['.cursor/skills']),
  kiro: Object.freeze(['.kiro/skills']),
  qoder: Object.freeze(['.qoder/skills']),
  opencode: Object.freeze(['.opencode/skills']),
  // ZCode discovers skills from the same shared AGENTS.md-ecosystem root Codex
  // projects to; resolveLoadedHostSurface returns every host bound to the
  // matched surface so a zcode pin confirms against the shared root.
  zcode: Object.freeze(['.agents/skills']),
});

function resolveHostAuthority({
  env = process.env,
  mutationRequested = false,
  candidates = [],
  skillRoot = null,
  targetIdentity = null,
  enforceSurfaceBinding = false,
  now = new Date(),
} = {}) {
  const advisoryCandidates = uniqueCanonicalHosts(candidates);
  const pin = typeof env.MCP_SETUP_HOST === 'string' ? env.MCP_SETUP_HOST : '';

  if (pin && !CANONICAL_HOST_SET.has(pin)) {
    return {
      status: mutationRequested ? 'blocked' : 'advisory',
      host: null,
      candidates: advisoryCandidates,
      authority_source: null,
      mutation_authorized: false,
      reason_code: 'host-authority-invalid',
    };
  }

  if (pin) {
    if (enforceSurfaceBinding) {
      const loadedSurface = resolveLoadedHostSurface(skillRoot);
      // Shared surfaces (e.g. `.agents/skills/` bound to both codex and zcode)
      // confirm the pin when the pinned host is among the surface's owners;
      // the receipt keeps the first-match host for stable evidence display.
      const pinBoundToSurface = Boolean(loadedSurface && Array.isArray(loadedSurface.hosts)
        && loadedSurface.hosts.includes(pin));
      const verificationStatus = !loadedSurface
        ? 'unverified'
        : (pinBoundToSurface ? 'confirmed' : 'rejected');
      const reasonCode = !loadedSurface
        ? 'host-invocation-surface-unverified'
        : (pinBoundToSurface
          ? 'host-authority-loaded-root-bound'
          : 'host-invocation-surface-mismatch');
      const receipt = buildInvocationReceipt({
        host: pin,
        loadedSurface,
        skillRoot,
        targetIdentity,
        verificationStatus,
        reasonCode,
        now,
      });
      if (verificationStatus !== 'confirmed') {
        return {
          status: mutationRequested ? 'blocked' : 'advisory',
          host: null,
          candidates: advisoryCandidates,
          authority_source: 'MCP_SETUP_HOST+loaded-skill-root',
          mutation_authorized: false,
          reason_code: reasonCode,
          invocation_receipt: receipt,
        };
      }
      return {
        status: 'ready',
        host: pin,
        candidates: advisoryCandidates,
        authority_source: 'MCP_SETUP_HOST+loaded-skill-root',
        mutation_authorized: true,
        reason_code: reasonCode,
        invocation_receipt: receipt,
      };
    }
    return {
      status: 'ready',
      host: pin,
      candidates: advisoryCandidates,
      authority_source: 'MCP_SETUP_HOST',
      mutation_authorized: true,
      reason_code: 'host-authority-ready',
    };
  }

  if (mutationRequested) {
    return {
      status: 'blocked',
      host: null,
      candidates: advisoryCandidates,
      authority_source: null,
      mutation_authorized: false,
      reason_code: 'host-authority-required',
    };
  }

  return {
    status: 'advisory',
    host: null,
    candidates: advisoryCandidates,
    authority_source: null,
    mutation_authorized: false,
    reason_code: advisoryCandidates.length > 0
      ? 'host-candidate-advisory'
      : 'host-undetermined-advisory',
  };
}

function resolveLoadedHostSurface(skillRoot) {
  if (typeof skillRoot !== 'string' || !skillRoot) return null;
  let canonicalRoot;
  try {
    canonicalRoot = fs.realpathSync.native
      ? fs.realpathSync.native(path.resolve(skillRoot))
      : fs.realpathSync(path.resolve(skillRoot));
  } catch (_error) {
    return null;
  }
  const normalized = canonicalRoot.split(path.sep).join('/').replace(/\/$/, '');
  let matchedSurfaceId = null;
  for (const surfaceIds of Object.values(HOST_SKILL_SURFACES)) {
    for (const surfaceId of surfaceIds) {
      if (normalized.endsWith(`/${surfaceId}/spec-runtime-setup`)) {
        matchedSurfaceId = surfaceId;
        break;
      }
    }
    if (matchedSurfaceId !== null) break;
  }
  if (matchedSurfaceId === null) {
    return null;
  }
  // 共享面（如 `.agents/skills/` 同时绑定 codex 与 zcode）返回绑定到该面的全部
  // 宿主；不同 surface 后缀互斥，同一路径至多命中一个 surfaceId。
  const hosts = Object.entries(HOST_SKILL_SURFACES)
    .filter(([, surfaceIds]) => surfaceIds.includes(matchedSurfaceId))
    .map(([host]) => host);
  if (hosts.length === 0) {
    return null;
  }
  return { host: hosts[0], hosts, surface_id: matchedSurfaceId, skill_root: canonicalRoot };
}

function buildInvocationReceipt({
  host,
  loadedSurface,
  skillRoot,
  targetIdentity,
  verificationStatus,
  reasonCode,
  now,
}) {
  const issuedAt = now instanceof Date ? now : new Date(now);
  const receipt = {
    schema_version: 'host-invocation-receipt/v1',
    producer: 'skills/spec-runtime-setup/scripts/setup.cjs',
    verification_status: verificationStatus,
    reason_code: reasonCode,
    host,
    loaded_host: loadedSurface ? loadedSurface.host : null,
    surface_id: loadedSurface ? loadedSurface.surface_id : null,
    skill_root: loadedSurface ? loadedSurface.skill_root : path.resolve(String(skillRoot || '.')),
    canonical_entry_name: 'spec-runtime-setup',
    target_identity: targetIdentity ? String(targetIdentity) : 'unresolved',
    issued_at: issuedAt.toISOString(),
    freshness_expires_at: new Date(issuedAt.getTime() + (5 * 60 * 1000)).toISOString(),
    enforcement_status: loadedSurface ? 'loaded-root-checked' : 'loaded-root-unverified',
  };
  return {
    ...receipt,
    receipt_sha256: crypto.createHash('sha256').update(JSON.stringify(receipt)).digest('hex'),
  };
}

function uniqueCanonicalHosts(candidates) {
  const result = [];
  const seen = new Set();
  for (const candidate of Array.isArray(candidates) ? candidates : []) {
    const value = String(candidate);
    if (!CANONICAL_HOST_SET.has(value) || seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
}

module.exports = {
  CANONICAL_HOSTS,
  HOST_SKILL_SURFACES,
  buildInvocationReceipt,
  resolveHostAuthority,
  resolveLoadedHostSurface,
};
