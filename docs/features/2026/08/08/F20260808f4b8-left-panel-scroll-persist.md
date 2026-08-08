---
id: F20260808f4b8
title: F20260808f4b8-left-panel-scroll-persist
summary: "修复左侧对话列表栏在 MPA 整页刷新后滚动位置重置到顶部的 UX 问题。使用 sessionStorage + beforeunload 在页面卸载前保存滚动位置，新页面挂载后恢复。"
status: done
created: 2026-08-08
---

# F20260808f4b8: 左侧栏滚动位置保持

## 问题背景

左侧对话列表栏中点击选择某个对话后，页面整页刷新（MPA 架构）导致左侧栏滚动条跳回顶部，选中的对话不在可视区域内，体验不好——尤其是选中底部对话时。

## 根因分析

项目采用 MPA 架构：点击对话时通过 `window.location.href` 整页跳转。`LeftPanel` 组件在两个页面都挂载（conversation-list 页和 conversation 详情页），整页刷新导致组件重新挂载，滚动容器的 `scrollTop` 重置为 0。

## 方案

### 核心思路

使用 `beforeunload` 事件在页面卸载前自动保存滚动位置到 `sessionStorage`，新页面挂载后恢复。

### 为什么用 `beforeunload` 而非 `handleSelect` 包装

初版方案在 `handleSelect`（点击对话项）中保存滚动位置，但 MPA 架构下有多条导航路径会绕过它：

| 导航路径 | 触发方式 | handleSelect 覆盖 |
|---------|---------|-----------------|
| 点击对话项 | `onSelect` → `window.location.href` | 是 |
| 新建对话 | `window.location.href` | 否 |
| 创建子对话 | `window.location.href` | 否 |
| 归档对话 | `window.location.href` | 否 |
| 置顶/取消置顶 | `window.location.reload()` | 否 |
| 右键菜单跳转 | `window.location.href` | 否 |
| 搜索/记忆链接 | `<a href="/memory">` | 否 |

`beforeunload` 在任何页面卸载前同步触发，自动覆盖全部路径，无需修改父组件。

### 改动范围

仅修改 `web/src/pages/conversation/LeftPanel.tsx`：

1. **`scrollRef`**：用 `useRef` 绑到左侧栏的 `overflow-y-auto` 滚动容器
2. **`beforeunload` 监听器**：`useEffect` 注册 `window.addEventListener('beforeunload', saveScrollPosition)`，卸载时清理
3. **`useEffect` 恢复**：新页面挂载后，从 `sessionStorage` 读取保存的滚动位置，用 `requestAnimationFrame` 在下一帧恢复（确保 DOM 渲染完成），恢复后立即清除

### 设计决策

- **sessionStorage vs localStorage**：选 sessionStorage，tab 隔离且关闭即清除，符合"仅当次会话保持"的语义
- **beforeunload**：同步触发，`sessionStorage.setItem` 在导航开始前完成
- **requestAnimationFrame**：新页面挂载时 DOM 尚未完成渲染，需要在下一帧再设置 scrollTop
- **恢复后清除**：避免影响后续正常导航（如从详情页返回列表页时不应有残留位置）

## Acceptance Test

- [ ] 在左侧栏选中一个靠底部的对话 → 页面跳转后左侧栏滚动位置保持，选中项在可视区域内
- [ ] 在左侧栏选中一个靠顶部的对话 → 页面跳转后位置正常
- [ ] 新建对话 → 页面跳转后左侧栏位置正常（不出现异常偏移）
- [ ] 创建子对话 → 页面跳转后左侧栏位置正常
- [ ] 归档对话 → 页面跳转后左侧栏位置正常
- [ ] 置顶/取消置顶 → 页面刷新后左侧栏位置正常
- [ ] 右键菜单跳转其他对话 → 左侧栏位置正常
- [ ] 从其他页面（如 memory）返回对话页 → 左侧栏位置正常（无残留 sessionStorage）
