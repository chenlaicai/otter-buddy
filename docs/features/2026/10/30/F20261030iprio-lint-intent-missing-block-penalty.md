---
id: F20261030iprio
title: "lint-intent 软代码缺整块 intent 惩罚梯度倒置修复（#1238）"
summary: "软代码收口语义（F20260917sdpl）只覆盖「声明不完整」不覆盖「声明缺失」：软代码新文档缺整个 intent 块时早退到 change_type 分级（bugfix/refactor 只 warning），而缺 verify_by 却 error——缺得越彻底罚得越轻。修复：缺块分支插入软代码收口判定，软代码新文档缺整块 intent → error，与缺 verify_by 同权重。"
change_type: fix
capability_test: "tests/lint/lint-intent.test.ts"
created_in_conversation: a9260c50-cef6-412e-a0b4-282287a13103
created_at: "2026-10-30"
intent:
  problem: "lint-intent 的软代码收口（created_at ≥ 2026-09-17 缺 verify_by → error）依赖 intent 块存在才能触达；intent 块整个缺失时早退到 change_type 分级，bugfix/refactor 软代码新文档只得到 warning——惩罚梯度倒置（缺块 < 缺 verify_by），issue #1238 实测形态。"
  expected_effect: "软代码新文档（modules 含 prompts/ 或 .pi/、created_at ≥ 2026-09-17、非豁免）缺整个 intent 块时 lint-intent exit 1 并点名『Missing intent block for soft-code change』；缺 verify_by 的既有 error 保持；存量（旧 created_at / 豁免清单）与非软代码文档行为零漂移。"
  verify_by:
    type: capability_test
    description: "tests/lint/lint-intent.test.ts 新增 6 用例（1 红测主断言 + 5 回归锁）+ 全量 51 用例绿 + 全库 lint 漂移 diff 为零"
tags: [lint, intent, soft-code, penalty-gradient]
modules: [scripts/lint-intent.mjs, tests/lint/lint-intent.test.ts]
from: [F20261005imfg, F20260917sdpl]
supersedes: []
causal_links:
  - issue #1238（PR #1237 检视建议 #5 派生：软代码收口「声明缺失」全形态）
  - F20261005imfg intent 缺字段闸（已收 feature/prompt 缺块路径为 error，本篇补 bugfix/refactor/其他 change_type 路径）
  - F20260917sdpl 软代码 verify_by 收口（本篇把同一收口语义推广到缺块全形态）
---

# lint-intent 软代码缺整块 intent 惩罚梯度倒置修复

## 背景

issue #1238（09-29，PR #1237 检视建议 #5 派生）：lint-intent 对「软代码域 + created_at ≥ 2026-09-17 + 缺整个 intent 块」的文档惩罚比「缺 verify_by」更轻——缺得越彻底罚得越轻（惩罚梯度倒置）。

**幽灵工单核验（开工前实测，重要）**：issue 原文的实测样本（F20260929tbbd，change_type=feature）路径已被 F20261005imfg（10-05）顺手收口——feature/prompt 缺整块现已是 error。**但倒置缺口仍真实存在**：bugfix/refactor（及 feature/prompt 之外的 change_type）软代码新文档缺整块 intent 仍只走 `Recommended intent field` warning（lint-intent.mjs 早退分支），而同一文档若带 intent 块只缺 verify_by 却是 error（F20260917sdpl 收口）。issue 的修复建议（「软代码域判定 + isNewEnough 满足时，intent 块缺失应直接 error」）未被实现——非幽灵工单，按原建议收口。

## 根因

`scripts/lint-intent.mjs` 缺 intent 块分支（`!fm.intent` 早退处）只按 change_type 分级：

- INTENT_REQUIRED（feature/prompt）→ error（F20261005imfg 已收口）
- INTENT_RECOMMENDED（bugfix/refactor）→ warning，**直接 return，触达不到软代码收口判定**

而 verify_by 缺失分支对软代码新文档一律 error（不看 change_type）——两分支权重倒挂。

## 修复

缺块分支在 REQUIRED 与 RECOMMENDED 之间插入软代码收口判定：

```
INTENT_REQUIRED → 既有 error/warning（不变）
软代码 && 新 && 非豁免 → error「Missing intent block for soft-code change」（新增）
INTENT_RECOMMENDED → 既有 warning（不变）
```

效果：软代码新文档缺整块 → error，与缺 verify_by 同权重；feature/prompt 文案不变（既有测试契约不动）。

