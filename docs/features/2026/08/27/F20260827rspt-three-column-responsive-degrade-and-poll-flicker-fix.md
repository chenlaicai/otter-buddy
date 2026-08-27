---
id: F20260827rspt
title: 三栏布局响应式断点降级与轮询 hover 快览卡微抖修复（#500 #502）
summary: |
  修复 F20260826pfix 三路审视遗留的两项 UI 技术债：#500（P1）三栏布局无响应式断点降级——
  LeftPanel w-56 + RightPanel w-64 均 flex-shrink-0，<1024px 窗口聊天区被挤 <500px、
  <800px 消息气泡严重压缩；#502（P2）轮询/事件回调每次 setAllOtters 产全新对象引用，
  OtterProfileCard hover 快览卡微闪。
  方案：断点降级（≥lg 三栏全开 / md~lg 右栏抽屉化 / <md 左右栏均抽屉化，悬浮不挤压聊天区）
  + setAllOtters 三处调用点浅比较保引用 + OtterParticipantCard memo 兜底。

causal_links:
  from:
    - F20260826pfix

status: development
change_type: fix
tags: [web, responsive, layout, react, polling, performance]
modules:
  - web/src/pages/conversation/index.tsx
  - web/src/pages/conversation/RightPanel.tsx
  - web/src/pages/conversation/LeftPanel.tsx
  - web/src/lib/shallow-equal-otters.ts
  - web/src/hooks/use-media-query.ts
capability_test: "n/a: 纯前端 UI 改动（A 类），无 LLM 参与行为"
created_in_conversation: e407eda2-1c7b-4e84-b544-f33320febd5f
---

# F20260827rspt: 三栏布局响应式降级（#500）+ 轮询 hover 快览卡微抖修复（#502）

## 背景与需求

两 issue 均为 F20260826pfix（海獭面板 UI 修复）三路审视显式"另行立项"的遗留技术债。

### #500（P1）：三栏布局无响应式断点降级

`conversation/index.tsx` 三栏布局：LeftPanel `w-56`(224px) + RightPanel `w-64`(256px) 均 `flex-shrink-0`，仅 ChatView `flex-1` 可缩。窗口 <1024px 时聊天区被挤 <500px，<800px 时消息气泡/输入框严重压缩。

### #502（P2）：轮询刷新时 hover 快览卡微抖

三处 `setAllOtters(prev => ({...prev, [cid]: participants.map(mapParticipantDTO)}))`（`loadConversationDetail`、dissolve 回调 `refreshParticipantsAfterDissolve`、SSE `onDone`）无条件产出全新数组与对象引用。即便参与者一字未变，`allOtters` 引用变化 → RightPanel 整树 re-render → hover 中的 `OtterProfileCard` 重挂载/重渲染，视觉上表现为微闪。

## 方案设计

### #500：断点降级 + 抽屉交互

断点策略（Tailwind 默认断点，`useMediaQuery` hook 驱动）：

| 视口 | 左栏 | 右栏 | 聊天区 |
|------|------|------|--------|
| ≥lg (1024px) | 常驻 224px | 常驻 256px | 剩余全部 |
| md (768px) ~ lg | 常驻 224px | **抽屉化**（右下悬浮按钮展开） | 全宽 - 左栏 |
| <md | **抽屉化**（左下悬浮按钮） | **抽屉化**（右下悬浮按钮） | 全宽 |

关键决策与理由：

1. **抽屉悬浮（absolute/fixed 定位）而非挤压式折叠**：issue 的核心诉求是"聊天区不被挤压"。抽屉打开时悬浮于聊天区之上（z-50，玻璃拟态），关闭时聊天区独占全宽——任何断点下聊天区都不再 <500px。
2. **面板组件保持挂载**：抽屉仅切换容器 `hidden` 类，LeftPanel/RightPanel 内部状态（滚动位置、表单输入、hover 态）不丢失；LeftPanel 自身的 sessionStorage 滚动恢复逻辑不受影响。
3. **`contents` 显隐模式**：宽屏时包装 div 用 `display: contents` 退化为透明容器，三栏 flex 布局与改动前逐像素一致（零回归风险）；窄屏时切换为 absolute 抽屉。
4. **开关按钮 fixed 定位**（左下/右下，z-40）：不占用 flex 布局空间，不挤压聊天区；玻璃拟态圆形按钮与现有 UI 风格一致。
5. **可访问性**：按钮带 `aria-expanded` / `aria-controls` / `aria-label`；两抽屉互斥展开（开左关右）；跨回宽屏断点时自动复位抽屉状态，避免 aria 状态与实际显隐不符。
6. **`useMediaQuery` 新 hook**：matchMedia + change 监听；无 matchMedia 环境（jsdom/老浏览器）兜底为宽屏 true（三栏全开，与桌面默认行为一致，既有组件测试不受影响）。
7. **aside 加 `h-full`**：抽屉模式下 absolute 容器靠 `h-full` 撑满高度；宽屏 flex 模式下 `h-full`（height:100%）相对已 stretch 的 flex 行高度解析，与 stretch 结果相同——已 build + 全测试验证无回归。

