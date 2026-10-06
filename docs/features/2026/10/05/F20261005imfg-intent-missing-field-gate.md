---
id: F20261005imfg
title: lint-intent 缺字段文档灰色绕过窗口收口（error + 存量豁免清单 ratchet）
summary: change_type ∈ {feature, prompt, 缺失} 且无 intent 块（或 intent 块缺 problem/expected_effect）从静默跳过升级为 error；256 篇存量冻结进 scripts/intent-exempt-list.txt（ratchet 只减不增，EXEMPT_MAX=256 防膨胀）；change_type 缺失按 feature 判定（L0 定夺）。
change_type: feature
capability_test: "n/a: 纯 lint 脚本逻辑改动（A 类），无 LLM 参与行为；由 tests/lint/lint-intent.test.ts 36 用例 + gate 实跑覆盖"
modules:
  - scripts/lint-intent.mjs
  - scripts/intent-exempt-list.txt
  - tests/lint/lint-intent.test.ts
  - docs/README.md
tags:
  - lint
  - intent
  - observability
  - tech-debt
  - ratchet
created_at: "2026-10-05"
created_in_conversation: a9260c50-cef6-412e-a0b4-282287a13103
intent:
  problem: "特性文档 frontmatter 缺 change_type/modules/intent 字段时 lint-intent 静默跳过——新文档什么都不写即可绕过 intent gate，CI 假绿（PR #838 首版实证）"
  expected_effect: "缺 intent 块（或块内缺 problem/expected_effect）的新 feature/prompt/无 change_type 文档 lint-intent 退出码 1；256 篇存量豁免清单外新增 ID 触发 EXEMPT_MAX error；补齐 intent 的存量被 lint 提示移出清单"
  verify_by:
    type: behavior_check
---

## 背景与需求

### 问题描述

issue #839（PR #838 审视程序性移交）：特性文档 frontmatter **完全缺失** change_type/modules/intent 字段时，lint-intent 对该文档跳过全部检查且无 error——CI 显示绿，实为灰色绕过。检查的完备性依赖字段先存在，而字段本身无强制。

### 现状口径（实现前）

- `validateIntent` 缺 intent 分支：`change_type=feature` → warning（不阻断）；`prompt` 不在 REQUIRED/RECOMMENDED 任一集合 → 完全静默；`change_type` 缺失 → 完全静默
- intent 块存在但缺 problem/expected_effect：仅当 change_type 明确为 feature 时 error——change_type 缺失时静默
- 实测存量：lint:docs 对 change_type 缺失零检查（validateChangeType 只查「存在但未知值」，known-values.ts:113-117）

### 大獭拍板（L1）

采用 issue 方案 1（error + 存量豁免清单 ratchet 制），不做方案 2（warning-only）。

## 方案设计

### 规则矩阵（实现后）

| 文档状态 | 清单外（新文档） | 清单内（存量豁免） |
|---|---|---|
| change_type=feature/prompt 或缺失，无 intent 块 | **error** | warning（提示移出清单） |
| 同上，intent 块缺 problem/expected_effect | **error**（子窗口防御） | warning（5 篇 2026-09-15 goal/why 自创 schema） |
| change_type=bugfix/fix/refactor 等，无 intent 块 | warning（推荐，不变） | 同左 |

### 关键决策

1. **change_type 缺失按 feature 判定（L0 自行定夺，按大獭授权）**：调研发现 lint:docs 对 change_type 缺失零检查（`validateChangeType` 仅在字段存在时校验未知值，frontmatter-validator.ts:113-117）——这正是 #839 暴露的缺口本身。若 change_type 缺失仍静默，新文档连 change_type 都不写即可保持灰色窗口，收口不闭环。视同最严类 feature 是唯一不留窗口的选择。
2. **豁免口径含 bad-schema 存量（5 篇）**：首版实现后发现 5 篇 2026-09-15 文档 intent 块用 goal/why/non_goals 自创 schema 且 change_type 缺失——fallback 收口后暴露为 error。若只为绕开这 5 篇把 fallback 限定在「缺 intent 块」分支，会留下「新文档写 `intent: {foo: 1}` 绕过全部校验」的子窗口（与 #839 同构）。故豁免清单口径 = 实际触发缺字段规则的全体存量（251 无块 + 5 bad-schema = 256），规则本体保持完备。
3. **prompt 纳入 REQUIRED**：issue 拍板方案 1 原文即「change_type=feature/prompt 但无 intent 块 → error」；prompt 是软代码主力 change_type（66 篇），缺 intent 时的静默通过是最宽绕过面。
4. **豁免清单独立数据文件**（scripts/intent-exempt-list.txt）+ 脚本内 EXEMPT_MAX 常量：参照仓内 ratchet 双先例——lint-docs.mjs 的 MAX_WARNINGS（#470）与 prompt-anchor-whitelist.txt（独立数据文件 + 失效检测）。EXEMPT_MAX 冻结 256，加 ID 必须显式改常量，膨胀在 diff 中显形；文档补齐后 lint 主动提示移出（过期条目检测）。
5. **豁免判定以 fm.id 为键**：validateIntent(fm, fileId) 二参，主流程传 frontmatter.id；测试直调不传 fileId 时按非豁免判定（锁定新口径）。

