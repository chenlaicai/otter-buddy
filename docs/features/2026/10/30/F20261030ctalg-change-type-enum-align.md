---
id: F20261030ctalg
title: "change_type 枚举漂移收口：lint-intent 分类与真相源对齐（#1295）"
summary: "复测现状：feature_update 蛇形已消，但 lint-intent 分类集合（bugfix/refactor）与 known-values.ts 真相源（fix/feature-update）分裂——fix 392 篇、feature-update 37 篇不在任何集合，缺 intent 块完全静默。修复：RECOMMENDED 对齐真相源 + 历史拼写别名归一（文案保留原拼写）+ isNewEnough 无前导零日期边缘修复（F20261030iprio 预留项）；存量残值（bugfix×1/tests×2）取 issue 修法方向的 ratchet 冻结路线。"
change_type: fix
capability_test: "tests/lint/lint-intent.test.ts"
created_in_conversation: a9260c50-cef6-412e-a0b4-282287a13103
created_at: "2026-10-30"
intent:
  problem: "change_type 枚举漂移致校验口径与实际存量分裂：lint-intent 的分类集合只认 feature/prompt/bugfix/refactor，真相源值 fix（392 篇）与 feature-update（37 篇）缺 intent 块时 0 error 0 warning 完全静默；bugfix/feature_update 历史拼写双轨并存；isNewEnough 字符串日期比较对无前导零日期（如 2026-9-1）误判为新（F20261030iprio 检视 r1 观察 2 预留）。"
  expected_effect: "非软代码 fix/feature-update 缺整块 intent 时出 Recommended warning（静默面关闭）；bugfix/feature_update 历史拼写按别名归一分类（文案保留原拼写）；tests（test-only）维持静默；无前导零日期按真实日期序判定；全库 error 集合零漂移、exit 0。"
  verify_by:
    type: capability_test
    description: "tests/lint/lint-intent.test.ts 新增 8 用例（5 红测锁修复 + 3 现状锁）+ 全量 5554 测试绿 + 全库 lint error 零漂移实测"
tags: [lint, intent, change-type, enum, drift]
modules: [scripts/lint-intent.mjs, tests/lint/lint-intent.test.ts]
from: [F20261030iprio, F20260917sdpl]
supersedes: []
causal_links:
  - issue #1295（PR #1283 检视职责外发现：bugfix/fix 双轨与 feature_update/feature-update 并存）
  - F20261030iprio 检视 r1 观察 2 预留项（isNewEnough 无前导零日期边缘，本篇一并收口）
  - F20260917sdpl 软代码 verify_by 收口（isNewEnough 出处，本篇只修日期解析边缘不动时间界语义）
---

# change_type 枚举漂移收口：lint-intent 分类与真相源对齐

## 背景（复测现状，2026-10-30 实测）

issue #1295（10-05 前开单）标注「旧拼法可能已被统一，开单前请先复测」。复测结论：

| 项 | 现状 | 数据 |
|---|---|---|
| feature_update（蛇形） | **已消** | 0 篇残留 |
| bugfix（旧拼写） | 残留 1 篇 | F20261020lmld（lint:docs warning） |
| tests（真相源外值） | 残留 2 篇 | F20261023imts、F20261022fgbt（lint:docs warning） |
| lint:docs Unknown warning | 3 个顶格（ratchet 上限） | 由上述 3 篇产生 |
| **lint-intent 分类分裂（核心问题）** | **仍在** | RECOMMENDED={bugfix,refactor} vs 真相源 {fix,refactor,feature-update}——fix 392 篇 + feature-update 37 篇缺块完全静默 |

issue 三条修法方向的处置：①复测现状（本节）✓；②lint-intent 集合与真相源对齐（本篇主体）✓；③存量残值批量订正或 ratchet 冻结 → **取 ratchet 冻结**（见设计取舍）。

## 根因

1. `scripts/lint-intent.mjs` 分类集合是孤立的本地定义，与 `src/entities/document/known-values.ts` 真相源（KNOWN_CHANGE_TYPES）无对齐机制——真相源演进（fix/feature-update 收编）后 lint-intent 集合没跟上，主力修复值 `fix` 反而掉出全部分类，惩罚梯度问题的「静默面」（F20261030iprio 检视 r1 观察 1）由此而来。
2. `isNewEnough`（F20260917sdpl）用裸字符串比较日期，无前导零日期（`2026-9-1`）因 `'9'>'0'` 误判为新。

## 修复

1. **RECOMMENDED 集合对齐真相源**：`{bugfix, refactor}` → `{fix, refactor, feature-update}`。
2. **历史拼写别名归一**（`LEGACY_CHANGE_TYPE_ALIAS`）：`bugfix→fix`、`feature_update→feature-update`——**分类用归一值，文案用原拼写**（作者看到自己写的值，对照不迷路）。
3. **isNewEnough 零填充归一**：日期前缀 `\d{4}-\d{1,2}-\d{1,2}` 归一化零填充后比较；不可解析格式按存量宽容（不追诉）。
4. `tests`（test-only 文档）不进任何分类——测试类变更不需要 intent 声明，缺块维持静默（决策锁定）。

