---
id: F20260902imsc
title: IM 页滚动修复与双列布局重组 + AppLayout 骨架滚动兜底
summary: IM 页内容超出视口且无滚动条（同类问题第三次现场），根因是 h-screen+body overflow:hidden 骨架下页面忘写滚动容器；本次修复 IM 页并重组布局（微信/飞书双列并排），同时在 AppLayout 骨架层加滚动兜底，系统性消灭"新页面忘写滚动类→内容被裁"这一反复发生的 bug 类。
change_type: fix
status: implemented
capability_test: "n/a: 纯前端 CSS 布局改动（A 类），无 LLM 参与行为"
created_in_conversation: f24a341c-b20f-4676-a79e-57f5e812741c
tags: [web-ui, bugfix, scroll, layout, im, app-layout]
modules:
  - web/src/components/AppLayout.tsx
  - web/src/pages/im/index.tsx
  - web/src/components/AppLayout.test.tsx
---

# IM 页滚动修复与双列布局重组

## 背景

搭档反馈（2026-09-02，本对话）：

> 「我刚才打开im页面，我发现内容太多都超出屏幕了，然后又没有滚动条。这种超出屏幕问题出现两次了，感觉你的ui能力有点弱？另外，感觉内容也会简单的罗列成一列，其实可以好好组织下的吧，飞书与微信本来就是两条im，那可以并排？」

这是同类问题**第三次现场**（前两次均在海獭面板 Modal 上）：

| 时间 | 现场 | 修复 |
|------|------|------|
| 8/26 | 海獭面板 Modal 高度无限长 | #503（maxHeight 80vh 恒给） |
| 8/27 | #512 token 化重构回归 | 8/31 #628 再修（F20260826pfix） |
| 9/2 | IM 页超屏无滚动条 | 本文档 |

IM 页（F20260901chun 昨日交付）单列堆叠三张卡片，内容一多即超屏。

## 根因

布局骨架 `AppLayout` 是 `flex flex-col h-screen` + `globals.css` 中 `body { overflow: hidden }`（为三栏聊天页内部滚动设计）。此骨架下**每个页面必须自己声明滚动容器**——其他 5 个页面都写了 `overflow-y-auto`，IM 页漏了，超出视口的内容被裁掉且无滚动条。

单列堆叠是 F20260901chun 的实现选择，无信息架构组织——微信/飞书是平级的两条 IM，天然适合并排。

## 方案

1. **AppLayout 骨架滚动兜底**（防第四犯的系统性修复）：主内容区包一层 `<div className="flex min-h-0 flex-1 flex-col overflow-y-auto">{children}</div>`。新页面忘写滚动类不再导致内容被裁，零成本获得滚动。
2. **IM 页布局重组**：微信/飞书卡片 `grid gap-6 lg:grid-cols-2 items-start` 双列并排（lg 以下回落单列，防窄屏挤压二维码）；IM 大厅独立一行占满宽（连接数可增长，是主要工作区）；大厅内连接列表 `grid gap-3 md:grid-cols-2` 双列。
3. 画布从 `max-w-4xl` 放宽到 `max-w-6xl`（双列需要更宽画布）。

## 非目标

- 不改各页面已有的显式 `overflow-*` 声明（CSS 显式声明优先于骨架兜底，互不影响）
- 不动 conversation 三栏页（其 `overflow-hidden` 内滚模式保持，`min-h-0` 保证 flex 收缩正常）
- 不重做 IM 大厅功能（只动布局容器类）

## 变更说明

| 文件 | 变更 |
|------|------|
| `web/src/components/AppLayout.tsx` | children 包入滚动兜底容器（flex min-h-0 flex-1 flex-col overflow-y-auto），附 Why 注释 |
| `web/src/pages/im/index.tsx` | 三处布局类：通道卡双列 grid（lg:grid-cols-2 items-start）+ 大厅独立行 + 连接列表双列（md:grid-cols-2）；max-w-4xl→6xl |
| `web/src/components/AppLayout.test.tsx` | 新增：滚动兜底存在性断言 + TopBar 不被滚动容器包裹断言 |

## 验证

1. **单测**：`AppLayout.test.tsx` 3 条通过（滚动容器存在 / TopBar 在滚动区外 / 滚动容器带 overflow-y-auto——检视发现 1 处置后由 2 条扩为 3 条，选择器从 class 组合改为 data-testid + 行为断言双保险）
2. **全量**：web 46 files / 387 tests passed；`tsc --noEmit && vite build` 通过
3. **Playwright 数值断言**（1440x900，dev server 实跑）：
   - 滚动容器 `.h-screen > .overflow-y-auto` 存在，`body overflow: hidden` 之下内容可滚
   - 微信卡 x=185 / 飞书卡 x=757 → 横向并排；IM 大厅 y=617 → 独立成行
4. **视觉核验**（mimo-vision 多模态读截图）：4 项通过——双列并排视觉平级、无错位溢出重叠、大厅独立行、无截断。观察项：微信卡含扫码子卡高约 3 倍于飞书卡（内容量差异，`items-start` 已保证不拉伸，飞书侧内容增长后自然均衡）
5. **最简实现检查**：已过——兜底为一层 div + 4 个 utility class，无新组件无新依赖；双列为 Tailwind 原生 grid 类，零 JS
6. **capability_test**: n/a——纯 CSS 布局（A 类），无 LLM 行为

## 检视与处置

对抗审视（检视獭-IM滚动，mimo，PR #732 review comment）0 严重 + 2 建议，处置：

| 发现 | 处置 | 更好/更差判断
|------|------|----------------
| 1. 测试选择器 `.h-screen > .overflow-y-auto` 锁定实现细节，class 重构会假阳性 | **接受并修复**：AppLayout 加 `data-testid="app-content-scroll"`（项目惯例，health 页同模式），断言改 testid 锚点 + 行为断言（overflow-y-auto class 存在）双保险，并新增第 3 条测试防止 testid 加了但滚动类被误删 | 改了更好：重构 class 不再破坏行为断言
| 2. launchd plist PATH 无关变更混入 PR | **反驳（误报）**：`git diff origin/main...HEAD --stat` 实证 PR 只碰 4 个文件，plist 变更来自 base 提交 304249d6（#724，已在 main），不在本 PR diff 内 | 反驳有据：PR diff --name-only 全量核对

## 备考

- 历史教训链：#503 → #512 回归 → #628 → 本文档（第三次）。本次与前两次的差别：前两次修的是具体组件，本次在骨架层兜底，同类问题不再依赖每个新页面自觉
- 截图证据存工作区 `im-viewport.png` / `im-bottom.png`（本对话 workspace）
