---
id: F20261028egitx
title: 外部仓隔离 worktree 的 Git 写执行域与真实沙箱装配
summary: 修复 #1682 跨仓提交回归；从目标真实 Git 注册表识别受控隔离 worktree，并补齐 SDK 丢弃 baseToolsOverride 造成的物理沙箱断链。
change_type: fix
capability_test: "n/a: 确定性 Git 执行域与工具装配由单元、真实沙箱及真实 SDK 集成测试覆盖"
created_in_conversation: 7b41e085-5c21-4bd1-adfe-dc3ef051753d
causal_links:
  - F20261027gscv
tags: [bash-guard, git, cross-repo, bugfix]
modules: [src/frameworks/agent/git-execution-policy.ts, src/frameworks/agent/bash-sandbox.ts, src/frameworks/agent/pi-session-factory.ts, src/interface-adapters/agent-runtime/tools/tool-factory.ts]
---

## 目标

修复 #1682：CoLink 等外部项目已登记在 `<repo>/.otter/worktrees/<name>` 的 worktree 可执行既有白名单 Git 工作流。补齐同一执行链上独立审计发现的生产沙箱装配断链，保持主目录、未登记路径与 `.git` 指针的默认拒绝。

## 非目标

不放开外部主目录、main/develop 直写、任意 Git 元数据写或复杂 Shell；不新增 Git 子命令语义，不建立通用特权 broker。`restart_service` 仅复用现有 dev server 白名单脚本，不新增 `--add`、任意 PID 或主服务重启权限；主进程保护不减弱。本 PR 不代表旧运行进程已加载新代码。

## 设计与取舍

机制判定：命中②权限约束，修复已有授权事实源，不改豁免集合；④涉及既有 Git 执行域扩展。只承认真实 `git worktree list` 中、直接位于外部仓 `.otter/worktrees/` 的已登记 worktree，主目录和普通外部目录不认。退役条件：若跨仓执行上下文由宿主提供受信任 repo/worktree 注册源，可删除只读 Git 探测适配；授权与拒绝边界保留。

### Git 执行域（L1）

linked worktree 的 `rev-parse --show-toplevel` 返回 worktree 根，不是主仓根。解析器用 `git rev-parse --path-format=absolute --git-common-dir` 定位公共 Git 根，再按行读取 `worktree list --porcelain -z` 的 worktree 项。只读探测失败 fail-closed。grant 记录外部 worktree 根，profile 同时保留宿主只读/自治区与外部最小 Git 写域；普通写 allow 先于通用 `.git` deny，防止重开指针。

### SDK 装配（L1）

实测本仓锁定的 1.1.0 与最新 1.4.0 `createAgentSession` 均不转发 `baseToolsOverride`。`tools=[] + 同名 customTools` 亦被 allowlist 过滤，不能作为替代。`sandboxed-agent-session.ts` 仅使用公开 `Agent`、`createAgentSessionServices` 与 `AgentSession`，生产已有 `resourceLoader/modelRuntime/settingsManager` 原样复用；没有 services 时才走公开 services 创建路径。必须保留 `initialActiveToolNames`，并验证 `setActiveToolsByName` 后仍使用覆盖工具。

### 受控重启（L1）

物理沙箱恢复后 `(deny signal)` 重新承重。注册窄 `restart_service(port, projectDir?)`，由宿主直接 `execFile(process.execPath, [固定脚本, ...])`，不经 bash，不开放任意 signal。大獭 direct，小獭 deferred；manifest 与 fallback 均覆盖。

## 验收标准

| 场景 | 操作 | 预期 |
|---|---|---|
| #1682 原样回归 | 对外部已登记隔离 worktree 执行 `git -C … commit` / `cd … && git commit` | 真实 add/commit 成功 |
| 外部主目录 | `git -C <external-repo> add/commit` | 文本层与物理层均拒绝 |
| 未登记路径 | 伪造 `.git` 指针目录执行 commit | resolver null，沙箱拒绝 |
| 宿主逃逸 | 外部 Git pre-commit 钩子写宿主仓 | 文件不存在 |
| 元数据边界 | 外部 Git pre-commit 钩子写 worktree `.git` 指针 | 指针不变 |
| SDK 装配 | 经公开构造器创建真实 AgentSession，执行 bash/write/edit | 宿主 bash 写拒绝；write 守卫生效；授权区 edit 成功 |
| 重激活 | `setActiveToolsByName([])` 后恢复工具名单 | bash 仍为沙箱实现 |
| 受控重启 | 固定参数调用、相对路径拒绝 | 不经 bash；不开放 PID/`--add`；脚本原校验保留 |

## 验证

红链：#1682 外部集成原返回 null；授权组合初测暴露宿主只读域丢失与 `.git` 指针重开；真实 SDK 测试证实原生产接线丢弃覆盖工具，`tools=[] + customTools` 激活后为空。均已以落点/注册表/退出码复核，不以 mock 入参代替行为。

交付前执行：`npm run build`、`npm test`（含真实 SDK 与临时外部仓沙箱集成）。当前运行实例仍是旧进程；合入并通过既有受控运维流程重启后才宣称生产恢复。
