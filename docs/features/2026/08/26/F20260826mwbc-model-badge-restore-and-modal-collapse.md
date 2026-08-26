---
id: F20260826mwbc
title: 模型 badge 归位与详情弹窗世数链摘要折叠
summary: |
  修复身份证系列重构（#450/#458/#465）引入的两个前端回归/体验问题：
  1) 参与者卡片模型 badge 被挤到玻璃卡片外（视觉隐形），挪回卡片内部右侧
  badge 行恢复 #445 原视觉；2) 详情弹窗世数链长前情摘要全文渲染撑爆垂直
  空间，历史世摘要默认 line-clamp-3 折叠 + 展开/收起切换，当前世保持完整。
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

## 边界（不改的东西）

- 不改 OtterProfileCard（hover 快览卡）——身份证系列的组件，未受本回归影响
- 不动称号/等级/EXP 逻辑、不改后端
- 仅触碰 RightPanel.tsx / Modals.tsx / Modals.test.tsx（新增）

## 测试

### 新增：`web/src/pages/conversation/Modals.test.tsx`（3 用例）

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

## 验证

- [x] web 全量测试绿（185/185）
- [x] tsc + vite build 通过
- [x] CI 绿（PR #480，run 32928734778 rerun 后 pass；首跑失败为后端 flaky 时序测试 #481，与本 PR 无关）
- [ ] 对抗审视通过（异体检视獭，由大獭编排）
- [ ] 搭档终审
