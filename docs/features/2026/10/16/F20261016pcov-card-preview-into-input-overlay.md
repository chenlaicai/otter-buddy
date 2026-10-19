---
id: F20261016pcov
title: 卡片预览槽位迁入输入覆盖层：交互卡片的发送/拒绝按钮可点 + 衬垫含卡片高
doc_type: feature
created: 2026-10-16
created_in_conversation: 6b8384a6-6c88-495f-8edb-7ef2175dcc2e
tags: [web, layout, ui, card]
modules:
  - web/src/pages/conversation/ChatView.tsx
  - web/src/pages/conversation/card-preview-overlay.test.tsx
  - web/e2e/input-fixed-split-visual.spec.ts
change_type: fix
capability_test: web/e2e/input-fixed-split-visual.spec.ts
summary: |
  搭档 10-16 16:16 截图报告「交互卡片触发的回答点不了」：卡片提交预览（水獭卡片
  发送确认）位于 main 文档流（MessageList 后 flex-shrink-0），与 F20261015inpd 起的
  输入覆盖层（absolute bottom-0 z-10）叠放——覆盖层透明但 hit-test 照吃，把预览卡
  的发送/拒绝按钮点击全部吞掉；卡片弹出还会压矮消息视口。修法（大獭 16:14 派工）：
  卡片 DOM 迁入覆盖层内（分割条下方、MessageInput 上方），利用 F20261016inbs 已建好
  的 ResizeObserver 动态衬垫机制，三笔账一次结清：按钮可点 + 衬垫自动含卡片高 +
  卡片不再压矮消息视口。卡片自身限高（JSON 区 240px 既有）防大卡片吃聊天区。
causal_links:
  from:
    - F20261016inbs
    - F20261015inpd
---

## 1. 背景与问题现象

搭档 chen 10-16 16:16 截图报告：「我发现，如果有交互卡片触发的回答，我也点击不了」。触发场景：水獭发交互卡片（html-card）→ 卡片内提交 → 输入框上方出现提交预览（summary + 数据 JSON + 发送/拒绝按钮）→ **按钮点击无响应**。

溯源：预览卡是 main 文档流子元素（`ChatView.tsx:224` 一带，MessageList 后 `flex-shrink-0`，git show bd2e0a80^ 可对照片段），与 F20261015inpd #1516 起的输入覆盖层（`ChatView.tsx:258` `absolute bottom-0 z-10`，修复前 HEAD 02d44248 位置）叠放。覆盖层 `absolute bottom-0` 自底向上铺满输入区，透明无背景但 **命中测试（hit-test）照吃**——文档流里的预览卡在其之下，发送/拒绝按钮的点击全被覆盖层截获，永远到不了按钮。**这是 #1516 覆盖层方案带出的旧伤，非 #1525（F20261016inbs）回归**（大獭 16:14 核实，git show bd2e0a80^ 对照）。

附带问题：预览卡在文档流会压矮消息视口（flex column 里卡片 `flex-shrink-0` 挤占 MessageList 空间）——与 F20261016inbs 的「视口 clientHeight 恒定」根治成果相悖。

## 2. 根因分析

| 断言 | 锚点 |
|---|---|
| 预览卡是 main 文档流子元素（MessageList 后） | `ChatView.tsx:224` 一带（修复前 HEAD 02d44248；`git diff` 本单删除块） |
| 输入覆盖层 `absolute bottom-0 z-10` 叠其上 | `ChatView.tsx:258`（修复前 HEAD 02d44248） |
| 覆盖层透明但 hit-test 照吃 | 浏览器 hit-test 规则：absolute/z-10 元素在命中链上层，无背景也截获 pointer events（e2e 场景 7 修复前 `elementFromPoint` 实测命中非按钮元素，见 §4） |
| 卡片预览渲染路径 | `useCardBridge.ts:139` `setPreview` → `ChatView.tsx:251` `props.cardPreview &&` 渲染（修复后行号） |

## 3. 修法（大獭 16:14 派工原话）

「把预览卡挪进覆盖层内（分割条下方、输入框上方），覆盖层实高自然含卡片」——利用 F20261016inbs 已建好的机制（overlay ResizeObserver 实高 → `bottomSpacerPx` → MessageList 末尾等高衬垫），卡片同附件暂存行路径走动态衬垫，三笔账一次结清：

1. **按钮可点**：卡片与 MessageInput 同在 overlay 容器内，无叠放冲突，hit-test 直达按钮
2. **衬垫自动含卡片高**：overlay RO 实测自然包含卡片高度，`bottomSpacerPx` 同步给消息列表——pinned 用户最后一条消息不被卡片遮挡
3. **卡片不再压矮消息视口**：overlay 是 absolute 悬浮，卡片迁入后脱离文档流，MessageList 视口高度不受卡片弹出影响（F20261016inbs「视口恒定」成果保持）

实现细节（`ChatView.tsx`）：

- 卡片块整体迁入 overlay 容器内、分割条（`role="separator"`）之后、MessageInput 之前——分割条永远在整个输入区（含卡片）的顶沿，拖动语义不变
- 卡片加 `data-testid="card-preview"`（测试锚点）+ 背景 `bg-amber-50/90 backdrop-blur-sm`（覆盖层内悬浮于消息之上，需不透明底+毛玻璃保证可读性；原 `bg-amber-50/60` 半透明会透出消息文字）
- 卡片限高既有：数据 JSON 区 `max-h-[var(--preview-scroll-max-h)]`（240px）内部滚动；summary 由 `validateCardSubmitPayload` 上限 500 字符（`html-card.ts:20` `CARD_SUMMARY_MAX_CHARS`）约束，卡片总高有限
- 文档流旧卡片块删除，避免双渲染

