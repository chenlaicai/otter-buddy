---
id: F20260825cdef
title: commit 规范三方一致性订正（issue #441 验证关闭 + #432 修复）
summary: |
  commit 规范存在两处不一致：#441 报告 CI PR 标题正则与 commit-msg hook 模块段规则不一致
  （已于 PR #437 修复并合入，方向为收紧 hook 对齐 CI `\[a-z]+\]`，本特性验证关闭）；
  #432 报告 commit-convention.md 自身不一致（Message Format 列出 6 个类型含历史遗留
  `Feature`，Type Tags 表与 hook 白名单只收录 5 种）。本特性按 git log 存量验证结果
  执行方向 1：文档收敛至 5 种类型，删除 `Feature`。
change_type: fix
status: active
capability_test: "n/a: 纯文档订正 + 既有 hook/CI 行为验证，无 LLM 参与行为"
created_in_conversation: 3241317b-99d6-4d78-9248-ff208a7461bc
---

# commit 规范三方一致性订正（issue #441 验证关闭 + #432 修复）

## 背景与需求

### 问题描述

commit 规范的三处载体（文档 `.pi/skills/code-implementation/references/commit-convention.md`、
钩子 `.githooks/commit-msg`、CI `.github/workflows/ci.yml`）应保持一致，实际出现两处不一致：

1. **#441（已修复，验证关闭）**：CI PR 标题检查模块段正则 `\[a-z]+\]` 与 hook 模块段
   正则 `\[a-z][a-z-]*\]` 不一致——hook 允许连字符（示例还举了 project-setup），CI 不允许，
   导致 PR #437 本地过 hook、CI 红。已于 PR #437（commit 3543aa6a）修复合入：hook 收紧
   对齐 CI + 误导文案修正。本特性验证当前状态一致性并关闭 issue。

2. **#432（本特性修复）**：commit-convention.md 自身不一致——Message Format 节列出
   `Feature`, `Feature Update`, `BugFix`, `Refactor`, `Design`, `New Feature` 6 个类型，
   但 Type Tags 表只收录 5 种（无 `Feature`）；hook 白名单（PR #431 后）与 Type Tags
   表一致。`Feature` 疑似 `New Feature` 的历史别名，Type Tags 表重写时收敛但 Message
   Format 节没同步。

### 方案选择

**#432 按 issue 内裁决流程执行**：查 git log 存量决定「补表」还是「删 Feature」。

存量验证结果（本 worktree 实测，已经检视复核订正）：

- 完整 type 段为 `[Feature]` 的提交共 **10 条**，日期 2026-07-28 ~ 2026-08-18，
  最近一条为 8/18 的 #300——**非远古遗留，但 8/18 后已无新增**
- 初次计数 7 条系 regex 过窄（`[a-z0-9]{4}` 恰好 4 字符码），遗漏 3 条 5-6 字符随机码
  提交（#202 rstart / #132 chunk / #94 guard）；订正后口径 `[a-z0-9]{4,10}`（检视獭-452 发现）
- hook 白名单 5 种（PR #431 起强制）已阻止新增 `[Feature]` 提交——存量不会再增长
- 其余 `][Feature]` 匹配均为 `[Feature Update]` 前缀误匹配

裁决：**方向 1（删 `Feature`）**——类型清单收敛至 Type Tags 表的 5 种。理由：
单一规范名、检索一致性优先；hook 已强制 5 种，文档同步是唯一未对齐处；存量 10 条
属历史事实不 rewrite。

**#441 方向复核**：简报默认方向为「放宽 CI 对齐 hook」，但与已合入事实冲突——PR #437
已按「收紧 hook 对齐 CI」修复合入（数据支撑：CI 是 7/27 起唯一强制门禁，门禁后
`[a-z]+` 无例外；连字符先例仅存在于 CI 门禁之前的蛮荒期，10 条全部合入于 7/27 前）。
按 A2 诚实优于服从，以已合入事实为准：验证一致性后关闭 issue，不反向改动。

## 方案设计

### 改动范围

| 文件 | 改动 | 对应 issue |
|------|------|-----------|
| `.pi/skills/code-implementation/references/commit-convention.md` | Message Format 节 type 行：6 个类型收敛为 5 种（删 `Feature`），标注历史别名与存量出处 | #432 |

无代码改动。`.githooks/commit-msg`、`.github/workflows/ci.yml` 经核实当前已一致
（模块段均 `\[a-z]+\]`，不允许连字符），不动。

### 一致性核对点（三方）

| 核对点 | 文档 | hook | CI | 状态 |
|--------|------|------|-----|------|
| 模块段正则（不允许连字符） | 未列举正则（示例含 agent-runtime 连字符词，属模块名单词非格式） | `\[a-z]+\]` | `\[a-z]+\]` | ✅ 一致（#441 已修） |
| 类型清单 5 种 | ✅ 本 PR 收敛 | `(Feature Update\|BugFix\|New Feature\|Refactor\|Design)` | 不校验类型 | ✅ 一致（#432 本 PR） |
| 日期校验 | 未涉及 | F 类偏差 >2 天拒绝（#422） | PR 标题 feature ID 日期检查 | ✅ 各自分工，不冲突 |

### 关联发现（不在本 PR 修复）

- `CONTRIBUTING.md:24` 类型清单 3 种（缺 Refactor/Design），同模块文档滞后——
  建议建 issue 跟踪
- `src/usecases/health/commit-parser.ts:33` STANDARD_FORMAT_REGEX 类型白名单 3 种，
  属 RHI 采集边界，已有 #425 跟踪（Phase 3 节奏）

## 验证

### 存量验证（裁决依据）

```bash
# 完整 type 段 [Feature] 的提交：10 条，2026-07-28 ~ 2026-08-18
# （regex 口径 [a-z0-9]{4,10}：覆盖 4-10 位随机码，含 5-6 字符的 #202/#132/#94）
git log --all --extended-regexp \
  --grep='^\[F[0-9]{8}[a-z0-9]{4,10}\]\[[a-z]+\]\[Feature\]( |$|\[)' --format='%h %ad %s' --date=short
```

### hook 行为回归（本 worktree 实测）

回归脚本已入档：`scripts/tmp-verify/hook-regression-verify.py`（python 提取 hook 内
node 代码逐用例真实执行，非重写正则），复跑 6 用例全 PASS：

| 用例 | 预期 | 结果 |
|------|------|------|
| `[F20260825zzzz][ci][Design] 提交规范三方一致性订正…` | PASS | ✅ |
| `[F20260825zzza][ci][New Feature] 新功能应通过` | PASS | ✅ |
| `[R20260825zzzb][ci] research 无类型应通过` | PASS | ✅ |
| `[F20260825zzzc][ci][Feature] 类型 Feature 应拒绝` | REJECT | ✅ |
| `[F20260825zzzd][ci-x][Design] 模块段连字符应拒绝` | REJECT | ✅ |
| `[F20260825cmhg][ci][BugFix] 存量ID应通过` | PASS | ✅ |

> 注：用例 ID 后缀须用合法字符集（首位 a-kmnp-z，后 3-9 位 2-9a-kmnp-z，排除 l/o/0/1）。

### CI 验证

PR 创建后由新 commit 触发 CI run（不用 `gh run rerun`——重放原始 PR_TITLE 快照，
见 #441 描述），检查「Check PR title format」「Check PR title feature ID date」全绿。
