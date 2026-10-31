---
id: F20261031cttrm
title: "change_type 空白串 trim 口径对齐（#1293）"
summary: "change_type 空白串（' '）此前把 length>0 当有效值但不在任何分类集合，缺块完全静默，拦截依赖 lint:docs Unknown warning + baseline 恰好满载（3=cap）的巧合；与 intent.problem 的 .trim() 判空口径不一致。修复：trim 后为空按缺失处理（fallback feature 必填口径），带空格值 trim 归位参与分类。"
change_type: fix
capability_test: "tests/lint/lint-intent.test.ts"
created_in_conversation: a9260c50-cef6-412e-a0b4-282287a13103
created_at: "2026-10-31"
intent:
  problem: "lint-intent 的 change_type 判定用 length>0 不 trim：空白串（' '）被当有效值却不在任何分类集合（缺块静默），' fix '（带空格）同样掉出分类——拦截实际依赖 lint:docs Unknown warning + baseline 满载的巧合（baseline 降到 ≤2 就只剩 warning 不阻断）；与同文件 intent.problem 分支的 .trim().length===0 判空口径不一致（#1293）。"
  expected_effect: "change_type trim 后为空（' '/'   '）按缺失处理走 fallback feature 必填口径（error 点名「change_type 缺失/空值按 feature 判定」）；带空格值（' fix '/' bugfix '）trim 归位参与分类与别名归一；空串既有契约不变；全库 lint 输出逐字节零漂移。"
  verify_by:
    type: capability_test
    description: "tests/lint/lint-intent.test.ts 新增 4 用例（2 红测锁修复 + 1 别名+trim 组合锁 + 1 空串现状锁）+ 全量 5561 测试绿 + 全库 lint 输出与 base 逐字节一致"
tags: [lint, intent, change-type, trim]
modules: [scripts/lint-intent.mjs, tests/lint/lint-intent.test.ts]
from: [F20261030ctalg]
supersedes: []
causal_links:
  - issue #1293（PR #1290 轻量 delta 检视建议发现 1 派生：change_type 空白串 trim 口径未对齐）
  - F20261030ctalg change_type 枚举漂移收口（同域前作，本篇补 trim 维度）
---

# change_type 空白串 trim 口径对齐

## 背景

issue #1293（PR #1290 检视建议发现 1）：`change_type: " "`（空白串）当前把 `length>0` 当有效值，但 `" "` 不在任何分类集合——缺 intent 块时完全静默。唯一拦截来自 lint:docs 的 `Unknown change_type` warning **恰好顶满 baseline ratchet（3=cap）** 才 EXIT=1——baseline 降到 ≤2 就只剩 warning 不阻断，拦截能力随 baseline 浮动（巧合依赖，不是设计）。

内部口径也不一致：同文件 `intent.problem` 分支用 `.trim().length===0` 判空（trim 语义），change_type 侧只 `length>0`（不 trim）。

## 根因

`scripts/lint-intent.mjs` 的 `isStringChangeType` 判定：`typeof === "string" && length > 0`——不 trim，空白串与带空格值（`' fix '`）穿透为「有效值」后掉出所有分类集合。

## 修复

一行口径对齐（issue 修法原文）：

```
trimmedChangeType = typeof fm.change_type === "string" ? fm.change_type.trim() : ""
isStringChangeType = trimmedChangeType.length > 0
effectiveChangeType = isStringChangeType ? trimmedChangeType : FALLBACK_CHANGE_TYPE
```

- trim 后为空 → 按缺失处理（fallback feature 必填口径，与空串同路径）
- 带空格值 → trim 归位参与分类与 #1295 的别名归一，消息用 trim 后值

## 设计取舍

- **机制判定**：修法决策树①既有语义内修（与 intent.problem 的 trim 判空同口径），七项清单全未命中，Modification-Class: `narrow-fix`。
- **不动 lint:docs 侧**：issue 修法明确只改 lint-intent.mjs（一行 trim）；lint:docs 的 Unknown warning 与 baseline ratchet 机制不属本 issue 修面。
- **消息用 trim 后值**：`' fix '` 的文案显示 `fix`——作者对照 YAML 原文时多一个空格不构成歧义，trim 后值才是分类真相。

## 验收标准

| 场景 | 操作 | 预期结果 |
|------|------|----------|
| 纯空白串缺块 | change_type='   '，非软代码，缺整块 intent | error「change_type 缺失/空值按 feature 判定」（修复前完全静默） |
| 带空格 fix 缺块 | change_type='  fix  '，非软代码，缺整块 | warning「Recommended intent field for fix」（trim 归位分类） |
| 带空格 bugfix | change_type=' bugfix '，缺整块 | warning 文案「Recommended intent field for bugfix」（trim+别名归一，文案 trim 后原拼写） |
| 空串现状锁 | change_type=''，缺整块 | error「change_type 缺失/空值按 feature 判定」（既有 severity-2 契约不动） |
| 全库零漂移 | node scripts/lint-intent.mjs base vs after | 输出逐字节一致（repo 无空白串存量），exit 0 |

前四行为 tests/lint/lint-intent.test.ts 机械断言；末行为全库行为断言。

## Verification

1. **失败用例证据（bugfix 硬规则）**：
   - 修复前（base 代码跑新测试）：**3 failed | 63 passed**——红测 A/B + 别名组合 C 红（空白串/带空格值静默），空串现状锁 D 绿
   - 修复后：**66 passed (66)** 全绿
2. **全量零回归**：`npx vitest run` → 420 files / 5561 tests 全过
3. **全库零漂移**：`node scripts/lint-intent.mjs` base vs after 输出**逐字节一致**（repo 无空白串存量，纯口径对齐），exit 0
4. **最简实现检查**：已过——3 行判定重写（issue 修法原文即一行 trim）；无新依赖/新文件
5. **pre-existing 失败声明**：无（5561/5561 绿）

## 影响面

- 行为面：仅 change_type 为纯空白串/带空格值的文档（repo 存量为零，实测零漂移）——空白串从静默变按缺失 error，带空格值从掉出分类变正常分类。
- 不改 lint:docs/baseline ratchet；不动空串与非字符串的既有口径（与 F20261030ctalg 别名归一正交叠加）。
