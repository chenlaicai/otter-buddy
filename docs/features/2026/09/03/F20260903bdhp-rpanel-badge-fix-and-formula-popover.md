---
id: F20260903bdhp
title: 右侧栏 badge 变形修复与健康面板公式浮窗化
doc_type: feature

# 记忆索引
summary: |
  搭档反馈的两处 UI 修复：
  ① 右侧栏参与者卡变形——model badge（glm-flash 等长 alias）无 nowrap/shrink-0，
  窄卡内被压缩逐字换行致卡片竖向变长；「大獭」badge 与名字行重复（名字固定 +
  副行已有「大獭 · 持久」），移除冗余 badge。
  ② 健康面板两处「?」（综合健康分公式、五维雷达公式）为内联展开（showFormula
  state 把公式块挤进布局，界面被撑动）——改用 HelpIcon Portal 浮窗，对齐
  MagicWordHelp 弹层范式（? = 临时查看语义，不应改变布局）。
  HelpIcon text 从 string 放宽为 ReactNode（雷达公式是结构化列表），
  气泡加 max-h-[60vh] overflow-y-auto 超高保护。全部既有字符串调用点兼容。

# 因果链路
causal_links:
  from: []

# 元数据
status: development
change_type: fix
capability_test: "n/a: 纯前端 UI 组件变更，无 LLM 参与行为；验证走 web 单测（vitest，391 全绿）"
tags: [web-ui, bugfix, right-panel, help-icon, popover, portal, health]
modules: [web/src]
created_in_conversation: af04ad23-2e9d-4e7f-93fb-cc839a45157e
---

# 右侧栏 badge 变形修复与健康面板公式浮窗化

## 背景与需求

搭档原话（意图锚）：

> 「如果 tag 有大獭 + glm flash，整个面板就变形了（竖着变长了、字也乱了）；
> 以及，大獭的名字是固定的，所以后面没必要再显示一个 tag 叫"大獭"」
> 「很多"？"弹出效果都不是浮窗那种，而是挤进去一大块，导致界面会变动……
> 要做成类似于输入框这个问号这种弹窗效果」

定位过程（三处实锤）：

1. **RightPanel 列表卡**：`model-badge` span 无 `whitespace-nowrap`/`shrink-0`，
   flex 容器内长 alias（如 glm-flash）被当作可压缩项逐字换行 → 卡片竖向变长、
   文字错乱。同时「大獭」badge 与名字行信息重复（名字固定 + 副行「大獭 · 持久」）。
2. **健康面板**（`web/src/pages/health/index.tsx`）：综合健康分与五维雷达两处
   `?` 按钮均为 `showFormula` state 内联展开——公式块渲染进布局流，卡片高度跳变。
3. **大獭详情弹窗的 HelpIcon**：#503（F20260826pfix）已 Portal 化，是正确的
   浮窗实现——本次直接复用该组件，不新造轮子。

## 逻辑变更

### ① RightPanel 参与者卡（web/src/pages/conversation/RightPanel.tsx）

- `model-badge` 加 `whitespace-nowrap shrink-0`：badge 整体不换行、不被压缩，
  长alias 保持单行胶囊形态。
- 移除 `isBig` 时渲染的「大獭」badge；小獭解散按钮的 `isBig ? badge : 按钮`
  三元结构简化为 `{!isBig && (按钮)}`。
- 身份信息不丢失：名字行 + 副行「大獭 · 持久」仍完整表达大獭身份。

### ② HelpIcon 放宽（web/src/components/HelpIcon.tsx）

- `text: string` → `text: React.ReactNode`：五维雷达公式说明是逐维度结构化
  列表（dimension 简写 + 名称 + 公式 + 数据源），纯字符串装不下；全部既有
  字符串调用点（OtterDetailModal 6 处）类型兼容，零改动。
- 气泡容器加 `max-h-[60vh] overflow-y-auto`：ReactNode 内容长度不可控
  （维度数 × 公式行），超高时气泡内部滚动而非溢出视口。

### ③ 健康面板公式浮窗化（web/src/pages/health/index.tsx）

- 综合健康分卡：`showFormula` state + 内联 div → `<HelpIcon text="综合分 = Σ…" />`。
- 五维雷达卡：同上，text 传 JSX（公式列表原样迁移，含状态阈值说明行）。
- 两处 `useState(false)`（showFormula）删除，ScoreRadarCard/综合分卡不再有
  展开态——`?` 恢复「临时查看」语义：点开看、点掉没，布局零变动。

## 不改的部分（界定）

- **SignalBadge（獭间信号徽章）**：点徽章展开 payload 正文是「查看内容」语义
  （正文是数据本体，非说明），保持内联展开。
- **MagicWordHelp**：已是 absolute 弹层，行为正确（本次对齐的参照系）。
- **HotspotHeat/TrendSparkline 的点击展开**：图表 sparkline→详情是「钻取」
  语义，内容是图表本体，非临时说明，保持现状。
- **OtterDetailModal 的 6 处 HelpIcon**：#503 已 Portal 化，无需改动。

## 验证

- `npx vitest run`（web 全量）：46 files / 391 tests 全绿。
- `npx tsc --noEmit`：0 错误。
- 测试更新：RightPanel.test.tsx「大獭 badge 与模型 badge 共存」改为
  「冗余 badge 不存在 + 名字/副行信息仍在 + 模型 badge 正常」；新增长 alias
  nowrap 断言、HelpIcon ReactNode 渲染断言。
- 最简实现检查：已过——复用既有 HelpIcon（#503 Portal 成果），唯一新增能力
  是类型放宽（ReactNode）+ 两行 className，无新组件无新依赖。

## Discovered Issues

无。
