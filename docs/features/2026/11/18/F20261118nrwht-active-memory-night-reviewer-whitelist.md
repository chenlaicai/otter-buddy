---
id: F20261118nrwht
title: night-reviewer 受限写者獭白名单（P2a：belief 三迁移工具重建）
doc_type: feature
summary: |
  「主动记忆层」P2 的第一刀（受限写者獭档案）。P1c 依 k3 审视把 belief_verify/reject/supersede
  撤出默认注册（任何 agent 可自我核实会掏空独立核实信任模型），本刀以「night-reviewer」档案
  重建三迁移工具：白名单恒为 speak/yield + 三迁移工具（不带编码/管理工具）；big（"*" 全放行）
  与 small（memory 组）经 BELIEF_MIGRATION_TOOLS 排除集兜底剔除；otter_configs.otter_type CHECK
  扩展 'night-reviewer'，让受限档案可落库（P2b 夜间审视獭召唤的前提）。
change_type: feature
intent:
  problem: "P1c 收口后，belief 状态迁移（verify→verified / reject→disputed / supersede→superseded）只有 usecase 没有工具——任何 agent 拿不到迁移权，夜间审视獭也没有诞生条件；且 otter_configs.otter_type 仍只有 big/small 两型，night-reviewer 档案无法落库。"
  expected_effect: "night-reviewer 型獭的工具清单有且仅有 speak/yield + belief_verify/belief_reject/belief_supersede 五件；big/small 獭清单里绝不出现三迁移工具（防止普通 agent 自我核实）；otter_configs 可存 night-reviewer 类型。record_belief 照旧对 big/small 开放（现场记录不变）。"
  verify_by:
    type: behavior_check
    note: "单测钉住：getOtterToolNamesForType('night-reviewer') 恒 5 工具（fallback 与 manifest 两路径）；big（'*' 展开后）与 small 白名单剔除三迁移工具；getCodingToolsForOtterType('night-reviewer') 为空；otter_configs 迁移测试（窄 CHECK 存量库重建后可插 night-reviewer、非法类型仍拒、幂等）；lint:tool-manifest 通过（night-reviewer 类型与 DB CHECK 一致）。"
capability_test: "n/a: 本刀是工具白名单路由 + 档案落库，行为门禁为新增单测（whitelist/编码工具 5 项 + 迁移测试 2 项）+ lint:tool-manifest；非 belief 路径零行为变更。"
created_at: 2026-11-18
created_in_conversation: 82f71e1a-a8b0-4e0f-916e-5e219624483c
causal_links:
  from: [F20261118bltls]
tags: [memory, belief, active-memory, night-review, tool-whitelist, restricted-writer]
modules:
  - src/interface-adapters/agent-runtime/tools/tool-factory.ts
  - src/frameworks/agent/session-helpers.ts
  - config/tool-manifest.json
  - src/frameworks/db/migration.ts
  - tests/frameworks/agent/coding-tools.test.ts
  - tests/frameworks/db/otter-configs-type-check-migration.test.ts
---

# night-reviewer 受限写者獭白名单（F20261118nrwht）

> **定位**：P2「夜间审视」的第一刀（受限写者獭档案），承接 P1c（F20261118bltls，belief 工具面）留下的收口缺口。

## 背景

P1c 二轮审视（k3 + glm）收口后，`belief_verify` / `belief_reject` / `belief_supersede` 三迁移工具被撤出 `createTools` 默认注册与 manifest——理由是「任何 agent 可自我核实会掏空独立核实信任模型」：verified 必须来自独立审视，不能让记录者自己给自己盖章。

本刀把迁移权重新放回系统，但只放给一个**受限写者獭档案** `night-reviewer`：白名单恒为 `speak/yield + 三迁移工具`，不带 read/write/edit/bash 等编码工具、不带任何管理/编排工具。

## 方案

### 1. 三迁移工具重建（tool-factory.ts）

按 P1c 历史逻辑恢复 `buildBeliefMigrationTool` + `createVerify/Reject/SupersedeBeliefTool`，并重新并入 `createBeliefTools`（4 件：record + verify + reject + supersede）：

- `belief_verify`：`transitionBelief({ entryId, to: "verified" })`
- `belief_reject`：`transitionBelief({ entryId, to: "disputed" })`
- `belief_supersede`：`markBeliefExpired(entryId)`（旧条目迁 superseded，不建边、不删）

### 2. 白名单排除集（session-helpers.ts）

新增 `BELIEF_MIGRATION_TOOLS = ["belief_verify", "belief_reject", "belief_supersede"]` 常量：

- `getOtterToolNamesForType` 对 `night-reviewer` **早返**恒 5 工具（不依赖 manifest defaultType fallback——manifest 缺该类型时 `getToolNamesFromManifest` 会退到 big 的 `"*"` 全集，fail-open）。
- 其余类型（big/small/undefined/未知）经 `stripBeliefMigrationTools` 无条件剔除三迁移工具。
- `getCodingToolsForOtterType("night-reviewer")` 返回 `[]`——只审不写码。

### 3. manifest 档案（tool-manifest.json）

新增 `night-reviewer` 类型，显式枚举 5 工具（不走 `"*"`，也不引用 capabilityBlocks）。

### 4. 档案落库（migration.ts）

`otter_configs.otter_type` 的 CHECK 约束从 `('big', 'small')` 扩展为 `('big', 'small', 'night-reviewer')`。SQLite 无法修改 CHECK 约束，按既有 `rebuildAttachmentsKindCheck` 模式做存量表重建（叶子配置表，无入边 FK / 无索引，事务内 DROP+RENAME 即可）；新库直接建宽约束表，重建检测旧文本不命中即跳过。

## 验收

- `getOtterToolNamesForType("night-reviewer", ...)` 有且仅有 5 工具（fallback 与 manifest 两路径一致）。
- big（`"*"` 展开后）与 small 白名单均不含三迁移工具。
- `getCodingToolsForOtterType("night-reviewer")` 为空。
- 老库窄 CHECK 存量表迁移后可插 `night-reviewer`，非法类型仍拒，重复迁移幂等。
- `lint:tool-manifest` 通过（night-reviewer 类型与 DB CHECK 一致）。

## 后续（P2b 依赖）

- 夜间审视獭的实际创建（`create-otter` 传 `type: "night-reviewer"`）与调度编排。
- `consolidation_state`（failed_range 区间 + failures + 幂等键）+ #814 迟到补跑对账。
- 三迁移工具的「出处 ID 存在且在当日快照范围内」校验（快照范围由夜审任务 prompt 注入）。
- fyi 否决锚（搭档一句话打回 → matter/transition 迁 disputed）。