---
id: F20260828wbrp
title: 右侧栏 tab 化改版与工作区文件浏览
summary: 将右侧栏三大卡片（参与者、关键资源、定时任务）改为顶部图标 tab 切换，新增工作区文件浏览 tab
change_type: feature
status: development
created_in_conversation: f8bf2fbe-6da0-4861-8f48-9ccb27f50c07
modules:
  - web/src/pages/conversation/RightPanel.tsx
  - web/src/pages/conversation/WorkspacePanel.tsx
  - src/interface-adapters/http/controllers/workspace-controller.ts
  - src/usecases/conversation/manage-workspace.ts
  - src/interface-adapters/http/router.ts
  - src/bootstrap/controllers.ts
  - src/bootstrap/usecases.ts
  - src/bootstrap/types.ts
tags:
  - ui
  - frontend
  - react
  - workspace
  - right-panel
capability_test: "n/a: UI 组件变更，通过 vitest 组件测试验证"
---

## 背景与需求

搭档反馈：「你们海獭们说《工作区》，但是我都看不到到底有啥文件」。右侧栏现有参与者、关键资源、定时任务三大卡片并行堆叠，需要一种更紧凑的组织方式。

## 方案设计

### D1. 顶部图标切换条（搭档批准）

aside 顶部一排小图标 tab（参与者 / 关键资源 / 定时任务 / 工作区），同一时刻只激活一个。内容区根据激活的 tab 渲染对应卡片。

- 使用 lucide-react 图标：Users / FileText / Timer / Folder
- 新对话默认 tab = 参与者
- 移动端右侧栏整体抽屉化时 tab 逻辑不变

### D2. 工作区 tab

扁平文件浏览（非树形），支持目录导航和文件预览。

- 点击目录 → 进入子目录（替换当前列表），顶部面包屑提供路径导航和快速跳转
- 点击文件 → 底部预览内容
- 调用后端只读 API：`GET /api/conversations/:id/workspace`（列目录）和 `GET /api/conversations/:id/workspace/file?path=...`（读内容）
- 大文件截断显示（100KB 字节级限制，UTF-8 安全边界），带截断提示

### D3. 后端只读 API

复用现有 WorkspaceGateway（带 resolveSafe 路径穿越防护），新增 ManageWorkspace use case 和 WorkspaceController。

- `GET /api/conversations/:id/workspace?path=`：列出目录条目
- `GET /api/conversations/:id/workspace/file?path=`：读取文件内容
- 文件大小限制：WorkspaceGateway 1MB + 显示层 100KB 截断
- **安全约束**：conversationId 必须为合法 UUID 格式（拒绝含路径分隔符/.. 的值），防路径穿越攻击

### D4. 不做的事

- 不做写操作 API（工作区写仍归海獭 agent 工具）
- 不做 #511 响应式断点体系重构
- 不动三大卡片内容本身的功能逻辑

## 取舍

| 决策 | 选择 | 理由 |
|------|------|------|
| tab 标签文字 | 移动端只显示图标，桌面端显示图标+文字 | 节省移动端空间 |
| 文件大小截断 | 显示层 100KB + 后端 1MB | 平衡完整性和渲染性能 |
| 目录展开策略 | 扁平导航 + 面包屑 | 进入子目录替换列表，面包屑提供路径跳转 |

## 验证

- [ ] 右侧栏顶部有四个 tab 图标
- [ ] 默认显示参与者 tab
- [ ] 点击各 tab 切换内容
- [ ] 工作区 tab 显示文件列表
- [ ] 点击目录可导航
- [ ] 点击文件可预览内容
- [ ] 大文件截断提示
- [ ] 后端 API 正确返回数据
- [ ] 所有现有测试通过
- [ ] 新增测试通过