## 设计取舍

- **机制判定**：修法决策树①既有语义内修（分类集合本来就是这套语义，只是没对齐真相源）+ ③边缘函数修复，七项清单全未命中，Modification-Class: `narrow-fix`。
- **feature-update 不升 REQUIRED（只进 RECOMMENDED）**：实测 34/37 篇 feature-update 存量缺块——升 REQUIRED 会立即翻红 CI（缺块 error 不看日期，非豁免即 error）；RECOMMENDED 级 warning 已关闭静默面，追诉由软代码新分支（F20261030iprio）管。
- **存量残值取 ratchet 冻结（issue 修法方向③的第二选项）**：bugfix×1/tests×2 三篇是已合入历史文档——**历史不可变铁律**（正文禁改，勘误走新文档）使「批量订正」不可行；把历史拼写收编进 KNOWN_CHANGE_TYPES 会污染数据层 ChangeType union（feature-mapper 直接落库）。故 lint:docs 的 3 个 Unknown warning 维持冻结（ratchet 上限即现状），lint-intent 侧用别名归一兼容读取——校验口径统一，存量拼写留在文档里作为历史事实。
- **isNewEnough 不可解析日期按存量宽容**：收口语义只追诉「可证实的新文档」（created_at 缺失即不追诉的既有口径延伸）；格式错误归 lint:docs 诊断，不在时间界判定里造 error。
- **已排除路径**：lint-intent 集合改为 import known-values（跨层依赖 scripts→src 构建产物，lint 脚本须在 build 前可用，会引入 dist 依赖循环）；frontmatter-validator/mapper 做别名归一（动数据层写入语义，爆炸半径大且非本 issue 诉求）。

## 验收标准

| 场景 | 操作 | 预期结果 |
|------|------|----------|
| 非软代码 fix 缺整块 | validateIntent，change_type=fix，modules 含 src/ | 0 errors + `Recommended intent field for fix` warning（此前完全静默） |
| 非软代码 feature-update 缺整块 | change_type=feature-update | 0 errors + `Recommended intent field for feature-update` warning |
| bugfix 历史拼写缺块 | change_type=bugfix | warning 文案 `Recommended intent field for bugfix`（归一分类、原拼写文案） |
| feature_update 蛇形拼写缺块 | change_type=feature_update | warning 文案保留 `feature_update` 原拼写 |
| tests 值缺块 | change_type=tests | 0 errors 0 warnings（决策锁定） |
| 无前导零旧日期 | created_at=2026-9-1，软代码缺 verify_by | warning 不 error（修复前误判新 → error） |
| 无前导零新日期 | created_at=2026-9-20，软代码缺 verify_by | error（归一化后仍判新，不误放） |
| 不可解析日期 | created_at=garbage-date，软代码缺 verify_by | warning 不 error（存量宽容） |
| 全库行为 | node scripts/lint-intent.mjs 前后对比 | error 集合零漂移、exit 0；warning +319（静默面关闭的设计效果） |

前八行为 tests/lint/lint-intent.test.ts 机械断言（`npx vitest run tests/lint/lint-intent.test.ts`）；末行为全库行为断言。

## Verification

1. **失败用例证据（bugfix 硬规则）**：
   - 修复前（stash 实现、base 代码跑新测试）：**5 failed | 54 passed**——红测 A/B/D/F/H 红（静默面 ×2、蛇形别名、无前导零误判、不可解析误判），C/E/G 三现状锁在 base 即绿（锁既有行为不回退）
   - 修复后：**59 passed (59)** 全绿
2. **全量零回归**：`npx vitest run` → 420 files / 5554 tests 全过
3. **全库行为断言**：`node scripts/lint-intent.mjs` base vs after——error 数 0→0（零漂移）、exit 0→0；warning 311→630（+319，静默面关闭的设计效果：fix/feature-update/别名缺块从无声变 warning）
4. **最简实现检查**：已过——集合 2 行 + 别名表 + 分类引用替换（5 处 has()）+ 日期归一 5 行；无新依赖/新文件；lint:docs/数据层零改动（ratchet 冻结路线）
5. **pre-existing 失败声明**：无（全量套件 5554/5554 绿）

## 影响面

- 行为面：①非软代码 fix/feature-update/历史拼写缺块 → 新增 warning（exit 码不变，不阻断）；②intent 块内缺 problem 的 fix/feature-update 文档同理新增 warning；③无前导零/不可解析日期的软代码文档时间界判定收紧到真实日期序。全库 error 零漂移、CI 闸面不动。
- lint:docs 侧零改动（3 个 Unknown warning 冻结顶格）；数据层（known-values/feature-mapper）零改动。
- 在途 PR 影响：含 fix/feature-update 缺块文档的 PR 会多 warning 不红，无破坏面。