**边界铁律不变**（搭档拍板原话）：「输入框合消息框是隔离边界是固定……不去做 输入内容自动改变输入框大小这种事！越复杂越容易出错！」——本单不触碰边界机制，卡片高度变化走的是既有 RO 衬垫路径（内容变高 → 衬垫变高），不改变输入区固定高度，不引入内容驱动边界。

## 4. 验证（失败证据链 + 双环境）

### 4.1 失败证据链（bugfix 硬规则：先失败后通过）

**单测**（`web/src/pages/conversation/card-preview-overlay.test.tsx`，5 用例）：

- 修复前（`git show HEAD:...ChatView.tsx` 退回重跑，日志 `pcov-ut-before-fix.log`）：**4 failed / 1 passed**——「卡片在覆盖层容器内」「z 序契约」「发送/拒绝按钮回调连通（旧 DOM 无 testid 导致定位失败）」「衬垫含卡片」全红
- 修复后：**5 passed**

**e2e**（`web/e2e/input-fixed-split-visual.spec.ts` 场景 7/8，真浏览器 hit-test）：

- 修复前（同法退回 HEAD 重跑，日志 `pcov-e2e-before-fix.log`）：**2 failed**——场景 7 红在 `expect(hit, '发送按钮必须可命中（旧 bug：透明 overlay 吞点击）').toBe(true)`（`input-fixed-split-visual.spec.ts:288`）——「点击被吞」的直接复现，不是 testid 缺失的间接红
- 修复后：**2 passed**

e2e 断言设计（为何用文本锚）：hit-test 断言用按钮文本「发送」定位（MessageInput 发送按钮仅图标无文本，匹配唯一），不依赖 `data-testid`——保证失败证据落在「被吞」本尊而非「testid 缺失」。

### 4.2 回归与全量

| 验证面 | 结果 |
|---|---|
| 单测全量（vitest，70 文件） | 708 passed |
| tsc --noEmit | 干净 |
| e2e dev（vite dev :3116）全量 | 36 passed / 6 skipped |
| e2e prod（vite build + preview :3117，场景含 inbs 回归） | 6/6 passed |
| scroll-pin-frame-guard.spec.ts | 显式门控 skip（需 `E2E_REPLICA_DATA=1` 真数据实例，「宁可 skip 不假绿」设计，与 main 行为一致非回归） |

**双环境验证是硬要求**（F20261016inbs 检视轮教训「dev 绿≠prod 绿」）：dev 与 prod（build 压缩产物）均实测通过。

截图证据：`test-results/pcov-1-confirm-clickable.png`（发送可点+回执发出）、`test-results/pcov-2-reject-clickable.png`（拒绝可点）。

### 4.3 单测覆盖清单

1. 卡片在覆盖层容器内（DOM 结构契约）
2. z 序契约：卡片在分割条之后、MessageInput 之前
3. 发送/拒绝按钮回调连通（props 透传）
4. 衬垫含卡片：卡片出现 → overlay RO 实高含卡片 → `bottomSpacerPx` 同步
5. 无卡片时行为不变（回归锚：overlay 结构与 F20261016inbs 一致）

## 5. 机制识别检查点判定（Modification-Class: narrow-fix）

本单未命中机制识别检查点任一项：不新增状态、不新增通道、不新增组件层级语义——仅把既有卡片块的 DOM 位置挪进既有 overlay 容器（F20261015inpd 覆盖层 + F20261016inbs 动态衬垫均为既有机制），hit-test 修复是位置变更的直接后果。故判修法决策树①（既有机制语义内修），非④新增机制。

**最简实现检查（已过）**：一行 JSX 位置变更（剪切+粘贴卡片块进 overlay）+ 测试锚点即达成全部目标；衬垫机制复用 F20261016inbs 既有 RO 通道，零新依赖/零新状态/零新组件。备选方案「给 overlay 加 pointer-events 切换或透传点击」需要精细的事件路由与边界处理，代码量与状态机复杂度都更高且易在拖拽/输入交互上引入新 bug——弃繁采简。

**负面向验收条目（迁移类）**：本次变更破坏了什么旧契约？——①卡片块的 DOM 祖先从 main 文档流变为 overlay 容器：依赖「卡片在文档流」的旧假设（若有外部 CSS/测试选择器按此定位）会失效，已核实仓库内无其他引用（grep 仅 MessageList/ChatView 自用）；②卡片从文档流脱离后不再挤压 MessageList 高度——旧的「卡片弹出压矮视口」行为消失，这是修复目标本尊。未绕过任何既有保护：校验链/节流/拒绝计数（useCardBridge）与 lint 门禁均原样。

## 6. 影响范围与风险

- **影响面**：仅 ChatView 卡片预览槽位渲染位置；MessageInput / MessageList / 边界机制零改动
- **风险 1（低）**：超长 summary（≤500 字符上限）+ 大 JSON 时卡片撑高 overlay，衬垫随之变高、消息可视区变小——但消息不被遮挡（衬垫同步），且 JSON 区 240px 限高 + summary 字符上限兜住总量
- **风险 2（低）**：卡片背景从半透明改 `bg-amber-50/90 backdrop-blur-sm`——视觉上卡片悬浮于消息流之上（新位置的自然要求），截图证据见 §4.2
- **不做**：不改 wireframe/preview 卡片功能逻辑（校验链、节流、拒绝计数均未动）、不触碰输入边界机制
