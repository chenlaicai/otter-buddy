---
id: F20260916cmpt
title: 工作区右键菜单 Portal 化：修复 backdrop-filter containing block 致菜单飞出视口
summary: F20260916scfx 的 mousedown 拦截在搭档 Safari 26 实机上「拦截成功、菜单 DOM 弹出、但眼睛看不见」——探针实测菜单 left=3130 飞出视口（右键 x=1605）。根因：右栏 aside.glass 带 backdrop-filter，按 CSS 规范成为 containing block，后代 position:fixed 退化为相对 aside 定位。修法：右键菜单 createPortal 挂 document.body。
change_type: fix
capability_test: n/a（纯前端定位修复，测试覆盖在 WorkspacePanel.test.tsx：菜单 portal 到 document.body + 不再渲染在面板容器内的回归断言）
created_in_conversation: acf4e2d3-d0ae-4e93-90d8-a9d1f1f602b1
tags: [web-ui, safari, bugfix, contextmenu, workspace, css-containing-block]
modules: [web/src/pages/conversation/WorkspacePanel.tsx, web/src/pages/conversation/WorkspacePanel.test.tsx]
from: [F20260916scfx, F20260910wrev]
---

## 背景（意图锚）

F20260916scfx（PR #972）修复了 Safari 26 不尊重 contextmenu preventDefault 的问题（mousedown 阶段兜底拦截），搭档实机验证后反馈「还是不行」。本对话多轮探针排查（acf4e2d3）逐层定位：

1. **探针1**：chunk 含拦截代码（排除缓存）→ 排除「没部署上」
2. **探针2**：右键目标祖先链 = `SPAN < file-shot-2-conv.png < workspace-tree`——搭档右键的确实是文件节点，selector 匹配正常
3. **探针3**：mousedown 到达、bubble 阶段 `defaultPrevented=true`（**拦截器生效**）、`菜单节点存在: true`（**菜单 DOM 弹出了**）
4. **搭档目视**：菜单完全不可见
5. **探针4（终审）**：菜单 rect `left=3130 top=315 w=150 h=52`，右键坐标 (1605, 242)，窗口宽 1792——**菜单飞出视口右缘 1300+ px**；样式一切正常（display=block, opacity=1, 文字在）

## 根因

菜单用 `position: fixed` + `style={{left: ctxMenu.x, top: ctxMenu.y}}` 定位，意图是相对视口。但右栏容器 `<aside class="glass">`（RightPanel.tsx:88）的 `.glass` 类带 `backdrop-filter`（globals.css:192-199）——按 CSS 规范，**带 backdrop-filter 的祖先会成为 containing block**，后代所有 fixed 元素退化为相对该祖先定位。

数字验证：菜单实际 left=3130，减去 aside 左缘约 1525 ≈ 1605，正是右键 clientX——菜单「定位正确」，只是参照系错了。

**为什么此前所有验证都没抓到**：
- 左栏对话列表右键菜单（index.tsx:1460）渲染在根容器（不在 glass aside 内），所以一直正常
- 凌晨无头 Chromium 验证时右侧栏关闭（该对话 workspace 为空），菜单根本没机会在 aside 内渲染
- jsdom 测试无布局引擎，fixed 定位问题天然免疫

## 修法

右键菜单（蒙层 + 菜单本体）改用 `createPortal` 挂 `document.body`，脱离 aside 的 containing block——与项目内既有模式一致（Modals、RightPanel hover 卡均走 Portal）。

React Portal 事件冒泡仍走 React 树，蒙层 onClick 关闭逻辑不受影响。

**不改架构**：不移除 aside 的 backdrop-filter（玻璃拟态是全 UI 语言），只把需要视口定位的弹层 Portal 化。

## 改动明细

| 文件 | 改动 |
|---|---|
| web/src/pages/conversation/WorkspacePanel.tsx | import createPortal；右键菜单 JSX 包入 `createPortal(…, document.body)` + Why 注释 |
| web/src/pages/conversation/WorkspacePanel.test.tsx | 3 处菜单断言从 `container.querySelector` 改为 `document.querySelector`；新增回归断言「菜单不再渲染在面板容器内」 |

## 测试覆盖

| 测试 | 预期 |
|---|---|
| 存量 12 项（含 Safari mousedown 兜底 2 项） | 通过 |
| 右键菜单弹出（改为断言 document.body 内） | 通过 |
| 菜单不渲染在面板容器内（新增回归断言） | 通过 |

## 自检结果

- ✅ WorkspacePanel.test.tsx 14/14 通过
- ✅ eslint 0 error
- ✅ vite build 成功

## 验证

- 能力测试：n/a（纯前端定位修复）
- 视觉/行为验证：搭档 Safari 26 实机复测（PR 预览/合入后）——本轮探针数据已证明 DOM/事件/样式链路全通，唯一缺陷就是定位参照系，Portal 化后菜单将出现在右键位置
- 已知残留：右栏内其他「fixed 定位 + 相对 clientX/clientY」的弹层（如有）同样受此 containing block 影响——本 PR 只修工作区右键菜单，其他按同模式遇到再修
