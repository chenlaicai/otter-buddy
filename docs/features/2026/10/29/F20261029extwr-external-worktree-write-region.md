---
id: F20261029extwr
title: 结构化 write/edit 写区补外部仓 worktree 动态区与 tmp 多根
summary: 修复 file-write-policy 静态写区两大误拒——外部仓（colink 等）.otter/worktrees 恒拒与 /tmp、/var/tmp 别名不在写区；动态判定区复用 git 执行域同语义注册表判定（注入式，无循环依赖），tmp 区多根 realpath 归一去重。
change_type: bugfix
capability_test: "n/a: 守卫误拦修复，验证走 file-tool-guard.test.ts 回归 + healing 现场复放（本机 smoke 8/8）"
created_in_conversation: 2deb62bf-1e41-464d-a794-0da4c75a5c03
created_at: 2026-10-29
causal_links:
  - "#1695"
  - "#1694"
  - "#1685"
  - "#1688"
tags:
  - bash-guard
  - file-write-policy
  - external-worktree
  - tmp-alias
  - false-positive
modules:
  - src/frameworks/agent/file-write-policy.ts
  - src/frameworks/agent/bash-sandbox.ts
  - tests/frameworks/agent/file-tool-guard.test.ts
---

# 结构化 write/edit 写区补外部仓 worktree 动态区与 tmp 多根

## 背景

#1695（healing 实锤两条）：

1. **缺口 A（外部仓 worktree 恒拒）**：2026-10-29 06:25（conversation 74c24a78，healing b9772a88）——colink 仓真实注册 worktree 内 `edit .../ChannelDigest.tsx` 被 `file-tool-guard/main-repo-write` 拒。git 执行域已认外部 worktree（#1685/#1688），结构化写面没跟上。
2. **缺口 B（/tmp 别名缺口）**：2026-10-29 06:38（conversation 3241317b，healing caa5ab31）——`write mkdir /private/tmp/...` 被拒。tmp 写区根仅 `os.tmpdir()`（本机 `/var/folders/.../T`），`/tmp`（→ `/private/tmp`）与 `/var/tmp` 是不同目录。

搭档 10-29 定调：误拦已致海獭系统整体效率下降，双线并行修（本线与《bash拦截优化》对话），分工切线零文件冲突。

## 根因

`file-write-policy.ts` `deriveAllowedRoots` 静态写区仅五区（主仓 workspaces/worktrees/workforms/alpha/os.tmpdir()）：

- 外部仓 `.otter/worktrees/` 完全不在清单；
- tmp 单根，别名形态落点不在写区。

## 方案设计

### 缺口 A：动态判定区 external-worktrees（注入式）

- `FileWriteRegion` 增 `external-worktrees` 标签（无静态根）；
- `FileWritePolicyOptions` 增 `resolveExternalWorktree?: ExternalWorktreeResolver | null`——静态白名单全部 miss 后，把落点**归约到最近的 `.otter/worktrees/<name>` 边界**（`nearestExternalWorktreeRoot` 纯形态归约）再交给 resolver 判定；
- 生产 resolver = `resolveExternalGitWorktree`（git 执行域同函数）：rev-parse commonDir + `git worktree list` 注册表双验 + 父目录必须为该仓 `.otter/worktrees/`——伪造 `.git`/普通目录/外部仓主树均不认；
- **依赖方向不破坏**：file-write-policy 不 import git-execution-policy（既有方向是后者依赖前者），resolver 经装配点（bash-sandbox.ts `createSandboxedTools` / `createSandboxSpawnHook`）注入；
- `.git` 元数据组件闸在动态区**之前**执行（`containsGitMetadataComponent`），外部 worktree 的 `.git` 指针/gitdir 仍拒——动态区不重开元数据写面；
- **归约的必要性**（修中实证）：resolver 原语义只认 worktree 根直接命中；edit/write 落点是树内文件路径，不归约则恒 null（smoke 初版 2 FAIL → 归约后 8/8 PASS）。

### 缺口 B：tmp 区多根

