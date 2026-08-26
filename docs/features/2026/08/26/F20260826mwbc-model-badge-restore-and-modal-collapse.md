---
id: F20260826mwbc
title: 模型 badge 归位与详情弹窗世数链摘要折叠
summary: |
  修复身份证系列重构（#450/#458/#465）引入的两个前端回归/体验问题，并追加
  结构级布局改版：
  1) 参与者卡片模型 badge 被挤到玻璃卡片外（视觉隐形），挪回卡片内部右侧
  badge 行恢复 #445 原视觉；2) 详情弹窗世数链长前情摘要全文渲染撑爆垂直
  空间，历史世摘要默认 line-clamp-3 折叠 + 展开/收起切换，当前世保持完整；
  3) 详情弹窗内容分左右两栏（左=身份信息，右=世代交接），桌面双栏、移动端
  单列堆叠（与全屏抽屉断点严格互补）。
change_type: fix
status: active
capability_test: "n/a: 纯前端布局/UI 状态修复，无 LLM 参与行为"
created_in_conversation: f8bf2fbe-6da0-4861-8f48-9ccb27f50c07
---

# 模型 badge 归位与详情弹窗世数链摘要折叠

## 背景

F20260825vrqh（PR #445）交付「模型展示」：参与者卡片模型 badge + 详情弹窗模型字段。随后另一对话的「海獭身份证」系列 PR（#450 hover 快览卡 / #458 聚合端点 / #465 移动端打磨）重构了 `OtterParticipantCard`，引入两个问题。搭档报障，大獭排查定位根因（数据链路经 curl 实测正常，纯展示层问题），本 PR 修复。

## 问题与根因

### 问题 1：模型 badge 被挤到卡片外，视觉上消失

- 位置：`web/src/pages/conversation/RightPanel.tsx` OtterParticipantCard
- 根因：#445 原设计 badge 在玻璃卡片内部（名称块之后、「大獭」badge 之前的右侧 badge 行）。#450 重构时 badge 被挪到内层卡片 div 结束之后，以 `mt-1 w-fit` 挂在卡片外部下方，挤在两张卡片的缝隙里，视觉上等于隐形。
- 后端链路完好（modelAlias 正常下发，大獭 curl 实测墨鱼=mimo、白鲸=kimi），纯 DOM 位置回归。

### 问题 2：详情弹窗世数链长摘要把内容撑爆

- 位置：`web/src/pages/conversation/Modals.tsx` OtterDetailModal 转世履历区
- 根因：每个 session 块的 `s.summary`（前情/交接词）无行数限制全文渲染。多世海獭 × 长摘要叠加，弹窗内容超长——Modal 结构本身有 `max-h + overflow-y-auto`，能滚但一屏看不完、找不到重点。

## 修复方案

### 修复 1：badge 挪回卡片内部（恢复 #445 原视觉）

把模型 badge 移回内层玻璃卡片 div 内、`flex-1 min-w-0` 名称块之后 `{isBig ? ...}` badge 区之前（即 #445 原始 diff 的位置）：

- className 恢复原样式：`text-[9px] font-semibold px-2 py-0.5 rounded-full bg-stone-400/15 text-stone-500`（去掉 `mt-1 w-fit`）
- 保留 `data-testid="model-badge"`（测试语义断言依赖，#445 审视处置引入）
- hover 快览卡（OtterProfileCard）、重启/解散按钮、MoreHorizontal 的布局不受影响——badge 回到 flex 行内自然占位，不碰其它元素

### 修复 2：世数链摘要折叠（交互设计按搭档确认的方案实现）

- **当前世**（`s.status === 'active'`）：摘要保持完整展示（`前情：xxx`）
- **历史世**（restarted/archived）：默认 `line-clamp-3` 折叠，摘要下方「展开/收起」按钮切换，展开后不限高
- 状态：受控展开（`expandedSummaries: Record<string, boolean>`，默认全折叠），不做 localStorage 持久化
- 展开按钮风格同心法区（ChevronRight/ChevronDown + text-otter-500）
- 弹窗 Modal 结构（max-h + overflow）不动
- 历史世/当前世摘要均加 `data-testid="session-summary"`（新测试定位用）

## 布局改版：详情弹窗左右分栏（追加）

### 需求（搭档原话）

> 「既然卡片内信息会比较多，我觉得就可以分左右两侧，比如说左侧是身份信息这些，右侧是世代交接。」

