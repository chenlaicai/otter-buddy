---
id: F20261031ctuny
title: change_type 归一化下沉 known-values 单源入口（trim+别名），修复跨闸口径分裂
summary: |
  issue #1718（源自 PR #1717 检视建议）：#1293（lint-intent trim）与 #1295（别名归一）
  连续侵蚀后，known-values.ts 自称的「单一真相源」实际只覆盖 lint-intent 侧——
  `' fix '` 在 lint-intent 判合法、frontmatter-validator 仍精确匹配报 Unknown。本 PR
  把归一逻辑（trim + bugfix/feature_update 别名）下沉进 known-values 单一入口
  normalizeChangeType，validator/sync/mapper 全链路共用；两个 mapper 落库改用归一值
  （判合法后存规范值，DB 不进脏值）。lint:docs 基线 3→2 warning（bugfix 存量别名
  不再 Unknown），观察 1（tests 型）按 issue 明确维持现状。
change_type: fix
capability_test: "n/a: fix 类（枚举归一口径修复，不涉能力面）——回归由 tests/entities/document/known-values-change-type.test.ts 6 条承担（红测基线 4 红 2 绿）"
created_in_conversation: 12967086-9ce5-4cf8-8343-ce4b0fd31519
created_at: 2026-10-31
causal_links:
  - F20260803mval
  - F20261030ctalg
  - F20261031cttrm
---

## 背景

known-values.ts 头注释声称「文档枚举值单一真相源——加新值只改这里一处，全链路同步」，
但 #1293（lint-intent 加 trim）与 #1295（lint-intent 加别名归一）的修法都只动了
lint-intent 侧：同一文档 `' fix '` 在 lint-intent 判 fix 正常分类，在
frontmatter-validator（经 known-values 的 isKnownChangeType 精确匹配）报
`Unknown change_type`——作者看到矛盾信号，真相源承诺打折（issue #1718 问题 1）。

## 变更内容

### 归一化下沉单源入口（known-values.ts）

新增 `normalizeChangeType(value)`：trim + 历史拼写别名（bugfix→fix /
feature_update→feature-update，与 lint-intent #1295 的 LEGACY_CHANGE_TYPE_ALIAS 对齐）；
`isKnownChangeType` 改为归一后判定——`' fix '`/`'bugfix'`/`' bugfix '`（组合形态）
均判合法。单点实现，validator/sync/mapper 全链路自动一致。

### 落库读路径归一（sync-documents.ts 写路径 / feature-mapper.ts 读路径）

写路径（sync-documents）判合法后落 `normalizeChangeType(ct)`；读路径
（feature-mapper rowToEntity，DB→entity）同归一。原实现从不存原值——未知值走
fallback `"feature"` 兜底（两处三元），本变更的真实行为变化：**存量 fallback 错值
翻正**——如 F20261020lmld（bugfix）DB 值将从 fallback "feature" 翻正为 "fix"
（featureFingerprint 含 changeType，下次同步触发 update）。

### 观察 1（内部空白值 `"fix bug"`）维持现状

issue 明确「待一并评估」：本 PR 维持不归一（normalizeChangeType 不动内部空白）、
两闸一致判不合法、lint:docs warning 兜底——收紧行为（error 化）需独立决策，不搭车。

## 设计取舍

- **下沉而非复制**：修法方向二选一（真相源侧对齐 vs 归一下沉单源），选下沉——
  归一逻辑单点后两闸永久同步，复制口径会再造下一个 #1718。
- **别名表内联**：LEGACY_ALIAS 定义在 normalizeChangeType 函数体内（两键小表），
  不提模块级常量——避免「常量又成一个需要对齐的源」的原病复发。
- **历史文档不可变铁律**：口径放宽（bugfix 不再 Unknown）不追诉任何存量——
  lint:docs ratchet 3→2 只减不增方向，无文档需要改。
- **机制识别**：无新机制（枚举归一逻辑迁移位置），Modification-Class: narrow-fix。

## 验证

### 失败证据（红测基线）

新测试 6 条跑在 base 代码（stash 修改）：**4 failed | 2 passed**——trim 归一/别名/
组合/归一输出四条红（base 无 normalizeChangeType），现状锁两条绿（tests 型不合法、
未知值不合法）。修复后 **6/6**。

### 验收标准（机械断言）

| 场景 | 操作 | 预期结果 |
|---|---|---|
| trim 归一（validator 侧收口） | vitest known-values-change-type `' fix '` 判 true | 过；lint-intent 侧对 `' fix '` 当前静默跳过（无 trim），识别随 #1717 对齐——两闸信号无矛盾（issue 验收达成），「同判定」待 #1717 |
| 别名归一 | `'bugfix'`/`'feature_update'` 判 true | 过 |
| 组合形态 | `' bugfix '` 判 true | 过 |
| 落库规范值 | normalizeChangeType 输出 fix/feature-update | 过 |
| 存量零漂移 | lint:docs base vs fixed | 3→2 warning（bugfix 存量 F20261020lmld 不再 Unknown，tests 型 2 条维持——issue 观察 1 现状） |
| 全链路零回归 | npx vitest run | 422 文件 / 5589 passed |
| 别名表跨源一致守卫 | vitest known-values-change-type（同步断言） | lint-intent 导出表与 normalizeChangeType 别名面一致，漂移即红 |

### 负向自查

- 放宽面：bugfix/feature_update/带空格值从「validator Unknown」变「合法」——
  与 lint-intent 侧既有口径一致化，不是新放宽（lint-intent 已先放宽，本 PR 补齐
  另一闸）；落库路径真实行为变化是存量 fallback 错值翻正（见「变更内容」节——
  原实现未知值兜底 "feature"，从不存原值；现状库无脏值存量——
  base lint:docs 只有 3 warning 全部是文档 frontmatter 层，无入库脏值场景）。
- tests 型（F20261022fgbt/F20261023imts）维持 Unknown warning——不收编不改文档。

## 影响面当场自检

- F20260803mval 的「单一真相源」声明部分兑现：归一入口在 known-values 内，validator/
  sync/mapper 全链路共用；lint-intent 侧因 .mjs 无法 import TS 物理分表——跨表一致性
  由守卫测试锁定（单源承诺如实口径见上「设计取舍」节）；
  #1295 的 LEGACY_CHANGE_TYPE_ALIAS（lint-intent 内）与本次下沉的关系：lint-intent
  侧表仍在其分类逻辑内使用（消息文案保留原拼写），语义一致不冲突；后续若再动
  枚举口径，known-values 与 lint-intent.mjs 两处须同步改（守卫测试兜一致性）。
- #1717（#1293 trim，lint-intent 侧）合入后与本 PR 无冲突（不同文件）；若 #1717
  先合入，本分支 rebase 无冲突面。