### #502：浅比较保引用 + memo 兜底

1. **新增 `web/src/lib/shallow-equal-otters.ts`**：
   - `shallowEqualOtters(a, b)`：逐字段比较 UI 消费字段（id/name/type/createdAt/role?.name/modelAlias）。`parentOtterId` 不进任何渲染路径，不参与比较；`role.resp` 同理（仅 role.name 被展示）。
   - `mergeOttersIfChanged(prev, convId, next)`：setAllOtters 专用 updater——内容未变返回 `prev`（保引用），变化才产新对象；其他对话的列表引用不动。
2. **三处调用点接入**：`loadConversationDetail`、dissolve 回调、SSE `onDone` 均改走 `mergeOttersIfChanged`。
3. **`OtterParticipantCard` 包 `React.memo`**：数据 props（otter/sessions）引用稳定时跳过重渲染。已知局限：onClick/onDissolve/onRestart 是 RightPanel 内联箭头（每次新建），memo 对函数 props 无效——但抖动主源是数据 props（轮询重映射），函数 props 每次父渲染才变，而父渲染频率本来就由数据驱动，memo 仍显著降低重渲染率。
4. **不动轮询架构**：5s 对话列表轮询（`useConversationListPolling`）与 2s in-flight 续看轮询的时序/冻结逻辑（F20260825scrf）一律不碰。

## 影响范围

- 改动文件：`conversation/index.tsx`（布局 + 三处 setAllOtters）、`RightPanel.tsx`（memo + h-full）、`LeftPanel.tsx`（h-full）
- 新增文件：`lib/shallow-equal-otters.ts`、`hooks/use-media-query.ts` 及各自测试
- 行为变化：仅 <1024px 视口（此前为不可用挤压态）；≥1024px 桌面用户零感知
- 兼容性：无接口变更、无破坏性变更；jsdom 测试环境兜底宽屏，既有 26 个测试文件不受影响

## 取舍

- **抽屉 vs 图标化窄栏**：选抽屉。图标化窄栏（只留头像条）仍占 ~48px 且信息密度低；抽屉彻底释放宽度给聊天区，符合 issue"聊天区不被挤压"的根诉求。
- **浅比较字段子集 vs 全字段深比较**：选 UI 消费字段子集。LocalOtter 字段全为原始值（role 仅 name 被消费），逐字段浅比较 O(n×6) 开销可忽略；深比较 resp 数组是浪费（不进渲染）。
- **matchMedia JS 驱动 vs 纯 CSS 断点**：抽屉开关需要 React 状态（aria-expanded、互斥展开），纯 CSS 无法承载；容器显隐用 JS 条件类而非 Tailwind `lg:` 前缀，换来状态语义明确。代价是 resize 跨断点时一次重渲染——频率极低，可接受。

## 验证

- `npm test`（vitest）：26 文件 / 215 用例全绿，含新增：
  - `shallow-equal-otters.test.ts`：9 用例（等值/逐字段变化/role 有无/顺序/merge 保引用/他对话引用不动/新对话写入）
  - `use-media-query.test.ts`：5 用例（初始值双向/跨断点变化/卸载移除监听/无 matchMedia 兜底）
  - `RightPanel.test.tsx` 追加 2 用例：memo 生效时 DOM 节点引用不变（不重建=无抖动）、内容变化正常更新
- `npm run build`（tsc --noEmit + vite build）：通过
- ≥1024px 桌面布局与改动前逐像素一致（`contents` 模式），窄屏抽屉交互待 PR 检视时人工复核
