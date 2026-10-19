---
id: F20261019ovmh
title: 输入覆盖层总高封顶 60%：短视口+大卡片不再吃掉消息区（#1538）
doc_type: feature
created: 2026-10-19
created_in_conversation: 6b8384a6-6c88-495f-8edb-7ef2175dcc2e
tags: [web, layout, ui, card]
modules:
  - web/src/pages/conversation/ChatView.tsx
  - web/src/pages/conversation/overlay-max-height.test.tsx
  - web/e2e/input-fixed-split-visual.spec.ts
change_type: fix
capability_test: web/e2e/input-fixed-split-visual.spec.ts 场景 9（真浏览器布局断言）
causal_links:
  - F20261016pcov
  - F20261015inpd
compatibility: 无 API/存储/行为变更；覆盖层总高从无封顶变为 ≤ 容器 60%，大卡片预览在封顶后内容区内部滚动
summary: |
  #1538：#1535 把预览卡迁入输入覆盖层后总高无封顶，短视口+大卡片展开态下 overlay 实测 609px 吃掉 main 396px 的 154%，消息区被完全吞没。修法三类名级改动：覆盖层容器 max-h-[60%] flex flex-col（不用 60vh——矮窗口 vh 可大于 main 被 overflow-hidden 裁掉；不加容器 overflow-hidden——会裁掉探出顶沿的分割条热区 hit-test，e2e 实证）；预览卡改 min-h-0 可收缩 + 内容区 overflow-y-auto 内部滚动；按钮行/热区 shrink-0 恒可见。衬垫机制零改动自动正确（RO 观测 clamp 后实高）。证据：新增单测 6 例（修复前 4 failed）+ e2e 场景 9 真浏览器断言 + 拉满态截图，web vitest 714 全绿、tsc 零错。
---

# 输入覆盖层总高封顶 60%（#1538）

## 背景

#1535（F20261016pcov）把卡片预览槽位迁入输入覆盖层后，覆盖层（分割条 + 预览卡 + 输入框）总高无容器级封顶：PR 审视 S1 发现「输入框分割条上限 55% + 预览卡最坏 ~550px（数据 JSON 展开态）+ 矮视口」叠加时覆盖层可超过 main 容器高度，卡片待决期间消息区近乎空白。瞬态、低频，搭档合入 #1535 时挂账，本单闭环（issue #1538）。

**失败证据（HEAD 基点 + 本单 e2e 场景 9 重放）**：视口 640×480、大卡片（summary 277 字符 + dataJson 1843 字节展开态）下 overlay 实高 609px，超过 main（396px）的 154%——聊天记录区被完全吃掉。见 `ovmh-e2e-before-fix.log`（对话工作区）。

## 修法

三处类名级改动（ChatView.tsx），零 JS 逻辑变更：

1. **覆盖层容器**（`overlayRef` div）：`max-h-[60%] flex flex-col`
   - 用百分比而非 `60vh`：max-h 百分比锚 containing block（main），矮窗口里 vh 可能大于 main 实高，`overflow-hidden` 的 main 会直接裁掉溢出部分——把 bug 换个形态带回来
   - **不加 overflow-hidden**：分割条热区（`h-2 -mt-2`）靠负 margin 探出 overlay 顶沿 8px，容器级裁切会把热区连同 hit-test 一起裁掉（拖拽失效）。首版踩过：加容器 overflow-hidden 后既有 e2e 场景 2/3 拖拽断言全挂（拖不动，expected 200 got 120）。溢出收敛由卡片自身 min-h-0 + overflow-hidden 承担，flex 收缩不需要容器级裁切
   - 消息区恒留 ≥40%
2. **预览卡**：`flex-shrink-0` → `min-h-0 flex flex-col overflow-hidden`（唯一可收缩项）；内部内容区（summary + dataJson）独立 `flex-1 min-h-0 overflow-y-auto`——超限时卡片内部滚动，不撑破封顶
3. **恒可见件**：卡片提示行/按钮行加 `shrink-0`，分割条热区加 `shrink-0`——封顶挤压时发送/拒绝按钮、拖拽热区不被压没（#1535 的首要目标是按钮可点，封顶不能回退它）

旧 `max-h-[var(--preview-scroll-max-h)]`（JSON pre 单独 240px 限高）删除：封顶 + 整卡内部滚动后它是冗余层；`--preview-scroll-max-h` CSS 变量保留未动（web/src/styles/globals.css:73，或另有引用，保守不删）。

**衬垫机制零改动自动正确**：ResizeObserver 观测 overlay 实高（封顶 clamp 后的实高）→ bottomSpacerPx 同步——不存在「衬垫按未封顶自然高度算、消息被吞进 overlay 背后」的错位（e2e 场景 9 断言 `|spacer - overlay| ≤ 2px` 验证）。

## 验证

| 项 | 结果 |
|---|---|
| 新单测 `overlay-max-height.test.tsx`（6 用例：容器封顶类/无卡恒态/卡片收缩+滚动/按钮行/衬垫契约/分割条语义） | 修复前 4 failed（ovmh-ut-before-fix.log）→ 修复后 6 passed |
| web vitest 全量 | 71 文件 714 用例全绿（首跑 skills/index.test.tsx 翻页引擎 4 用例 flaky——单跑绿、复跑绿、基点纯净态单跑亦绿、与本单 conversation 域无关联路径，判定既有 flaky 非本单回归） |
| `cd web && npx tsc --noEmit` | exit 0 零错（主仓 check 不编 web，独立跑） |
| e2e 场景 9（真浏览器 640×480 + 大卡片） | 修复前 overlay 609px > main·60% → 修复后封顶生效：overlay ≤ main 60%、消息区 ≥ 39%、内容溢出走卡片内部滚动、发送按钮 viewport 内可命中（elementFromPoint 真值）、衬垫 = overlay 封顶实高 |
| 既有 e2e 场景 1-8 回归（同 spec：inbs 拖拽/持久化/死区 + pcov 按钮可点） | 7/7 全绿（首版容器 overflow-hidden 曾挂场景 2/3，已修） |
| 视觉证据 | 修复后拉满态截图 `ovmh-maxed.png`（对话工作区，640×480） |

e2e 跑法：worktree web/ 下 `npx vite --port 3116 --strictPort` + `E2E_BASE_URL=http://localhost:3116 npx playwright test e2e/input-fixed-split-visual.spec.ts`（CI 全栈跑法 `scripts/e2e-server.sh run` 不受影响）。

## 取舍

- **60% 而非更紧**：Slack/Discord 输入区展开态占屏 1/3~1/2 常态；60% 上限兼顾「大卡片可读」与「消息区恒可见」，留 40% 给聊天记录（480px 矮视口下 ~158px，约 2-3 条消息可见）。要再调只是改一个类名，e2e 断言同步改即可。
- **容器不裁切、卡片自裁**：保分割条热区 hit-test（负 margin 探出顶沿），是溢出收敛与拖拽交互共存的关键约束，文档「修法」节有实证记录。
- **工作区时效性**：日志/截图留对话工作区按 F20261019tmly 判据自主清理。

## 关联

- 上游：F20261016pcov（卡片迁入覆盖层，本单封其 S1 挂账）、F20261015inpd（覆盖层）、F20261016inbs（分割条）
- issue #1538（本单闭环）
