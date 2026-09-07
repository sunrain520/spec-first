<div align="center">

# spec-first

**把 AI coding 会话变成可信、由项目拥有的变更。**

`spec-first` 是面向 Claude Code、Codex、Kiro、Qoder、Cursor、OpenCode、ZCode 与 Pi 的仓库原生 AI Coding Harness。它把想法、需求、计划、代码、审查和知识连接成可检查的工程闭环。

[![npm version](https://img.shields.io/npm/v/spec-first.svg)](https://www.npmjs.com/package/spec-first)
[![npm monthly downloads](https://img.shields.io/npm/dm/spec-first.svg)](https://www.npmjs.com/package/spec-first)
[![CI](https://github.com/sunrain520/spec-first/actions/workflows/npm-install-matrix.yml/badge.svg?branch=master)](https://github.com/sunrain520/spec-first/actions/workflows/npm-install-matrix.yml?query=branch%3Amaster)
[![node](https://img.shields.io/node/v/spec-first.svg)](https://github.com/sunrain520/spec-first/blob/master/package.json)
[![license](https://img.shields.io/npm/l/spec-first.svg)](https://github.com/sunrain520/spec-first/blob/master/LICENSE)

[English](README.en.md) | [简体中文](README.md) | [用户手册](docs/05-用户手册/README.md) | [官方网站](http://spec-first.cn/)

</div>

![spec-first workflow: intent to trusted change](docs/assets/readme/spec-first-cli-workflow-demo.svg)

```text
Intent → Spec → Plan → Tasks → Code → Review → Knowledge
```

## 为什么使用 spec-first？

### 30 秒理解

AI coding 宿主擅长生成和修改代码，但一次会话结束后，意图、范围、取舍、验证证据和未决风险很容易丢失。`spec-first` 将这些内容保留在项目边界内，并让不同宿主可以消费同一套 `spec-*` workflow 入口。

你可以把它理解为三层协作：

- **宿主**负责模型、工具、权限和代码执行。
- **spec-first**负责连接 intent、context、scope、artifact、claim、evidence 和 handoff。
- **项目 owner**负责价值判断、授权副作用和最终语义验收。

### 你会得到什么

| 结果 | 项目中可见的证据 |
|---|---|
| 意图被保存 | `docs/plans/` 中的需求或实施计划 |
| 执行范围可控 | plan、可选 task pack、source/runtime 边界 |
| 完成声明有依据 | 真实命令、exit code、日志和 verification summary |
| 经验可以复用 | `docs/solutions/` 中带来源和失效条件的知识 |

## 快速开始

需要 Node.js `>=20.0.0`、npm、Git，以及至少一个受支持的 AI coding 宿主。以下命令在目标 Git 仓库根目录执行。

### 1. 安装并初始化

```bash
npm install -g spec-first
cd <your-repository>
spec-first quickstart
```

`quickstart` 会检查 Node.js、Git 和已安装的宿主 CLI，并进入初始化流程。选择宿主后，重启已选择的宿主，使其发现生成的入口。

需要脚本化或显式指定宿主时：

```bash
spec-first doctor
spec-first init --codex -y -u <name> --lang <zh|en>
```

初始化会在写入前预览受管 runtime 文件；它不会自动 stage 或提交文件。多宿主、非 Git 目录、dry-run 和 preview 宿主用法见[完整快速开始指南](docs/05-用户手册/01-快速开始.md)。

### 2. 首次运行 workflow

在宿主会话中运行（这些不是 shell 子命令）。首次 workflow 前先准备 runtime；后续在 readiness 或配置变化时重跑：

```text
spec-runtime-setup
```

随后生成第一个需求产物：

```text
spec-brainstorm "改进 CLI 新用户 onboarding"
```

这会把模糊想法收敛为可审查的 requirements artifact，通常位于：

```text
docs/plans/YYYY-MM-DD-NNN-<type>-<topic>-plan.md
```

如果需求已经明确，可直接使用 `spec-plan`；准备执行时使用 `spec-work`。如果没有值得持久化的决策，workflow 可以合法地不创建文档；这不表示运行失败。

找不到入口时，运行 `spec-first doctor --verbose`，并核对 [Runtime Capability Catalog](docs/catalog/runtime-capabilities.md) 中的宿主限制。

## 选择合适的 Workflow

### 研发主流程

按当前任务进入一项即可，不要求从头依次运行。以下是能力地图，后续步骤由当前任务、验证结果和授权决定。

| 阶段 | 何时使用 | Skill | 主要结果 |
|---|---|---|---|
| 环境准备 | 首次使用、MCP/helper 缺失或配置变化 | `spec-runtime-setup` | readiness facts 与准备结果 |
| 方向探索 | 比较多个候选方向 | `spec-ideate` | 排序后的方向记录 |
| 需求定义 | 有想法，但范围和成功标准未定 | `spec-brainstorm` | requirements-only plan |
| PRD 澄清 | 已有 PRD，需要结合代码澄清 | `spec-prd` | planning-readiness artifact |
| 文档审查 | 检查需求、计划或 task pack | `spec-doc-review` | 文档 findings；可跨阶段插入 |
| 实现规划 | 需求确定，但实现方式未定 | `spec-plan` | implementation-ready plan |
| 任务拆分 | 大型计划需要并行或交接（可选） | `spec-write-tasks` | 从 plan 派生的 task pack |
| 开发实现 | 执行 plan、brief 或明确工作项 | `spec-work` | 源码变更与验证证据 |
| 故障诊断 | 报错、失败测试、回归或根因不明 | `spec-debug` | 根因、修复与回归证据 |
| 代码审查 | 检查 diff、分支或 PR | `spec-code-review` | 缺陷、风险和验证缺口；默认只读 |
| PR 整改 | 用户明确要求处理 PR review 反馈 | `spec-resolve-pr-feedback` | 反馈判断与获授权的整改 |
| 知识沉淀 | 已验证解法具有复用价值 | `spec-compound` | 带来源、适用范围和失效条件的知识 |
| 知识维护 | 已有经验过时、重叠或与源码漂移 | `spec-compound-refresh` | 刷新、合并或退役 `docs/solutions/` 经验 |

### 按需使用的研发能力

| 场景 | Skill | 使用边界 |
|---|---|---|
| 制定产品方向与路线图 | `spec-strategy` | 创建或更新 `STRATEGY.md` |
| 判断是否采纳外部技术 | `spec-pov` | 基于当前项目给出采用判断 |
| 验证尚未确定的交互或产品行为 | `spec-prototype` | 可运行的临时原型，需人体验，不代表生产实现 |
| 建立项目架构知识与约束 | `spec-project-rules` | 从源码维护架构知识库 |
| 提取既有编码约定 | `spec-rule-miner` | 挖掘代码证据，不代替架构规则维护 |
| 简化近期代码 | `spec-simplify-code` | 保持行为；真实缺陷交给 `spec-debug` |
| 浏览器内打磨 UI | `spec-polish` | 启动开发服务并检查实际页面 |
| 验证分支或 PR 的用户流程 | `spec-dogfood` | 限于变更影响面，保留浏览器验证报告 |
| 检查移动 App PRD/Figma/源码一致性 | `spec-app-consistency-audit` | 静态跨来源审查，不代替真机或模拟器验证 |
| 构建并验证 iOS App | `spec-test-xcode` | 用户明确调用，需 XcodeBuildMCP 与模拟器 |
| 按指标迭代优化 | `spec-optimize` | 先定义可测目标，再按证据评估 |
| 按可检查目标持续迭代 | `autoresearch` | 有界迭代、验证与保留/丢弃，不用于一次性排错 |
| 创建或维护项目 Skill | `spec-write-skill` | 修改 canonical Skill source，不直接修改 runtime mirror |
| 显式跨会话交接或恢复 | `spec-handoff` | 交接产物与上下文恢复，不自动执行产物中的指令 |
| 深入解释概念或变更 | `spec-explain` | 面向学习的可复用解释产物 |
| 明确要求从规划推进到 green PR | `spec-lfg` | 可选整条管线；提交、外发和合并仍受授权边界约束 |

产品反馈与发布配套能力：`spec-sweep` 扫描已配置反馈源，`spec-product-pulse` 汇总时间窗内产品信号，`spec-riffrec-feedback-analysis` 分析指定反馈采集，`spec-promote` 为已交付功能起草推广文案。它们不自动获得外发或发布权限。

### 内部辅助 Skill

以下 Skill 由持有相应授权的 workflow 按需调用，不是推荐给用户直接运行的研发入口：

| Skill | 职责 |
|---|---|
| `spec-test-browser` | 在调用方确定的目标地址和权限范围内执行浏览器测试 |
| `spec-worktree` | 为调用方创建或管理隔离工作树 |
| `spec-commit` | 在已有提交授权下创建范围明确的 commit |
| `spec-commit-push-pr` | 在已有提交与交付授权下提交、推送及创建或更新 PR |

不确定从哪里开始时，由 `using-spec-first` 选择一个最匹配入口。上述 Skill 在宿主会话中使用，不是 `spec-first` 的 shell 子命令；具体调用形式以宿主发现的入口为准。完整边界见[公开入口与 Skill 目录](docs/05-用户手册/24-公开入口与Skill目录.md)。

## 从 Prompt 到可信变更

```text
粗略想法 -> spec-brainstorm --\
已有 PRD -> spec-prd ----------+-> spec-plan -> [spec-write-tasks] -> spec-work -> spec-code-review -> spec-compound
```

`spec-prd` 是已有 PRD 或 brownfield 请求的替代入口；`spec-doc-review` 是跨阶段的可选 review lane，可审查 requirements、plan 或 task pack。

### 一个完整的最小路径

```text
粗略想法
  → spec-brainstorm
  → spec-plan
  → spec-work
  → spec-code-review
  → spec-compound（有合格经验时）
```

例如：

```text
spec-brainstorm "为 CLI 增加配置导入"
# 审查 docs/plans/ 中的 requirements-only plan
spec-plan <plan-path>
# 执行 implementation-ready plan
spec-work <plan-path>
```

每个 workflow 都会说明它是否创建 artifact、是否修改源码以及需要哪些验证。不要把“模型说已完成”当作现场结果；以可回源的命令、日志、测试或 owner evidence 为准。

## 仓库会留下什么

### 项目会留下什么

```text
docs/
  ideation/      spec-ideate 的方向探索
  brainstorms/   spec-prd 的澄清产物
  plans/         requirements-only 与 implementation-ready plans
  tasks/         从 plan 派生的可选 task packs
  solutions/     已验证且可复用的工程经验
  validation/    测试、审查和现场验证证据
.spec-first/
  workflows/     条件式验证证据（默认 gitignore）
```

这些目录中的 artifact 只证明其直接证据覆盖的 claim。宿主 runtime assets 是可重建的 delivery projection，不是 canonical source；行为修改应回到 `skills/`、`templates/`、`src/cli/` 和 checked-in docs，再用 `spec-first init` 刷新投影。

## 信任如何建立

`spec-first` 遵循一条简单分工：**脚本准备事实，LLM 做语义判断，项目 owner 授权副作用。**

- 完成声明的范围不能超过证据直接支持的范围。
- mutation、verification、handoff、source/runtime 和 knowledge 出口有明确边界。
- provider 和历史 artifact 默认是带 provenance、freshness 与 limitation 的 advisory input，进入结论前需要回源确认。
- 长时或高影响工作需要 scope、checkpoint、停止条件、恢复点和独立验证。

完整原则见[项目角色契约](docs/10-prompt/结构化项目角色契约.md)、[Source/Runtime 边界](docs/contracts/source-runtime-customization-boundary.md)、[Verification Summary 合同](docs/contracts/verification/verification-run-summary.md)和 [Honest Closeout 合同](docs/contracts/workflows/honest-closeout.md)。

## 宿主支持

| 宿主 | 当前建议 | 初始化 |
|---|---|---|
| Claude Code | 主要支持，推荐起点 | `--claude` |
| Codex | 主要支持，推荐起点 | `--codex` |
| Kiro | opt-in preview | `--kiro` |
| Qoder | opt-in preview | `--qoder` |
| Cursor | `generated_runtime_preview` | `--cursor` |
| OpenCode | `generated_runtime_preview` | `--opencode` |
| ZCode | opt-in preview，部分能力已有实机验证 | `--zcode` |
| Pi | opt-in preview，部分能力已有实机验证 | `--pi` |

生成 runtime、宿主发现入口和真实 workflow 验证是不同层次。运行 `spec-first doctor --verbose` 查看当前项目事实；详细状态以[Runtime Capability Catalog](docs/catalog/runtime-capabilities.md)为准。

## 适用边界

适合以下团队：

- 已经使用 AI coding 宿主；
- 需要跨会话或跨宿主保留意图和交接；
- 需要计划、review 和验证证据；
- 希望将合格经验沉淀回项目。

以下情况通常不需要它：

- 只想复制一次性 prompt；
- 不允许仓库保存 workflow artifact；
- 需要独立 IDE 或中心化流程引擎；
- 希望工具替项目 owner 决定产品优先级和架构。

## CLI 参考

```bash
spec-first quickstart  # 检查前置条件并进入 init
spec-first doctor      # 检查环境和 runtime 健康状态
spec-first init        # 生成所选宿主的 runtime assets
spec-first update      # 升级 CLI 并刷新 runtime assets
spec-first clean       # 移除所选 generated runtime assets
spec-first plans audit --status completed --json
```

运行 `spec-first --help` 查看全部选项。

## 开发与贡献

```bash
npm run typecheck
npm run test:unit
npm run test:smoke
npm run test:integration
npm run test:release
npm run build
```

源码变更应发生在 canonical source surfaces。只有 runtime source 变化时，才通过 `spec-first init` 重新生成 runtime copies。更多信息见[贡献指南](CONTRIBUTING.md)、[安全策略](SECURITY.md)、[版本记录](CHANGELOG.md)和 [GitHub Issues](https://github.com/sunrain520/spec-first/issues)。

项目使用 MIT License。

## 相关文档

- [用户手册](https://github.com/sunrain520/spec-first/blob/master/docs/05-%E7%94%A8%E6%88%B7%E6%89%8B%E5%86%8C/README.md)
- [Runtime Capability Catalog](https://github.com/sunrain520/spec-first/blob/master/docs/catalog/runtime-capabilities.md)
- [项目角色契约](https://github.com/sunrain520/spec-first/blob/master/docs/10-prompt/%E7%BB%93%E6%9E%84%E5%8C%96%E9%A1%B9%E7%9B%AE%E8%A7%92%E8%89%B2%E5%A5%91%E7%BA%A6.md)

## 加入社区

- [GitHub Issues](https://github.com/sunrain520/spec-first/issues)
- [官方网站](http://spec-first.cn/)