### 设计（大獭拍板）

- **顶部形象区保持全宽**：头像 + 名称 + 称号徽章（角色面板 header，不动）
- **下方内容双栏**（桌面）：
  - **左栏 = 身份信息**：属性区（类型/等级/EXP/角色/模型/在线状态/本世启程/创建时间）+ 装备区（武器/技能槽/工具袋/心法）+ 战绩统计
  - **右栏 = 世代交接**：转世履历世数链（含本 PR 前述摘要折叠）
- **移动端降级**：单列堆叠，左栏内容在上、世代交接在下（配合 #465 全屏抽屉模式）
- Modal width 维持 580px 不动：内容区 540px，双栏各 ~260px，属性格子/装备槽不挤
- 滚动行为不变：沿用 Modal 整体滚动（max-h + overflow-y-auto），不搞栏内独立滚动

### 实现要点

- 容器：`grid grid-cols-1 sm:grid-cols-2 gap-5 items-start`（`data-testid="detail-columns"`），两栏分别为 `detail-column-identity` / `detail-column-generations` 的直接子节点
- **断点选 `sm:`（640px）而非 `lg:`**：与 Modal fullScreenOnMobile 的 639px 断点严格互补——<640px 必然全屏抽屉单列堆叠，≥640px modal 定宽 580px 双栏生效；不存在「全屏抽屉却分栏 / 定宽弹窗却单列」的矛盾中间态，640~1024px 分屏/小平板窗口也能享受双栏
- **纯容器重排，内容块内部 JSX 零改动**：属性格子、装备槽、世数链卡片内部结构原样搬入两栏，降低身份证系列组件回归面
- 间距基线：原各内容块的 `mb-5` 移除，改由左栏 `space-y-5` 统一管理（与双栏 gap-5 同步）；形象区 `mb-5` 保留
- `items-start`：右栏（多世海獭）可能远长于左栏，避免 grid 默认拉伸左栏背景高度

### 布局测试（jsdom 限制下的 className 断言，布局行为测试由 #483 跟踪）

新增用例（Modals.test.tsx，总数 3→4）：

4. 双栏结构：`detail-columns` 存在、恰好两栏直接子节点（identity / generations）、
   容器含 `grid-cols-1`（移动端单列回退）+ `sm:grid-cols-2`（桌面双栏）；
   右栏含「转世履历」、左栏含「类型」且不含「转世履历」（内容归位断言）

## 边界（不改的东西）

- 不改 OtterProfileCard（hover 快览卡）——身份证系列的组件，未受本回归影响
- 不动称号/等级/EXP 逻辑、不改后端
- 仅触碰 RightPanel.tsx / Modals.tsx / Modals.test.tsx（新增）

## 测试

### 新增：`web/src/pages/conversation/Modals.test.tsx`（3+1 用例）

1. 历史世摘要默认折叠（`line-clamp-3` 类存在）+ 当前世摘要完整展示（无 clamp 类，`前情：` 前缀保留）
2. 点击「展开」后历史世摘要移除 clamp 类、全文可见，按钮切换为「收起」
3. 当前世摘要无展开按钮，仅历史世有切换按钮

（fetchOtterProfile mock reject——聚焦 props.sessions 世数链渲染，profile 区不加载）

### 既有：`RightPanel.test.tsx` 模型 badge 4 用例

渲染 / 不渲染（含 undefined 字面串防御）/ 未知 alias 原样渲染 / 大獭 badge 共存——修复后全绿，`data-testid` 语义不变。

### 自检结果（实现者自报）

- `npm test`（web）：23 files / **185 passed**（含新增 3 例）
- `npm run build`（tsc --noEmit + vite）：通过
- CI 项（web ci + build + test）本地等效执行通过

### 布局改版后自检（追加）

- `npm test`（web）：23 files / **186 passed**（原 185 + 布局用例 1）
- `tsc --noEmit`：通过
- #480 既有 7 用例（Modals 3 + RightPanel 4）断言语义未变、全绿

## 验证

- [x] web 全量测试绿（185/185）
- [x] tsc + vite build 通过
- [x] CI 绿（PR #480，run 32928734778 rerun 后 pass；首跑失败为后端 flaky 时序测试 #481，与本 PR 无关）
- [ ] 对抗审视通过（异体检视獭，由大獭编排）
- [ ] 搭档终审