### 机制识别检查点判定（worktree-isolation 步骤 4 / Modification-Class 论证）

命中清单一项：「新增持久化存储（文件）」——scripts/intent-exempt-list.txt 是新数据文件。**但走修法决策树①（narrow-fix）而非④**，论证：该文件是 lint-intent 既有 gate 语义（warning→error 收紧）的配套存量快照，非新机制——仓内同模式先例已存在两处（lint-docs MAX_WARNINGS 常量、prompt-anchor-whitelist.txt 数据文件），无新生命周期、无新运行时行为、无新决策分支被持久化消费（lint 每次全量重算，清单只是静态对照表）。

## 实现细节

### scripts/lint-intent.mjs

- `INTENT_REQUIRED_CHANGE_TYPES`：+prompt
- 新增 `FALLBACK_CHANGE_TYPE = "feature"`（change_type 缺失口径）+ `EXEMPT_LIST_PATH`/`EXEMPT_MAX=256`/`loadExemptSet()`
- `validateIntent(fm, fileId)`：豁免判定（`EXEMPT_IDS.has(fileId)`）；缺 intent 分支、problem 分支、expected_effect 分支均按「豁免 → warning / 非豁免 → error」双轨；内部统一 `effectiveChangeType`
- main()：传 `frontmatter.id`；ratchet 上限核对（清单 > EXEMPT_MAX → error）；过期条目提示（清单内 ID 已有完整 intent → warning 提示移除）

### scripts/intent-exempt-list.txt（新增）

256 篇冻结清单：feature 191 / prompt 35 / change_type 缺失 25（无 intent 块）+ 5（bad-schema）。生成方式：worktree 内一次性脚本按 parseFrontmatterFromContent 真实解析结果枚举（与 lint 同一 parser，非手抄）。

### tests/lint/lint-intent.test.ts

36 用例（原 33 + 新 9 - 改写 6）。新增锁定用例：
- 缺 intent 块的新 feature/prompt/无 change_type 文档 → error
- 豁免清单内（取真实清单首个 ID）→ warning 非阻断（feature/prompt 双口径）
- bad-schema intent：豁免内降 warning / 清单外 error（子窗口防御）
- EXEMPT_MAX ≥ 清单行数 > 200（防清单意外清空致 gate 失真）

### docs/README.md

新增「intent 块约定」节（lint 报错指向「修复参考：docs/README.md」，此前该文档无 intent 规则记录——补齐指向闭环）。

## 设计取舍

- **不做时间界（created_at 软代码先例式）**：intent 块的存在性可由清单精确枚举，无需时间界近似；时间界存在回填旧日期逃逸面（SOFT_CODE_ENFORCE_DATE 注释自认）。豁免清单一次冻结更精确且天然只减不增。
- **豁免键用 fm.id 而非文件路径**：id 是文档稳定标识（路径含 slug 可变）；id 缺失的文档本来就过不了 lint:docs 的 Missing id error。
- **存量豁免降级为 warning 而非完全沉默**：保留可观测性（ratchet 地板的推动力），且 lint 输出中显式提示「补齐后请从清单移除」。

## 验证

- [x] 单测 36/36 通过（含 9 个新锁定用例）
- [x] gate 实跑（探针法）：新文档缺 intent 块 → `Missing intent field for feature（#839…）` + exit 1；删除探针后 690 docs OK + 308 warnings（豁免提示）+ 0 error
- [x] 存量豁免：256 篇清单内文档全部降级 warning（含 5 篇 bad-schema）
- [x] 既有 error 不回归：顶层 verify_by / invalid verify_by.type / fuzzy word 门禁 / golden_replay 核对用例全绿
- [x] lint:docs / lint-capability-docs / lint-historical-docs 实跑通过
- [x] 最简实现检查：已过——豁免对照表 + 双轨降级是 ratchet 模式最小实现；替代方案（逐篇补齐 256 篇 intent）单 PR 体量不可行且违背「不追诉存量」既定口径
- [x] 全量测试套件通过（见 PR）

## 对抗审视记录

（审视后回填）

## 后续

- 256 篇存量按 ratchet 逐步补齐 intent 块（每补一篇从清单移除并下调 EXEMPT_MAX）
- #930/#1067（intent 治理族）另行推进，本 PR 不依赖其拍板
