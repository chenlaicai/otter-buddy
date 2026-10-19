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
compatibility: 无 API/存储变更。覆盖层总高 ≤ 容器 60%；卡片在场时输入有效上限动态收紧（大卡地板 68px，检视獭-1552 严重 1 处置），无卡时行为零变化
summary: |
  #1538：#1535 把预览卡迁入覆盖层后总高无封顶，短视口+大卡片展开态 overlay 实测 609px 吃掉 main 396px 的 154%。R1（三类名级）：容器 max-h-[60%] flex-col + 卡片 min-h-0 收缩/内部滚动 + 按钮行 shrink-0。R2（检视严重 1 处置，拖高档恒可见破裂）：输入让步——卡片在场时上限收紧 min(55%, 60%·main−36)−地板68，卡片 minHeight 地板 68 保按钮行；矮视口装不下地板时宁溢出不裁按钮（零和不互斥）。#1535 按钮可点与 #1538 消息区保障不互相牺牲。证据：单测 11 例 + e2e 场景 9/10a/10b（拖高档真 hit-test，R1 版 10a 实测 inputH=216 无收紧）+ web vitest 全绿 + tsc 零错。
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
3. **恒可见件**：卡片提示行/按钮行加 `shrink-0`，分割条热区加 `shrink-0`——封顶挤压时发送/拒绝按钮、拖拽热区不被压没。⚠️ 此条纯类名方案在输入拖高档位实测不成立（检视獭-1552 严重 1：MessageInput 根节点 flex-shrink-0 不可收缩，卡片可被压穿地板），R2 已以 JS 几何修正（见 R2 节）——shrink-0 保留为辅助，硬保障由动态地板承担

旧 `max-h-[var(--preview-scroll-max-h)]`（JSON pre 单独 240px 限高）删除：封顶 + 整卡内部滚动后它是冗余层；`--preview-scroll-max-h` CSS 变量同步删除（大獭 13:06 拍板：本 PR 正是清理这片区域的，留死配置自相矛盾；全仓零引用已验证）。

**衬垫机制零改动自动正确**：ResizeObserver 观测 overlay 实高（封顶 clamp 后的实高）→ bottomSpacerPx 同步——不存在「衬垫按未封顶自然高度算、消息被吞进 overlay 背后」的错位（e2e 场景 9 断言 `|spacer - overlay| ≤ 2px` 验证）。

## 验证（R1）

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

- **60% 而非更紧**：Slack/Discord 输入区展开态占屏 1/3~1/2 常态，60% 上限留 40% 给消息区（480px 矮视口下 ~158px）。「兼顾大卡片可读」实测校准（检视建议 2）：默认输入高下大卡内容区仅数 px 可见（数据区靠内部滚动读），卡片可读性由滚动 + R2 输入让步争取的空间承担，而非抬高封顶——issue 优先保消息区。
- **容器不裁切、卡片自裁**：保分割条热区 hit-test（负 margin 探出顶沿），是溢出收敛与拖拽交互共存的关键约束，R1 有实证记录。
- **工作区时效性**：日志/截图留对话工作区按 F20261019tmly 判据自主清理。

## R2：卡片态输入让步（检视獭-1552 严重 1 处置）

**审视发现**：R1 的「按钮行/提示行 shrink-0 恒可见」承诺在输入拖高档位破裂——MessageInput 根节点是 flex-shrink-0（不可收缩），输入拖高后卡片先被压穿自身地板（min-h-0 可塌到 0，shrink-0 子项挡不住整卡被 overflow-hidden 裁切），按钮随之不可达；输入拖到顶后差额溢出被 main overflow-hidden 吃掉，hint 行出界。矮屏拖到 ~1/3 档位按钮即消失（检视实测 P2/P4/P5），大屏同样复现。

**处置方向（大獭拍板：检视方案 a/c 组合，输入让步）**：卡片是即时任务（待决），输入高度是偏好——零和下输入让步。

**机制**（ChatView.tsx，JS 几何而非纯类名）：
1. `cardAwareInputLimit(overlay)`：卡片在场时计算输入有效上限。零和公式：输入高 + 固定开销（分割条 8 + root 28）+ 卡片高 ≤ 封顶 floor(60%·main)。`limitRaw = min(55%, cap−36)`；卡片自然高超出预算时取地板 `floor = min(68, scrollHeight − cardBudget)`，返回 `limit = limitRaw − floor`
2. 拖动 clamp、卡片出现时收紧（cardId effect，超限立即收回）、mount 恢复三处接线同一 limit；无卡时 limit=Infinity，行为零变化
3. 卡片 minHeight = floor（动态 style）：封顶零和下若 60% 预算装不下地板（矮视口极端态），宁可让 overlay 溢出 main 底也不裁按钮——#1538 保消息区 vs #1535 保按钮可点，两个保障不因封顶互相牺牲

**实测校准值**：固定开销 36 = 分割条 8 + MessageInput root pt-2/pb-5 共 28（提示行在 style=height 盒内，root 高 = inputHeight+28 恒等）；地板 68 = 卡片 py-3×2(24) + 警示行(~14) + 按钮行(~30)。

**行为面**：矮屏 640×480 大卡下拖顶：输入收紧 133（原 216）、卡片 68 保按钮可点、输入不出界；大屏 1280×900 拖顶：输入收紧 ~380（原 447）；拖回 120 自愈恢复。用户若在卡片待决期间想拉高输入框，上限被临时压低——这是零和下的有意取舍（见「消息区恒留 ≥40%」承诺优先）。

## 验证（R2）

| 项 | 结果 |
---|---|
| 单测 R2 块 5 例（拖高档 clamp 收紧 256/地板 68/小卡零地板/持久化超限收回/无卡 55% 不变） | 修复前全挂（无收紧逻辑）→ 后全绿；R2 后单测共 11 例全绿 |
| e2e 场景 10a（640×480 拖顶+大卡：真 hit-test） | R1 版 inputH=216、按钮被裁（ovmh-e2e-r2-before-fix.log）→ R2 版 inputH=133、卡片 68、发送按钮可命中、输入不出界、overlay=cap 零和 |
| e2e 场景 10b（1280×900 拖顶+大卡） | 输入收紧 ~380、按钮可点（检视 P4 态修复） |
| 全 spec 回归（场景 1-9 含 inbs 拖拽/pcov 按钮可点） | 9 场景全绿（无卡拖拽行为零变化：场景 2 仍 clamp 55%） |
| `cd web && npx tsc --noEmit` | exit 0 |
| web vitest 全量 | 71 文件 719 用例全绿 |

截图：`ovmh-10a-maxed.png`（对话工作区，拖顶+大卡收紧态）；探针 JSON 留对话工作区。

## 后续可选（检视獭-1552 delta 观察级，大獭 13:17 拍板本轮不加）

- **拖动中卡片到达竞态加固**：`onFinish`（ChatView.tsx）松手时对 `latestHeight` 补一次 `min(latestHeight, cardLimitRef.current)` 重 clamp——拖拽进行中 cardId 变更（预览卡由本页 iframe submit 触发，持指中难发生）时，最终高度可能越收紧上限并持久化。后果有界（卡片地板仍在、按钮承诺不破；下次 cardId 事件/重载自愈）。已验证机制本轮不动，留档待后续顺手落。
- 卡片离场输入不回弹（保持收紧值，可再拖）：未承诺回弹，合理，仅记录。

## 关联

- 上游：F20261016pcov（卡片迁入覆盖层，本单封其 S1 挂账）、F20261015inpd（覆盖层）、F20261016inbs（分割条）
- issue #1538（本单闭环）
