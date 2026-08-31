---
id: F20260831wsui
title: Modal桌面端高度回归修复与工作区树形结构升级
doc_type: feature

# 记忆索引
summary: |
  Modal 桌面端高度回归修复 + WorkspacePanel 树形结构 + 内容渲染升级。
  Modal 回归根因：8/27 #512 token 化重构时条件式置 undefined，fullScreenOnMobile=true 的海獭面板
  桌面端 maxHeight 无约束。恢复恒给语义（dialog 层 var(--modal-scroll-max-h)，content 层
  var(--modal-content-max-h)），窄屏 100dvh 由 CSS !important 兜底。
  WorkspacePanel 升级：扁平导航改为树形（chevron 展开/收起、懒加载目录、文件夹在前排序）；
  内容渲染：.md/.markdown → ReactMarkdown（GFM），.html/.htm → sandbox iframe，
  其他 → 等宽 pre。移除面包屑导航。

# 因果链路
causal_links:
  from: [F20260826pfix]

# 元数据
status: development
change_type: fix
capability_test: "n/a: 纯前端 UI 组件变更，无 LLM 参与行为；验证走 web 单测（vitest）+ 浏览器手动验证内容渲染"
tags: [web-ui, bugfix, modal, workspace, tree, react-markdown, iframe]
modules: [web/src]

# 时间
created_at: 2026-08-31
created_in_conversation: f8bf2fbe-6da0-4861-8f48-9ccb27f50c07
---

## 变更说明

### Modal 桌面端高度回归修复

**根因**：8/27 #512（commit eafc078a）token 化重构时将 Modal dialog 层的 maxHeight 改为条件式：
`fullScreenOnMobile ? undefined : 'var(--modal-scroll-max-h)'`。海獭面板 OtterDetailModal
是唯一使用 `fullScreenOnMobile=true` 的组件，导致桌面端弹窗零高度约束。

**历史链**：
- 8/26 #503 修过此问题（恒给 80vh）
- 8/27 #512 token 化时回归
- 8/28 #480 双栏改版后内容更长，暴露更彻底

**修复**：
- dialog 层：`maxHeight: 'var(--modal-scroll-max-h)'`（不再条件置 undefined）
- content 层：`maxHeight: 'var(--modal-content-max-h)'`（同上）
- 窄屏全屏抽屉由 CSS `@media (max-width: 639px)` 的 `!important` 100dvh 兜底（globals.css:397-413）

### WorkspacePanel 树形结构 + 内容渲染升级

**现状**：#554 交付的扁平导航（点目录替换列表 + 面包屑返回），文件内容纯 `<pre>` 文本。

**升级**：
1. **树形结构**：递归 TreeNode 组件，文件夹 chevron 展开/收起，懒加载子目录，文件夹在前排序
2. **内容渲染**：
   - `.md` / `.markdown` → ReactMarkdown（GFM，复用项目已有 remark-gfm 依赖）
   - `.html` / `.htm` → iframe sandbox="" srcDoc（安全：禁 script/禁跳转/禁同源）
   - 其他 → 等宽 pre（100KB 截断提示保留）
3. **移除面包屑导航**（树形结构下冗余）

## 验证

- 浏览器手动验证：桌面端打开海獭面板 + 展开工具袋 + 多世海獭长摘要 → 弹窗 ≤80vh 内容区可滚 footer 可达
- 窄屏（<640px 视口）仍是全屏抽屉
- 工作区树形展开/收起、懒加载、排序、缩进层级均正确
- 内容渲染：.md 文件显示格式化文本，.html 文件显示渲染效果，其他文件显示等宽文本

**最简实现检查**：已过最简检查。Modal 修复仅改 2 行条件式为恒值；WorkspacePanel 使用项目已有 react-markdown/remark-gfm 依赖，无新增依赖。
