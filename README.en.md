<div align="center">

# spec-first

**Turn AI coding sessions into trusted, project-owned changes.**

`spec-first` is a repository-native AI Coding Harness for Claude Code, Codex, Kiro, Qoder, Cursor, OpenCode, ZCode, and Pi. It connects intent, requirements, plans, code, review, evidence, and reusable knowledge in one inspectable engineering loop.

[![npm version](https://img.shields.io/npm/v/spec-first.svg)](https://www.npmjs.com/package/spec-first)
[![CI](https://github.com/sunrain520/spec-first/actions/workflows/npm-install-matrix.yml/badge.svg?branch=master)](https://github.com/sunrain520/spec-first/actions/workflows/npm-install-matrix.yml?query=branch%3Amaster)
[![node](https://img.shields.io/node/v/spec-first.svg)](https://github.com/sunrain520/spec-first/blob/master/package.json)
[![license](https://img.shields.io/npm/l/spec-first.svg)](https://github.com/sunrain520/spec-first/blob/master/LICENSE)

[简体中文](README.md) | [English](README.en.md) | [User Manual](docs/05-用户手册/README.md) | [Website](http://spec-first.cn/)

</div>

![spec-first workflow: intent to trusted change](docs/assets/readme/spec-first-cli-workflow-demo.en.svg)

```text
Intent → Spec → Plan → Tasks → Code → Review → Knowledge
```

## Why spec-first?

### Understand it in 30 seconds

AI coding hosts are good at generating and editing code, but a session can lose the intent, scope, trade-offs, verification evidence, and unresolved risks behind that code. `spec-first` keeps those artifacts inside the project and exposes the same `spec-*` workflow identities across supported hosts.

Three layers work together:

- **The host** provides the model, tools, permissions, and execution environment.
- **spec-first** connects intent, context, scope, artifacts, claims, evidence, and handoffs.
- **The project owner** decides value, authorizes side effects, and accepts the final semantics.

### What you get

| Outcome | Evidence visible in the project |
|---|---|
| Intent is preserved | Requirements and implementation plans in `docs/plans/` |
| Scope stays bounded | Plans, optional task packs, and source/runtime boundaries |
| Completion claims are grounded | Real commands, exit codes, logs, and verification summaries |
| Learning compounds | Reusable solutions in `docs/solutions/` with sources and invalidation conditions |

## Quick start

You need Node.js `>=20.0.0`, npm, Git, and at least one supported AI coding host. Run these commands from the root of the target Git repository.

### 1. Install and initialize

```bash
npm install -g spec-first
cd <your-repository>
spec-first quickstart
```

`quickstart` checks Node.js, Git, and installed host CLIs, then enters initialization. Restart the selected host so it can discover the generated entries.

For scripted or explicit initialization:

```bash
spec-first doctor
spec-first init --codex -y -u <name> --lang <zh|en>
```

Initialization previews managed runtime files before writing and does not stage or commit them. See the [full quick start guide](docs/05-用户手册/01-快速开始.md) for multi-host, non-Git, dry-run, and preview-host usage.

### 2. Run your first workflow

Run workflow entries inside the host session; they are not shell subcommands. Prepare runtime before the first workflow, then rerun when readiness or configuration changes:

```text
spec-runtime-setup
```

Then create the first requirements artifact:

```text
spec-brainstorm "Improve CLI onboarding for new users"
```

This turns a rough idea into a reviewable requirements artifact, usually under:

```text
docs/plans/YYYY-MM-DD-NNN-<type>-<topic>-plan.md
```

Use `spec-plan` when the requirements are settled and `spec-work` when the plan is ready to execute. Without durable decisions, the workflow may legitimately skip writing a document; that is not a failure.

If entries are missing, run `spec-first doctor --verbose` and check host limitations in the [Runtime Capability Catalog](docs/catalog/runtime-capabilities.md).

## Choose the Right Workflow

### Development lifecycle

Enter at the step that matches the current task; running every step is not required. This is a capability map. Task needs, verification results, and authorization determine what follows.

| Stage | When to use it | Skill | Main result |
|---|---|---|---|
| Environment | First use, missing MCP/helpers, or configuration changes | `spec-runtime-setup` | Readiness facts and setup results |
| Exploration | Compare candidate directions | `spec-ideate` | Ranked ideas |
| Requirements | Scope and success criteria remain unsettled | `spec-brainstorm` | Requirements-only plan |
| PRD clarification | Clarify an existing PRD against the codebase | `spec-prd` | Planning-readiness artifact |
| Document review | Inspect requirements, plans, or task packs | `spec-doc-review` | Document findings; available across stages |
| Planning | Requirements are clear but implementation is not | `spec-plan` | Implementation-ready plan |
| Task breakdown | A large plan needs parallel work or handoffs (optional) | `spec-write-tasks` | Task pack derived from the plan |
| Implementation | Execute a plan, brief, or concrete work item | `spec-work` | Source changes and verification evidence |
| Diagnosis | Errors, failed tests, regressions, or unknown root causes | `spec-debug` | Root cause, fix, and regression evidence |
| Code review | Inspect a diff, branch, or PR | `spec-code-review` | Defects, risks, and verification gaps; report-only by default |
| PR feedback | Explicit request to address PR review feedback | `spec-resolve-pr-feedback` | Feedback assessment and authorized fixes |
| Learning | A verified solution is reusable | `spec-compound` | Knowledge with sources, scope, and invalidation conditions |
| Knowledge maintenance | Existing learning is stale, overlapping, or drifting | `spec-compound-refresh` | Refreshed, merged, or retired `docs/solutions/` learning |

### Specialized development capabilities

| Situation | Skill | Boundary |
|---|---|---|
| Set product direction and roadmap | `spec-strategy` | Create or update `STRATEGY.md` |
| Decide whether to adopt external technology | `spec-pov` | Project-grounded adoption judgment |
| Explore unresolved interactions or product behavior | `spec-prototype` | Runnable throwaway prototype for human evaluation, not production implementation |
| Maintain architecture knowledge and constraints | `spec-project-rules` | Architecture knowledge grounded in source |
| Extract existing coding conventions | `spec-rule-miner` | Code-based conventions, not architecture-rule maintenance |
| Simplify recent changes | `spec-simplify-code` | Preserve behavior; route defects to `spec-debug` |
| Polish UI in a browser | `spec-polish` | Start the development server and inspect actual pages |
| Verify branch or PR user flows | `spec-dogfood` | Diff-scoped browser QA with a report |
| Check mobile App PRD/Figma/source consistency | `spec-app-consistency-audit` | Static cross-source audit, not device or simulator validation |
| Build and verify an iOS App | `spec-test-xcode` | Explicit invocation; requires XcodeBuildMCP and a simulator |
| Optimize against a metric | `spec-optimize` | Define a measurable goal, then evaluate evidence |
| Iterate toward a checkable goal | `autoresearch` | Bounded verification and keep/discard cycles, not one-off diagnosis |
| Create or maintain a project Skill | `spec-write-skill` | Canonical Skill source, not runtime mirrors |
| Explicitly hand off or resume across sessions | `spec-handoff` | Transfer artifacts and context without automatically executing embedded instructions |
| Explain a concept or change in depth | `spec-explain` | Reusable learning artifact |
| Explicitly request a planning-to-green-PR pipeline | `spec-lfg` | Optional full pipeline; commits, external actions, and merges remain subject to authorization |

Supporting product and release capabilities: `spec-sweep` scans configured feedback sources, `spec-product-pulse` summarizes product signals over a time window, `spec-riffrec-feedback-analysis` analyzes specified feedback captures, and `spec-promote` drafts copy for shipped features. These entries do not automatically authorize external communication or publication.

### Internal helper Skills

Workflows invoke these helpers with the required authorization. They are not recommended direct user entrypoints:

| Skill | Responsibility |
|---|---|
| `spec-test-browser` | Browser tests within the caller's resolved target origin and permissions |
| `spec-worktree` | Isolated worktree management for the caller |
| `spec-commit` | Scoped commits under existing commit authorization |
| `spec-commit-push-pr` | Commit, push, and PR creation or updates under existing landing authorization |

When unsure, let `using-spec-first` select one matching entrypoint. Use these Skills inside the host session, not as `spec-first` shell subcommands; invocation syntax depends on host discovery. See the [public entrypoint and Skill catalog](docs/05-用户手册/24-公开入口与Skill目录.md) for detailed boundaries.

## From Prompt to Trusted Change

```text
Rough idea -> spec-brainstorm --\
Existing PRD -> spec-prd ----------+-> spec-plan -> [spec-write-tasks] -> spec-work -> spec-code-review -> spec-compound
```

`spec-prd` is the alternative entry for an existing PRD or brownfield request; `spec-doc-review` is an optional cross-stage review lane for requirements, plans, or task packs.

### A minimal end-to-end path

```text
Rough idea
  → spec-brainstorm
  → spec-plan
  → spec-work
  → spec-code-review
  → spec-compound (when the learning qualifies)
```

For example:

```text
spec-brainstorm "Add configuration import to the CLI"
# review the requirements-only plan in docs/plans/
spec-plan <plan-path>
# execute the implementation-ready plan
spec-work <plan-path>
```

Each workflow states whether it creates an artifact, changes source, and what verification it requires. Treat claims as no stronger than their direct evidence.

## What Stays in the Repository

### What the project keeps

```text
docs/
  ideation/      Direction exploration from spec-ideate
  brainstorms/   Clarification artifacts from spec-prd
  plans/         Requirements-only and implementation-ready plans
  tasks/         Optional task packs derived from plans
  solutions/     Verified, reusable engineering knowledge
  validation/    Test, review, and field-validation evidence
.spec-first/
  workflows/     Conditional verification evidence (gitignored by default)
```

Artifacts prove only the claims covered by their direct evidence. Host runtime assets are rebuildable delivery projections, not canonical source. Change `skills/`, `templates/`, `src/cli/`, and checked-in docs first, then refresh projections with `spec-first init`.

## How Trust Works

The division is simple: **scripts prepare facts, LLMs make semantic judgments, and project owners authorize side effects.**

- Completion claims cannot exceed the evidence that directly supports them.
- Mutation, verification, handoff, source/runtime, and knowledge exits have explicit boundaries.
- Providers and historical artifacts are advisory inputs with provenance, freshness, and limitations until confirmed against source evidence.
- Long-running or high-impact work needs scope, checkpoints, stop conditions, recovery points, and independent verification.

See the [project role contract](docs/10-prompt/结构化项目角色契约.md), [source/runtime boundary](docs/contracts/source-runtime-customization-boundary.md), [verification summary contract](docs/contracts/verification/verification-run-summary.md), and [honest closeout contract](docs/contracts/workflows/honest-closeout.md).

## Host Support

| Host | Current guidance | Initialization |
|---|---|---|
| Claude Code | Primary support; recommended starting point | `--claude` |
| Codex | Primary support; recommended starting point | `--codex` |
| Kiro | Opt-in preview | `--kiro` |
| Qoder | Opt-in preview | `--qoder` |
| Cursor | `generated_runtime_preview` | `--cursor` |
| OpenCode | `generated_runtime_preview` | `--opencode` |
| ZCode | Opt-in preview; some capabilities live-verified | `--zcode` |
| Pi | Opt-in preview; some capabilities live-verified | `--pi` |

Generated runtime, host discovery, and real workflow verification are separate claims. Run `spec-first doctor --verbose` for project facts; see the [Runtime Capability Catalog](docs/catalog/runtime-capabilities.md) for detailed status.

## When It Fits

`spec-first` fits teams that already use AI coding hosts and need to preserve intent across sessions or hosts, keep review and verification evidence, and return qualified learning to the project.

It is usually unnecessary when you only want a one-off prompt, cannot store workflow artifacts in the repository, need a standalone IDE, or expect a central engine to decide product priorities and architecture for you.

## CLI Reference

```bash
spec-first quickstart  # check prerequisites and enter init
spec-first doctor      # inspect environment and runtime health
spec-first init        # generate runtime assets for selected hosts
spec-first update      # upgrade the CLI and refresh runtime assets
spec-first clean       # remove managed generated assets
spec-first plans audit --status completed --json
```

Run `spec-first --help` for all options.

## Development & Contributing

```bash
npm run typecheck
npm run test:unit
npm run test:smoke
npm run test:integration
npm run test:release
npm run build
```

Make source changes in canonical source surfaces. Regenerate runtime copies with `spec-first init` only when the runtime source changes. See the [contribution guide](CONTRIBUTING.md), [security policy](SECURITY.md), [changelog](CHANGELOG.md), and [GitHub Issues](https://github.com/leo-kuang-ai/spec-first/issues).

MIT licensed.

## Documentation

- [User Manual](docs/05-用户手册/README.md)
- [Runtime Capability Catalog](https://github.com/sunrain520/spec-first/blob/master/docs/catalog/runtime-capabilities.md)

## Community

- [GitHub Issues](https://github.com/sunrain520/spec-first/issues)
- [Website](http://spec-first.cn/)