tmp 区根展开为 `[os.tmpdir(), "/tmp", "/var/tmp"]`，realpath 归一后同区去重（`pushRoot`，macOS `/tmp` → `/private/tmp` 与 `/var/tmp` → `/private/var/tmp` 展开后保留真实形态）。`rootsOverride.tmp` 语义为整体替换三根（测试 fixture 隔离用）。

## 影响范围

| 文件 | 变更 | 行为变化 |
|---|---|---|
| src/frameworks/agent/file-write-policy.ts | +动态区判定 +nearestExternalWorktreeRoot +tmp 多根 +pushRoot | 外部仓注册 worktree 内 write/edit 放行；/tmp、/var/tmp 落点放行；其余边界不变 |
| src/frameworks/agent/bash-sandbox.ts | 装配点注入 resolveExternalGitWorktree（tools + spawnHook 两处） | 生产 write/edit 与 git 执行域同源判定 |
| tests/frameworks/agent/file-tool-guard.test.ts | +4 用例（外部放行/伪造拒/元数据拒/缺省拒）+ tmp 多根断言 | 回归覆盖新边界 |

## 验证

### 修前红（本机现场，2026-10-29）

- healing b9772a88 / caa5ab31 两条 open 误拦记录（上文）。
- 本机跑 `npx vitest run tests/frameworks/agent/file-tool-guard.test.ts` 全套 28 用例红：fixture `mkdir .../repo/.git` 全部 `EPERM: operation not permitted`——**根因独立于本修复**：沙箱 profile 的 `(deny file-write* (regex #"/\.git(/|$)"))` 被 detached 子进程继承（macOS Seatbelt 特性，detached-launch.mjs 起的进程同样受限），本机任何路径创建 `.git` 组件都被 OS 拒。守卫测试 fixture 需要伪造 `.git` 目录（负门用例），本机沙箱内无法构造 → CI 是唯一可跑环境。该断点已记 #1695 评论，属守卫自开发工作流问题（另线处理）。
- 修前 smoke（生产 resolver 直调）：外部 worktree 文件路径判定 `null`（resolver 只认根直接命中）——本修复归约逻辑的直接依据。

### 修后绿

- 真实注册表 smoke（dist + 生产 resolveExternalGitWorktree，2026-10-29 本机 detached）：8/8 PASS——
  - colink pr3c-thread-public 树内文件放行（b9772a88 复放）✓
  - colink _baseline-check（真实注册表另一 worktree）放行 ✓
  - /tmp、/var/tmp 落点放行（caa5ab31 复放）✓
  - /etc、主仓源树、外部 worktree `.git`、外部仓主树四负门全拒 ✓
- CI 回归：file-tool-guard.test.ts（含既有 28 用例 + 新增 5 用例）、bash-sandbox.test.ts、tsc ——PR checks 为准。

## 取舍

- **归约形态匹配 vs 全路径 resolver 化**：归约只产生「候选」，真实性仍由 resolver 的注册表判定兜底——伪造 `.otter/worktrees/x` 目录形态命中归约但过不了注册表，保持单一真相源。
- **tmp 三根 vs 保守单根**：三根均为系统级临时目录语义（POSIX 惯例），realpath 归一后无重叠；TOCTOU 属 file-write-policy §5.2 已声明非目标，不新增敞口。
- **`.git` deny 继承断点不在本 PR 修**：属 bash-sandbox 物理层与守卫开发工作流问题（1693 终态对齐范畴），避免跨线撞车；已留 #1695 评论。

## 遗留与移交

1. 沙箱 `.git` deny regex 被 detached 子进程继承 → 守卫测试本机不可跑（只能 CI）——已评论 #1695，建议归口《bash拦截优化》线（与 1693 终态对齐同处理）。
2. `git worktree add` 后 `could not write config file .git/config: Operation not permitted`（grant 的 config-lock 域只覆盖 `config.lock`，rename 到 `config` 的最终落点被拒）——1694 线范畴（git-execution-policy/bash-sandbox），已递话。
