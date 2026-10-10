---
id: F20261009dd39
title: "search_memory drillDown 提示与 get_memory_detail schema 对齐：params {id}→{ids:[id]}（#1398）"
summary: "search_memory 返回的 drillDown 提示写 params:{id} 单数形态，get_memory_detail 工具 schema 要求 ids 数组——照提示调用直接 schema 校验失败。修法：产出侧改与 schema 对齐（ids 数组），配回归测试锁形态。产出侧 3 处注入点 + 1 处类型注释统一修改，无消费侧影响（检视确认无代码消费 drillDown.params）。"
change_type: fix
intent:
  problem: "search_memory 渐进式披露的 drillDown 提示参数形态（{id} 单数）与 get_memory_detail schema（ids 数组必填）不匹配，LLM 按提示构造调用会 schema 校验失败——指引性提示把调用方引向确定性失败"
  expected_effect: "drillDown 提示参数形态 = 目标工具 schema 形态，照提示调用一次成功"
  verify_by:
    type: behavior_check
    description: "回归测试锚定产出契约：非 full 模式所有 drillDown.params 必须含 ids 数组且不含 id 单数键——修复前实测红（stash 回退验证）、修复后绿"
created_in_conversation: d7377cfd-8497-4338-9fb5-366967ffe87e
causal_links:
  - "F20260811mrpy"
modules:
  - src/usecases/memory/search-memory.ts
  - tests/usecases/memory/search-memory.test.ts
tags:
  - bug
  - memory
  - tool-contract
created_at: "2026-10-09T18:00:00+08:00"
---

## 1. 问题现象

#1398：search_memory 返回条目的 `drillDown` 提示形如 `{ tool: "get_memory_detail", params: { id } }`（单数），而 get_memory_detail 工具 schema 要求 `ids: string[]`（数组必填，tool-factory.ts:1141 required:["ids"]）。LLM 按 drillDown 提示原样构造调用 → schema 校验失败。

## 2. 根因

F20260811mrpy（渐进式披露）引入 drillDown 时 get_memory_detail 还是单 id 形态（或同期改造未同步提示侧）；get_memory_detail 后来支持批量改 ids 数组（见 tool-factory.ts:1127 注释「支持批量」），drillDown 产出侧未跟进——**工具契约演进，指引性提示滞留旧形态**。测试零覆盖 drillDown 形态（grep 确认），bug 无哨兵存活至今。

## 3. 修复方案

产出侧对齐 schema（不改 schema——数组形态是批量能力的正确设计）：

- `search-memory.ts` 三处产出点统一 `params: { ids: [entryId] }`：
  1. :591 主检索路径 drillDown 注入
  2. :317 context-expand 邻域条目录入
  3. :270 anchor 短路路径
- :102 接口注释「形如」同步更新
- 回归测试：非 full 模式所有 drillDown.params 含 ids 数组且不含 id 键（修复前红/修复后绿实测）

## 4. 影响范围

- **消费侧零影响**：全仓 grep 确认无任何代码消费 drillDown.params（仅 DTO 透传 memory-dto.ts:19/48）——纯 LLM 提示面
- HTTP DTO 透传不变（结构兼容）
- 无 schema/DB 变更

## 5. 取舍

- **选产出侧改**（而非 schema 加 id 兼容）：单/双形态并存是契约腐化温床；产出侧 3 处集中同文件，成本最低
- **不选删除 drillDown**：渐进式披露两步走是检索主链路，提示本身有价值，错的只是参数形态

## 6. Verification

- 修复前失败锚：`git stash` 回退产出侧 → 新增 #1398 回归测试红（实测 ✗ 1 failed）
- 修复后通过：search-memory.test.ts **36/36 绿**（含新增回归）
- 全仓零 drillDown.params 消费侧：grep 实测
