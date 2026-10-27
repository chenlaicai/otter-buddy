---
id: F20261027mreg
title: register_matter / matter_sweep 登记 tool-manifest orchestration block（#1349）
summary: 两工具此前仅靠 big="*" 通配成立（任何 capabilityBlock 未登记）——声明债：big 改显式枚举时会静默丢失。登记入 orchestration block（仅 big 型可用面，small 的 groups 不引用），声明现状语义零权限变化。
doc_type: feature
change_type: fix
capability_test: "jest tests/frameworks/config/tool-manifest-loader.test.ts（manifest 加载与 block 校验路径）+ JSON 合法性 + small 型展开不含两工具的断言"
created_in_conversation: 3241317b-99d6-4d78-9248-ff208a7461bc
causal_links:
  - "#1349（立案：matter_sweep/register_matter 未登记，big 通配成立但声明债）"
  - "F20261008mlp3（matter_sweep 引入——P3 新增跨对话停滞扫描）"
  - "F20261006mlp2（register_matter 引入——通道 B 登记）"
tags: [tool-manifest, matters, config]
modules: [tool-manifest]
created_at: 2026-10-27
intent:
  problem: matter 域两工具（register_matter/matter_sweep）在任何 capabilityBlock 未登记（8 block 全查），big 型仅靠 tools="*" 通配成立——声明债：未来 big 从 "*" 改显式枚举时两工具静默丢失
  solution: 登记入 orchestration block（描述「仅 big 型引用，small 不得持有」，与两工具权限语义匹配）；不放 system block（被 small groups 引用，放入即实际扩权）——声明现状语义，零权限变化
  verify_by:
    type: static_only
---

# register_matter / matter_sweep 登记 orchestration block（#1349）

## 背景与独立核实

#1349（来源 #1341 建议9）指出 matter_sweep / register_matter 未登记 config/tool-manifest.json。10-27 实查确认：

- **两工具在任何 capabilityBlock 均未出现**（8 个 block 全查：system 只含 list_matters/transition_matter）
- big 型 `tools: "*"` 通配展开自动包含全部注册工具 → 权限现状成立
- **fallback 路径（manifest 加载失败）同为 big 全量**（session-helpers.ts getOtterToolNamesForType）→ 双路径 big 均可用，无静默丢失的现役风险
- small 型：manifest groups（memory/conversation/context/terminology/artifacts/system/workspace）+ fallback 白名单均不含两工具 → **现状 small 本就不可达**

## 修复决策（L1）

**登记入 orchestration block**，理由：

1. `orchestration` block 描述「编排/裁决工具——仅 big 型引用，small 不得持有」，与两工具的权限语义完全匹配：
   - matter_sweep：跨对话查询权，与编排权对齐（F20261008mlp3 设计定调「仅 big 型注册」）
   - register_matter：通道 B 登记入口（源码注释「small/big 型均可用」仅指工具注册层，usecase 层无 otter 限制；但现役两路径 small 白名单均未含——登记入 big-only block 是**声明现状**而非变更）
2. **不能放 system block**：system 被 small 的 groups 引用，加入会实际扩权小獭（改变现有语义）
3. 消除声明债：未来 big 从 "*" 改显式枚举时，orchestration block 被 big 引用即可，不再静默丢失

**零权限变化论证**：small 展开（groups 不含 orchestration）→ 两工具仍不可达；big "*" 通配 → 仍全量。变更仅使 manifest 声明与运行时权限现状对齐。

## 变更

config/tool-manifest.json orchestration block tools 追加 `register_matter`、`matter_sweep`（+2 行；文件尾补换行符）。

## 验证

- Golden Gate: n/a（verify_by=static_only——纯声明配置变更，无场景可跑）
- JSON 合法性 ✓（json.load 通过）
- manifest 加载与 block 校验：`npx vitest run tests/frameworks/config/tool-manifest-loader.test.ts` **39/39 绿**（检视处置订正：原文误写 npx jest，项目测试框架为 vitest）
- small 型不含两工具：生产路径断言（tests/frameworks/agent/coding-tools.test.ts，真实 manifest 同构面）补 `not.toContain(register_matter/matter_sweep)` 两行；「零权限变化」结论另经 manifest 数据独立核验（检视琭三方验证成立）

## 关联

- #1349 关闭；#1341 建议9 兑现
- 若未来 small 型需要 register_matter（板上「+」回执退派场景），需另开 issue 决策（本变更不动 small 面）