## 设计取舍

- **机制判定结论**：修法决策树七项清单全未命中（改既有 lint 规则的校验顺序与惩罚梯度，不新增配置/状态/定时任务/信号/存储/持久化决策分支/跨模块路径）→ 走①既有语义内修，Modification-Class: `narrow-fix`。收口语义（F20260917sdpl）本就该覆盖「声明缺失」全形态，本次是对该语义的补全而非新机制。
- **不动既有测试断言**：若按 issue 字面「先判软代码域收口、再判 intent 存在性」整体重排，feature 缺块的 error 文案会变，破坏 F20261005imfg 锁定的 2 个既有用例契约（改断言=改验证）。故采用插入式最小改动：效果达成（软代码新缺块全 change_type → error），既有契约零扰动。
- **豁免清单优先**：isExempt 判定先于软代码收口——存量豁免语义（ratchet 地板）不破，豁免文档维持 warning。
- **存量不追诉**：created_at < 2026-09-17 的软代码文档缺块维持 recommended warning（与 F20260917sdpl 时间界同口径）。
- **change_type 取 `fix` 不取 `bugfix`（枚举漂移避让）**：docs 域合法枚举是 `fix`（known-values.ts:10-16），lint-intent 域用 `bugfix`（lint-intent.mjs:45-46）——issue #1295「change_type 枚举漂移」的现场。本文档取 docs 域合法值 `fix` 避免推高 lint:docs ratchet（现存 3 个 warning 顶格）；漂移本身不在本 PR 修复范围（另案 #1295）。顺带实证：软代码新文档 change_type=`fix` 缺块同样被本修复的新分支拦（不受枚举漂移影响）。

## 验收标准

| 场景 | 操作 | 预期结果 |
|------|------|----------|
| 软代码新 bugfix 文档缺整块 intent | `validateIntent(fm, path)`，modules 含 prompts/、created_at 2026-10-01 | errors 含 `Missing intent block for soft-code change`；无 recommended warning |
| 软代码新文档缺 verify_by（有块） | 同上但 intent 含 problem+expected_effect | errors 含 `Missing intent.verify_by for soft-code change`（不变） |
| 软代码新 feature 文档缺整块 | change_type=feature | errors 含 `Missing intent field for feature`（F20261005imfg 契约不变） |
| 软代码旧文档缺整块 | created_at 2026-09-01 | 0 errors + recommended warning（不追诉存量） |
| 非软代码 bugfix 缺整块 | modules 含 src/ | 0 errors + recommended warning（语义不变） |
| 豁免清单文档缺整块 | 传豁免清单路径键 | 0 errors + 有 warning（豁免不破） |
| 全库零漂移 | `node scripts/lint-intent.mjs` 修复前后输出 diff | 告警分布逐条一致，exit 0 |

前六行为 tests/lint/lint-intent.test.ts 机械断言（`npx vitest run tests/lint/lint-intent.test.ts`）；末行为全库行为断言。

## Verification

1. **失败用例证据（bugfix 硬规则）**：
   - 修复前：`npx vitest run tests/lint/lint-intent.test.ts` → **1 failed | 50 passed**——红测 A（软代码新 bugfix 缺整块 → error）失败，失败原因正是本 issue 现状（仅 warning 降级）；B/C/D/E/F 五回归锁修复前即绿（锁既有行为）
   - 修复后：**51 passed (51)** 全绿
2. **全量零回归**：`npx vitest run` → 420 files / 5546 tests 全过
3. **全库零漂移**：`node scripts/lint-intent.mjs` 修复前后消息分布 diff 为空（缺块类告警均为存量豁免 warning），exit 0
4. **最简实现检查**：已过——单分支插入（净 ~10 行含注释）；更简路径（整体重排校验链）会破坏既有测试契约，复杂度反而更高；无新依赖/新文件
5. **pre-existing 失败声明**：无（全量套件 5546/5546 绿，不存在失败项）

## 影响面

- 行为面：仅影响「软代码 + created_at ≥ 2026-09-17 + 非豁免 + 缺整块 intent + 非 feature/prompt」文档的 lint 结果（warning → error）。全库存量零漂移（已实测）；在途 PR 若含此类文档会翻红——这正是收口目的（该类文档本就应声明 intent 块）。
- 不改 lint-intent.mjs 其他规则；不改豁免清单；不动既有测试。
