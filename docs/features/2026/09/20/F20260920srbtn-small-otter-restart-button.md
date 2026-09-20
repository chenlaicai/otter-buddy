---
id: F20260920srbtn
title: 小獭重启獭生按钮开放
summary: 取消「重启獭生仅限大獭」限制，Web UI 右栏 hover 按钮与详情弹窗 footer 对小獭开放重启入口（保留解散双入口），后端删除 small 拦截，与 agent 侧 restart_otter「大獭可重启小獭」能力对齐。
change_type: feature
capability_test: tests/api/otter.test.ts
created_in_conversation: d797c285-0419-4d9c-9430-2abbb9b30226
causal_links:
  - supersedes: F20260805rsto（其中「重启是大獭专属、前端入口隐藏、后端兜底拦截」的决策被本特性翻转）
  - relates-to: F20260917rsta（空摘要自动 LLM 交接——小獭重启同样受益）
  - relates-to: F20260916fst4（首哑 429 复活路径 restart_otter 已支持大獭重启小獭，本特性补齐 Web UI 侧）
tags: [otter, restart, web-ui, session]
modules:
  - src/interface-adapters/http/controllers/otter-controller.ts
  - web/src/pages/conversation/Modals.tsx
  - web/src/pages/conversation/RightPanel.tsx
  - tests/api/otter.test.ts
  - web/src/pages/conversation/Modals.test.tsx
created_at: 2026-09-20
---

# 小獭重启獭生按钮开放

## 问题背景

搭档反馈「小獭缺了重启獭生按钮」。排查发现这不是漏做，而是 F20260805rsto 的显式设计：重启曾是大獭专属机制（小獭用解散），前端两处入口（右栏参与者卡片 hover 按钮、详情弹窗 footer）均以 `isBig` 门住，后端 otter-controller 还有 small 拦截兜底（400「小獭不支持重启獭生，请使用解散」）。

但该设计与 agent 侧能力不对称：`restart_otter` 工具明确支持「大獭可重启任意 Otter」（首哑 429 复活即此路径，F20260916fst4），且 Web UI 是搭档亲手操作小獭生命周期的唯一入口——小獭上下文被污染/配额耗尽需要换模型重开时，搭档只能靠对话里指挥大獭，无法直接点击。搭档本次提出缺按钮，即翻转旧决策。

## 方案设计

### 1. 后端：删除 small 拦截（otter-controller.ts）

删除 restart 端点内的 `otter?.type === "small"` 拦截块。manage-session 的 `restartSession` 与 agent-invoker 的 `restartWithAutoHandoffIfBlank` 路径对小獭类型均无障碍（agent 工具链一直在用）。

### 2. 前端：两处入口同步放开

- **RightPanel.tsx 参与者卡片**：hover 快捷按钮去掉 `{isBig && ...}` 门，小獭卡片也显示「重启」（解散按钮维持仅小獭可见）。
- **Modals.tsx 详情弹窗 footer**：所有獭显示「重启獭生」；小獭追加「解散小獭」双按钮（大獭仍无解散——解散小獭是大獭管理小獭的动作，大獭本体不可解散）。

## 验收场景

| # | 操作 | 预期 |
|---|------|------|
| AT-1 | 右栏 hover 小獭卡片 | 「重启」快捷按钮出现（opacity 0→1） |
| AT-2 | 点小獭卡片开详情弹窗 | footer 同时有「重启獭生」+「解散小獭」 |
| AT-3 | 大獭详情弹窗 | footer 仅「重启獭生」，无「解散小獭」 |
| AT-4 | 小獭点「确认重启」 | POST /api/otters/:id/restart → 201，旧 session 转 restarted，新 session active 且 previousSessionId 链接正确 |
| AT-5 | 重启弹窗 | 模型下拉（切模型）+ 可选前情摘要（留空走 LLM handoff 自动合成，F20260917rsta 语义） |

## 设计取舍

**机制判定**：修改类型为 `narrow-fix`（既有语义内修——重启机制本身不动，只拆除类型门槛）。机制识别检查点逐项核对：无新增数据结构、无新触发链、无绕过既有保护（反向：删除了一条拦截保护，属于能力放开而非绕过）、无并行机制——不命中机制新增，无需四问。

**为什么小獭保留「解散」而大獭没有**：解散是不可逆销毁（身份+session 永久丢失），大獭是用户唯一持久 Otter 不可销毁；小獭是临时劳动力，解散是正常生命周期终点。重启对两者语义一致（封存前世开新一世，可多次、可追溯），故全开放。

**为什么删除后端拦截而非仅放开前端**：前端入口隐藏 + 后端拦截是同一决策的两面，只改前端会留下 API 层的死语义（agent 工具已能重启小獭，HTTP 端点却拦），违背「同一能力同一真相」。

## 验证

- 后端单测：`npx vitest run tests/api/otter.test.ts` → 21 passed（含翻转后的「小獭可重启 201」用例）
- 全量测试：`npm test` → 270 files / 3652 tests passed；`npm --prefix web test` → 53 files / 490 tests passed
- tsc --noEmit 后端 + web 均干净；npm run check 无新增告警（12 条既有基线警告，改动文件不在其中）
- **真机 UI 自查**（alpha 隔离实例 localhost:3182，造数据：大獭+检视小獭同场）：
  - hover 小獭卡片 → 重启按钮 opacity 0→1（BTN[1] opacity=1）✓
  - 详情弹窗 footer = [关闭, 重启獭生, 解散小獭] ✓
  - RestartModal 弹出含「确认重启」+ 模型下拉 ✓
  - 截图证据：`data/workspaces/d797c285-0419-4d9c-9430-2abbb9b30226/srbtn-*.png`
- **端到端 API**：POST 小獭 restart → 201，session 链 2b7d1046→restarted / 9831fa79→active，previousSessionId 正确 ✓
- 最简实现检查：已过——3 个源文件共净改动约 ±20 行，无新文件、无新依赖、无状态迁移，删拦截 + 拆条件渲染即为最小语义变更。

## 与 #1049 的冲突协调（搭档裁决 2026-09-20）

本 PR 为独立特性，基于 main 开发，不 rebase 到 #1049（feature/unify-handoff-compaction）之上。曾错误地 rebase 到 #1049 分支（动机：消除合并冲突），经搭档指正后回滚至原始提交 a396e2b7。

冲突事实标记（merge-base 85c5ff2f 试算，3 处）：
1. `tests/api/otter.test.ts`：小獭重启用例翻转（本 PR）× restart 测试重构为文件级 describe（#1049）
2. `web/src/pages/conversation/RightPanel.tsx`：重启按钮 isBig 门拆除（本 PR）× 忙碌置灰改造（#1049）
3. `src/interface-adapters/http/controllers/otter-controller.ts`：small 拦截删除（本 PR）× 统一交接接线（#1049）

**原则（已入 fact 留痕）**：独立特性 PR 基于目标分支开发；与其他 PR 冲突只做事实标记，合并顺序由搭档拍板。后合一方解冲突时参考：保 #1049 重构结构 + 保本 PR 翻转语义（小獭 201、拦截删除、isBig 门拆除与忙碌置灰并存）——rebase 期间的验证记录（3663+495 全绿）可作为解冲突后的回归基线。

## 遗留

- 解散确认弹窗的文案「解散后无法恢复」等既有文案未动，与小獭重启不冲突。
- agent 侧 restart_otter 的 description 已写明「大獭可重启任意 Otter」，无需改动。
