---
id: F20260929sqmk
title: Safari 26 右键原生菜单拦截失效修复（LeftPanel 对话列表）
summary: LeftPanel 对话列表右键菜单同款 Safari 26 contextmenu preventDefault 失效，照 F20260916scfx 模式在 mousedown 阶段兜底拦截 button===2，收窄到对话项节点
change_type: fix
status: implemented
capability_test: "n/a: 纯前端事件拦截行为，jsdom 组件测试覆盖（LeftPanel.test.tsx 29/29），无后端/框架软代码面"
tags: [web-ui, safari, bugfix, contextmenu, left-panel]
modules: [web/src/pages/conversation/LeftPanel.tsx, web/src/pages/conversation/LeftPanel.test.tsx]
from: [F20260916scfx]
supersedes: []
created_in_conversation: 3241317b-99d6-4d78-9248-ff208a7461bc
---

# Safari 26 右键原生菜单拦截失效修复（LeftPanel 对话列表）

## 背景（意图锚）

issue #982（明日到 14 天 stale 线，本 PR 闭环）：LeftPanel 对话列表右键菜单（#616 引入，
conversation 页 index.tsx 的 `handleContextMenu` + LeftPanel.tsx 的 `onContextMenu`）依赖
contextmenu 事件的 preventDefault 压制原生菜单——与 F20260916scfx（PR #972，工作区文件
右键菜单）同款失效：**Safari 26 不尊重 contextmenu 的 preventDefault**（事件派发、
defaultPrevented=true，但原生菜单照弹，搭档手测确认）。

F20260916scfx 的「已知残留」明确预留了本修复路径：LeftPanel 同样依赖 contextmenu
preventDefault，按同模式统一兜底。

## 方案设计

照 PR #972 模式，在 mousedown 阶段拦截 `button === 2` 抢在浏览器默认行为链之前
preventDefault：

- 挂载点：LeftPanel 根 `<aside>` 的原生 listener（useEffect + ref，空依赖数组），不用 React 委托
- **拦截范围收窄到对话项**：仅当事件 target 在 `[data-conv-item]` 节点内才
  preventDefault；面板其他区域（搜索框、分组头、页码器、空白区）右键原生菜单保留——
  不能把整个面板的右键全废掉（issue 关键约束）
- 与现有 onContextMenu 并存：React handler 继续负责弹出菜单（mousedown 拦截后
  contextmenu 仍到达 handler，测试为链式断言——但 jsdom 无浏览器默认行为链，仅证
  handler 链路未断；Safari 26 实机「拦截后自定义菜单照弹」的证据来自
  F20260916scfx / F20260916cmpt 实机记录）；mousedown 拦截只负责压制 Safari 原生菜单，
  Chromium 上无害（双保险）
- **testid 统一前缀**：原实现只有置顶高亮项有 testid（`conv-item-pinned-${id}`），普通/
  搜索/归档项无标记，closest 无从匹配。本次统一为 `conv-item-${c.id}` 前缀（置顶项保留
  `conv-item-pinned-` 前缀不变——既有测试依赖）；从散点标记改为
  单一三元表达式，消 TS2783 重复属性。行为拦截锚定 `data-conv-item` 语义标记（与
  testid 命名解耦，检视建议 2），testid 仅作测试选择器
- 菜单渲染位置不变：index.tsx 顶层的 fixed `glass-overlay` 菜单不在 LeftPanel 的
  backdrop-filter 祖先链内，无 F20260916cmpt 的 containing block 飞出问题

## 改动明细

| 文件 | 改动 |
|---|---|
| web/src/pages/conversation/LeftPanel.tsx | +rootRef +useEffect mousedown 兜底拦截（含 Why 注释）；根 `<aside>` 挂 ref；ConversationItem testid 统一 `conv-item-` 前缀 |
| web/src/pages/conversation/LeftPanel.test.tsx | +5 测试：置顶/普通项 mousedown(button=2) 被 preventDefault；分组头、新建按钮、左键三组边界不拦截；contextmenu 事件仍到达 onContextMenu |

## 测试覆盖

| 测试 | 预期 |
|---|---|
| sessionStorage 滚动位置保持（存量 4 组） | 通过 |
| 分组渲染（存量） | 通过 |
| Safari 兜底：置顶/普通对话项 mousedown(button=2) defaultPrevented=true | 通过（新增） |
| Safari 兜底边界：分组头 mousedown(button=2) defaultPrevented=false（原生菜单保留） | 通过（新增） |
| Safari 兜底边界：新建对话按钮 mousedown(button=2) defaultPrevented=false | 通过（新增） |
| Safari 兜底边界：左键（button=0）在对话项上 defaultPrevented=false | 通过（新增） |
| contextmenu 事件仍到达 onContextMenu prop（既有菜单逻辑不受兜底影响） | 通过（新增） |

## 自检结果

- ✅ LeftPanel.test.tsx 29/29 通过（存量 24 + 新增 5）
- ✅ web 全量 vitest 59 文件 602/602 通过
- ✅ web tsc --noEmit 0 error

## 最简实现检查

已过最简检查：一个原生 listener + 一个 ref + 一处 testid 表达式收敛，无新依赖、无新组件；
拦截范围收窄到对话项节点，面板其他交互（左键选择、搜索、分页、归档）不受影响。

## 验证

- 单测：见自检结果（jsdom mousedown defaultPrevented 断言，同 WorkspacePanel.test.tsx 模式）
- Chromium 回归：jsdom 层 contextmenu 事件流不变（既有 contextmenu 测试 + 新增 onContextMenu
  到达断言均过）
- **Safari 26 实机验证待搭档**：合入后右键对话项应弹自定义菜单（非 Safari 原生菜单），
  且加测 **Ctrl+点击对话项**（macOS ctrl+click 语义等价右键；若 Safari 26 对其 mousedown
  报 button=0 则拦截漏过、原生菜单仍弹——检视建议 4，未验证推测，仅列入手测清单）；
  本地最小复现（F20260916scfx）已证明 mousedown 阶段拦截是 Safari 26 唯一尊重的拦截点，
  本修复与其同机制
- 已知残留：暂无。全应用依赖 contextmenu preventDefault 的右键菜单实例共 3 处：
  conversation 页（`conversation/index.tsx`）、conversation-list 页自带菜单
  （`conversation-list/index.tsx:120` 处理 / :268 渲染）与 WorkspacePanel。后两者的菜单
  消费方均复用本 LeftPanel 组件（`conversation-list/index.tsx:9` import），功能上被本
  修复一并覆盖；WorkspacePanel 已由 F20260916scfx 修复。如后续新增右键菜单场景或新增
  LeftPanel 消费方，须同模式挂 mousedown 兜底。
- 拦截选择器约定：行为拦截锚定 `data-conv-item` 语义标记（与 testid 解耦，检视建议 2）。
  **新增对话行渲染路径必须带 `data-conv-item` 属性**，否则 Safari 26 原生菜单静默回归，
  且测试不会报警（除非改动该测试本身）。
