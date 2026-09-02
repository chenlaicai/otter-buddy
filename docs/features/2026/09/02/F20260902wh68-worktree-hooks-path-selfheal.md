---
id: F20260902wh68
title: core.hooksPath 自愈脚本：worktree/环境覆盖场景的本地钩子防线（#684）
summary: 新增 scripts/ensure-hooks.mjs 检测并自愈失效的 core.hooksPath（.husky/_ 残留、绝对路径覆盖、未配置、部分钩子缺失），prepare 接管为自愈入口，新增 hooks:check/hooks:fix，附真实 git 仓库 + worktree 的 8 用例防回归测试。
change_type: feature
status: implemented
tags: [git-hooks, worktree, engineering-hygiene, self-heal]
modules: [scripts/ensure-hooks.mjs, package.json, README.md, README.en.md]
from: [F20260821kgts, F20260826hk47]
created: 2026-09-02
created_in_conversation: a56c349e-c566-438c-97d0-653a260171ed
capability_test: "tests/scripts/ensure-hooks.test.ts"
---

# core.hooksPath 自愈脚本：worktree/环境覆盖场景的本地钩子防线（#684）

## 背景与根因

Issue #684（2026-09-02）：#680/#681 两个开发过程独立发现 worktree 内本地 commit-msg 钩子未稳定生效，拦截时序不可靠，纵深防御只剩 CI 兜底。

复现与排查结论（本 worktree 实测，git 2.50.1）：

1. **相对路径 `.githooks` 在 worktree 下解析正常**——`git hook run commit-msg` 在 worktree 顶层与子目录均正确拦截非法 message，`extensions.worktreeConfig` 未启用，worktree 读共享 repo config。git 自身行为不背锅。
2. **坏的是 config 值本身**：issue 报告的 `.husky/_` 是外部工具改写 hooksPath 的又一次复发——同模式已三次在案：F20260821kgts（绝对路径覆盖，#476 前身）、#476（`run/_`）、#681（`.husky/_`，husky 系工具的指纹路径）。仓库内无任何 husky 引用（grep 证实），`.husky/` 目录不存在。
3. **危害机制**：git 对指向不存在目录的 hooksPath **静默跳过钩子**（无警告无报错），防线失效不可感知。

## 本次变更对旧特性做了什么

- 接管 F20260708r6p5 引入的 `prepare` 脚本：由裸 `git config core.hooksPath .githooks` 升级为 `node scripts/ensure-hooks.mjs`——健康时零副作用跳过，失效时才写回，行为是原命令的严格超集。
- 升级 F20260826hk47 的 README 验证步骤：手工 `git config core.hooksPath` 目检升级为 `npm run hooks:check`（机器可判定、fail-closed）。

## 方案设计

**scripts/ensure-hooks.mjs**（零依赖 node 脚本）：

- 判定（fail-closed）：`core.hooksPath` 未配置，或按 git 解析规则（相对路径基于仓库根，worktree 即 worktree 根）找不到全部必需钩子（commit-msg / pre-commit / pre-push / pre-merge-commit，与仓库 .githooks/ 现存四钩子对齐）的可执行文件 → 判失效；诊断信息列出缺失清单
- 自愈模式（默认，npm prepare / hooks:fix 入口）：写回 `.githooks` 并复检，写回后仍不可用则报错退出
- 只读模式（`--check`，npm run hooks:check）：只校验不修改，失效 exit 1——供人工/CI 验证
- 附带诊断信息：`--show-origin` 输出配置来源，指向失效目录时打印解析后的绝对路径，把「静默失效」变成可定位现场

**为什么写 repo config 而非 per-worktree config**：worktree 共享 repo-local config，任一 worktree 内自愈即时覆盖全部 worktree；无需启用 `extensions.worktreeConfig`（避免引入新的配置分裂面）。

## 变更清单

| 文件 | 变更 |
|---|---|
| `scripts/ensure-hooks.mjs` | 新增：检测 + 自愈 + `--check` |
| `package.json` | `prepare` 接管为自愈脚本；新增 `hooks:check` / `hooks:fix` |
| `tests/scripts/ensure-hooks.test.ts` | 新增：真实临时 git 仓库 + 真实 worktree 的 8 用例防回归（含审视处置新增的部分钩子缺失用例） |
| `README.md` / `README.en.md` | hooks 验证章节切换到 `npm run hooks:check` |

## 验证 [required]

| 验证项 | 结果 | 备注 |
|---|---|---|
| 手测：健康态 --check / .husky/_ 残留自愈 / 未配置自愈 / 绝对路径失效 / --check fail-closed | ✅ 5/5 | 本 worktree 实测 |
| vitest tests/scripts/ensure-hooks.test.ts | ✅ 8/8 | 含 worktree 内检测+修复全局生效、部分钩子缺失列出清单用例 |
| 真实仓库部分钩子失效模拟 | ✅ | 临时改名 pre-commit → 精确报出缺失清单，恢复后 exit 0 |
| 最简实现检查 | 已过最简检查 | 无现成实现可复用；脚本零依赖，若只做"检测"可更少代码但不满足 #684 修复要求（自愈） |
| 真实 commit 走完整 hook 链 | ✅ | 本 PR 提交即验证（pre-commit + commit-msg 实跑） |
| 主仓 hooks 行为不回归 | ✅ | 健康态脚本零副作用，不触碰配置 |

## 影响范围

- `npm install`（prepare）行为增强，正常环境无感知
- CI 不受影响（不新增 CI 步骤；hooks:check 可作后续 CI 接入备选，留待维护者决策）

## 对抗审视处置记录

**检视獭-甲 建议发现（PR #714 第一轮）**：判定只验证 commit-msg 单钩子，pre-commit/pre-push/pre-merge-commit 缺失时判「健康」放行——与要消灭的「静默失效」同构的窗口。

**处置：接受并修复（更好）**，大獭裁决本 PR 顺手修。决策树：改了让系统变好——检测覆盖 1/4→4/4 钩子，消除同构窗口；成本约 5 行脚本 + 1 用例，健康态行为不变（真实 .githooks 恰四钩子，实测通过）。已知代价：钩子清单需随仓库演进同步维护，缺钩子时 fail-closed 报错会明确提示（不会静默），风险可控。修复：REQUIRED_HOOKS 数组 + missingHooks() + 部分钩子缺失测试用例 + 真实仓库模拟验证。
