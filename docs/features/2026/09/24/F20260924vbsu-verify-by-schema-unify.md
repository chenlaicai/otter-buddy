---
title: verify_by schema 统一为 intent 嵌套式
id: F20260924vbsu
summary: 特性文档 verify_by 声明位置统一为 intent 块内嵌套式（唯一真相源），修复 lint-intent 对顶层式的校验盲区（#1158）；lint 加防再分叉校验（顶层 verify_by → error），3 个顶层式存量文档（mfrc/somf/icus）一次性迁回嵌套式。
intent:
  problem: "verify_by 声明存在 schema 双轨：intent 块内嵌套式（lint-intent.mjs 唯一消费与校验口径，全仓 94 个存量文档）vs frontmatter 顶层式（2026-09-17 后 mfrc/somf/icus 三个文档自创旁支，未被任何工具消费校验）。后果：lint 对 3 个顶层式文档的全部规则（VALID_VERIFY_BY_TYPES 类型枚举、expected_effect 可判定联动、golden_replay 执行核对）完全旁路；verify_by 声明率统计系统性失真；signal-registry 待启用的「intent.verify_by 覆盖率」健康信号同病。"
  why_now: "issue #1158（PR #1157 delta 复核职责外发现）；搭档 9/24 拍板：「统一就行……这是架构统一基本要求」，方向定为统一为嵌套式（嵌套式是 94 个存量的主流形态，lint/golden 核对/expected_effect 联动全部挂 intent 块；顶层式是无任何工具消费的自创旁支）。"
  expected_effect: "全仓 verify_by 声明位置单一（intent 块内）；lint 对所有软代码文档的 verify_by 校验无盲区；顶层 verify_by 出现即 lint error 防再分叉；mfrc 补 created_at 后落入 golden_replay 执行核对视野（本次验证段已跑 npm run test:capability 留痕）。"
  verify_by:
    type: capability_test
    note: "lint 逻辑改动：lint-intent.test.ts 新增防再分叉用例（顶层 verify_by → error）27 用例全绿；npm run lint:intent 全仓扫描 0 errors；3 个顶层式文档迁移后 frontmatter 解析正确。"
capability_test: "n/a: lint 规则改动（纯机械校验逻辑），无运行时行为变更；验证方式=lint-intent.test.ts 27 用例全绿 + npm run lint:intent 全仓 0 errors"
created_at: 2026-09-24
change_type: feature
tags: [lint, schema, verify_by, intent, observability, tech-debt]
modules: [scripts/lint-intent.mjs, tests/lint/lint-intent.test.ts, docs/features/2026/09/17/F20260917mfrc-memory-first-recall.md, docs/features/2026/09/23/F20260923icus-invoke-cache-usage.md, docs/features/2026/09/24/F20260924somf-small-otter-memory-first.md]
from: [F20260924somf]
supersedes: []
created_in_conversation: 156a6abc-1640-47c2-bba7-399e1ccf030f
---

# verify_by schema 统一为 intent 嵌套式

## 背景 [required]

issue #1158 报告 verify_by schema 双轨问题，但**前提需修正**：issue 说「顶层式是 mfrc/icus 先例」，摸底（2026-09-24）发现实际是：

- **嵌套式（intent 块内）94 个存量**——lint-intent.mjs 唯一消费与校验口径，全仓主流
- **顶层式（frontmatter 顶层）仅 3 个**——2026-09-17 后 mfrc/somf/icus 三个文档自创旁支，未被任何工具消费校验

lint-intent.mjs 的 validateIntent 只查 `intent.verify_by`（lint-intent.mjs:201），对 3 个顶层式文档是**校验盲区**：VALID_VERIFY_BY_TYPES 类型枚举、expected_effect 可判定联动（fuzzy words → error）、golden_replay 执行记录核对全部旁路。

## 方向取舍（搭档拍板） [required]

搭档 9/24 拍板原话：「ok，那我觉得统一就行吧，两个位置有什么优劣势，你分析下就行，但统一是必然的，这是架构统一基本要求」。

**统一方向：嵌套式**（技术域 L1 判断，理由）：

1. **嵌套式是全仓主流**：94 个存量 vs 顶层式 3 个自创旁支——统一方向选少数服从多数，迁移成本 3:94 悬殊
2. **lint 校验体系全挂 intent 块**：VALID_VERIFY_BY_TYPES、expected_effect 联动、golden 核对、时间界收口（created_at ≥ 2026-09-17）都挂在 `fm.intent.verify_by` 上——统一为嵌套式 = 回到设计轨道，统一为顶层式 = 整个校验体系重写
3. **feature-doc-collector.ts:107 的"顶层式"是误读**：`raw.verify_by` 实际读的是 `fm.intent.verify_by`（嵌套式），只是返回时展平字段名，并非消费顶层式
4. **顶层式无任何工具消费**：lint 不查、collector 读不到、signal-registry 无对应——是纯粹的 schema 旁支

**被否路径**：统一为顶层式（迁移 94 个存量，lint/collector 全部改读顶层，2 个 golden_replay 嵌套式文档会落入时间界触发核对，体量约为嵌套式方向的 30 倍且无收益增量）。

## 改动 [required]

1. **lint-intent.mjs**：validateIntent 开头加防再分叉校验——`fm.verify_by !== undefined` → error「frontmatter 顶层 verify_by 是非法位置（schema 已统一为 intent 块内嵌套式，见 #1158/F20260924vbsu）——请把 verify_by 移入 intent 块内」
2. **lint-intent.test.ts**：新增防再分叉测试用例（顶层 verify_by 触发 error）
3. **3 个顶层式存量文档一次性迁回嵌套式**：
   - **mfrc**（F20260917mfrc）：verify_by 从顶层移入 intent 块内；补 `created_at: 2026-09-17`（落入 golden_replay 执行核对视野，本次已跑 npm run test:capability 留痕）；expected_effect 从「显著提升」改为「升至少 2 个百分点以上」（消除 fuzzy word「显著」以通过 golden_replay 可判定联动校验）
   - **somf**（F20260924somf）：verify_by 从顶层移入 intent 块内（human_judge，无 created_at 不受影响）
   - **icus**（F20260923icus）：verify_by 从顶层移入 intent 块内（static_only，无 created_at 不受影响）

## 机制新增四问（Modification-Class: mechanism-addition）

1. **谁需要**：所有新特性文档作者（人 + 獭）——lint 是 commit-time gate，任何顶层 verify_by 写法都会被拦截指回嵌套式
2. **失败后果**：lint 失败时 commit 被阻断（husky pre-commit），作者按错误消息把 verify_by 移入 intent 块即可，无系统级故障面
3. **后续机制**：无——本改动本身就是防再分叉的收口机制；若未来 schema 需演进（如 verify_by 独立于 intent），应先改 lint 单一真相源再迁文档
4. **退役条件**：verify_by 字段本身废止，或 frontmatter schema 整体重构（届时本校验随 schema 演进自然消亡）

## 验证

- `npm run lint:intent`：全仓扫描 0 errors（3 个顶层式文档迁移后解析正确，防再分叉校验对存量无误伤）
- `npx vitest run tests/lint/lint-intent.test.ts`：27 用例全绿（含新增防再分叉用例）
- mfrc 补 created_at 后落入 golden_replay 执行核对：`npm run test:capability` 已跑（golden 场景 mfrc-first-response 采样多次 3/3 全过，见 PR #1157 delta 复核记录）
- 效果观测：lint-intent 统计输出「verify_by 率（分母=有 intent 的文档）」从失真的 0/1（顶层式不被识别）恢复为真实值
