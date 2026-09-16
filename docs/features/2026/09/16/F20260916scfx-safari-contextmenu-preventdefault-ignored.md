---
id: F20260916scfx
title: Safari 26 右键原生菜单拦截失效修复（工作区 reveal 菜单）
summary: Safari 26 不尊重 contextmenu 的 preventDefault 致右键菜单不可达，改在 mousedown 阶段兑底拦截 button===2
change_type: fix
status: implemented
tags: [web-ui, safari, bugfix, contextmenu, workspace]
modules: [web/src/pages/conversation/WorkspacePanel.tsx, web/src/pages/conversation/WorkspacePanel.test.tsx]
from: [F20260910wrev]
supersedes: []
created_in_conversation: acf4e2d3-d0ae-4e93-90d8-a9d1f1f602b1
---

# Safari 26 右键原生菜单拦截失效修复（工作区 reveal 菜单）

## 背景（意图锚）

搭档反馈：9/10 合入的「工作区文件右键 → 在文件管理器中显示」（F20260910wrev, PR #888）在自己机器上「根本没有这个能力」——右键文件弹的是 Safari 原生菜单（返回/重新载入/存储图像…），我们的自定义菜单不出现。

排查时间线（2026-09-16 上午，本对话）：

1. 代码、路由、构建产物全链路验证在位；后端 `POST /workspace/reveal` curl 实测 200
2. 无头 Chromium 实测：右键菜单正常弹出（截图留证 shot-4）——排除代码缺失
3. 搭档截图：弹出的是浏览器原生菜单 → 锁定 preventDefault 未生效；搭档环境为 **Safari 26.6.2**
4. 最小复现（file:///tmp/ctx-test.html / ctx-test2.html，搭档手测）：
   - `target listener fired, defaultPrevented(before)=false`
   - `handler fired, preventDefault called`
   - `window saw event, defaultPrevented=true`
   - **但原生菜单依然弹出** —— Safari 26 的 contextmenu 事件能派发、preventDefault 标记成功，浏览器却不尊重，原生菜单照弹（Chromium 无此问题）

根因：**Safari 26（WebKit 21624）不尊重 contextmenu 事件的 preventDefault**（至少对 button 元素、React 19 root 委托场景如此）。React 19 把 onContextMenu 委托挂在 root 容器上，拦不住 Safari 原生菜单。

## 方案设计

在 mousedown 阶段拦截 `button === 2`（右键按下），抢在浏览器默认行为链之前 preventDefault：

- 挂载点：WorkspacePanel 根 div 的原生 listener（useEffect + ref），不用 React 委托
- 拦截范围收窄：仅当事件 target 在树节点（`[data-testid^="file-"]` / `[data-testid^="folder-"]`）内才 preventDefault，面板其他区域右键不受影响（后续预览区要做右键复制等不冲突）
- 与现有 onContextMenu 并存：React handler 继续负责弹出我们的菜单；mousedown 拦截只负责压制 Safari 原生菜单，Chromium 上无害（双保险）
- 文件夹节点一并覆盖（顺手补上 F20260910wrev 时只挂文件节点的缺口——拦截层不分文件/文件夹，菜单弹出仍由 onContextMenu 决定，本 PR 不改菜单挂载范围）

## 改动明细

| 文件 | 改动 |
|---|---|
| web/src/pages/conversation/WorkspacePanel.tsx | +panelRef +useEffect mousedown 兜底拦截（含 Why 注释）；根 div 挂 ref |
| web/src/pages/conversation/WorkspacePanel.test.tsx | +2 测试：树节点 mousedown(button=2) 被 preventDefault；非树节点区域不拦截 |

## 测试覆盖

| 测试 | 预期 |
|---|---|
| 右键文件节点弹出菜单（存量） | 通过 |
| 点击菜单项调用 reveal API（存量） | 通过 |
| reveal 失败显示错误横幅（存量） | 通过 |
| Safari 兜底：文件节点 mousedown(button=2) defaultPrevented=true | 通过（新增） |
| Safari 兜底：非树节点区域 mousedown(button=2) defaultPrevented=false | 通过（新增） |

## 自检结果

- ✅ WorkspacePanel.test.tsx 12/12 通过
- ✅ eslint 0 error
- ⚠️ web tsc 存在存量错误（globals.css side-effect import / scrim-flicker-6.test.ts 缺 node types），与本改动无关，主仓 main 上同样存在

## 最简实现检查

已过最简检查：一个原生 listener + 一个 ref，无新依赖、无新组件；拦截范围收窄到树节点，不影响面板其他交互。

## 验证

- 能力测试：n/a（纯前端行为）
- 视觉/行为验证：Chromium 无头实测右键菜单仍正常（不回归）；Safari 26 实机验证待搭档在 PR 预览/合入后确认（本地最小复现已证明 mousedown 阶段拦截是 Safari 唯一尊重的拦截点）
- 已知残留：LeftPanel 对话列表右键菜单（#616）同样依赖 contextmenu preventDefault，Safari 26 上预计同样失效——本 PR 不动，建议后续按同模式统一兜底（issue 待建）
