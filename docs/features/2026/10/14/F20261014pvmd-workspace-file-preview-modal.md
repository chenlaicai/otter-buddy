---
id: F20261014pvmd
title: 工作区文件点击弹窗预览（md/html/图片）
summary: WorkspacePanel 点击文件从内联预览改为 Modal 弹窗展示；图片类二进制经契约 base64 编码字段返回，双端 tsc 锁死漂移
change_type: feature
capability_test: "n/a: 纯 UI 渲染分发 + API 编码路径变更，无 capability 场景；验证靠组件测试 + HTTP 集成测试 + Playwright 真机截图"
intent:
  problem: "工作区文件点击后在窄面板内联预览，看大文件体验差，且图片等二进制经 utf-8 强制读出乱码"
  expected_effect: "点击文件弹出 Modal 预览（md/html/图片分渲染器），图片经 base64 编码正确显示，Escape/遮罩可关闭"
  verify_by:
    type: behavior_check
created_in_conversation: 9107310c-1653-4495-a6e9-0df86e664448
created_at: 2026-10-14
tags: [workspace, web, ui, modal]
modules: [web, conversation]
---

# 工作区文件点击弹窗预览（F20261014pvmd）

## 背景

现状：WorkspacePanel 点击文件后在面板底部内联渲染 FileContentViewer（md→ReactMarkdown、html→sandbox iframe、其他→pre）。右栏 aside 空间窄，看大文件体验差。

目标：点击文件弹出 Modal 展示，支持 md / html / 图片三种预览形态。

## 变更内容

### 前端（web/src/pages/conversation/WorkspacePanel.tsx）

- 内联 FileContentViewer 删除，替换为 FilePreviewModal（复用 components/Modal.tsx，Escape 关闭、焦点管理、portal 挂 body、z-[100]、fullScreenOnMobile 全内置）
- Modal 内渲染分发：
  - .md/.markdown → ReactMarkdown（复用现有 MarkdownRenderer）
  - .html/.htm → sandbox iframe（复用现有 HtmlRenderer）
  - 图片（png/jpg/jpeg/gif/webp/bmp/svg）→ 新增 ImageRenderer：居中 `<img>`，maxHeight 70vh
  - 其他 → PlainRenderer
- 弹窗宽度：图片/md 860px，html/其他 720px
- 图片 data URL 组装：`data:image/{MIME};base64,{content}`，MIME 由 `IMAGE_MIME_MAP` 映射表给出（jpg/jpeg→jpeg、svg→svg+xml）
- Modal 由组件内部 portal 挂 document.body（Modal.tsx 内置，无需外层 portal；脱离右栏 aside.glass 的 backdrop-filter containing block）

### 契约（api-contract/api/workspace.ts）

- `WorkspaceFileContent` 新增可选字段 `encoding?: 'base64'`（缺省 = utf-8 文本，向后兼容）
- 新增导出常量 `WORKSPACE_IMAGE_EXTENSIONS`（图片扩展名单一真相源，前后端共享）

### 后端

- `src/usecases/ports/workspace-gateway.ts`：接口新增 `readFileBuffer`（二进制安全读取）
- `src/frameworks/file-system/node-workspace-gateway.ts`：实现 `readFileBuffer`（复用 resolveSafe 路径安全 + 1MB 上限）
- `src/usecases/conversation/manage-workspace.ts`：`readFile` 按扩展名判断——图片类走 `readFileBuffer` 返回 base64（encoding: 'base64', truncated: false），文本路径行为完全不变（truncated 逻辑只适用文本）

### 测试

- 前端 WorkspacePanel.test.tsx：重写渲染分发测试为 Modal 形态（断言挂 document.body 的 dialog），新增图片 base64 → img data URL 用例、Escape 关闭、遮罩点击关闭；检视处置后新增 jpg MIME / svg MIME / 无点文件名不误路由 3 用例
- 后端 workspace-api.test.ts：新增图片返回 base64 用例（真实 PNG 头字节验证二进制不乱码）、扩展名大小写不敏感、非图片不返回 encoding 字段；检视处置后新增无点文件名不误路由用例

## 设计取舍

### 机制识别检查点（动手前判定）

逐项检查：
- □ 新增配置字段/枚举/开关 —— 未命中（encoding 是 DTO 可选响应字段，非配置）
- □ 新增状态生命周期 —— 未命中
- □ 新增定时任务/后台进程 —— 未命中
- □ 新增信号类型/消息格式 —— 未命中
- □ 新增持久化存储 —— 未命中
- □ 新增决策分支（结果被记住并影响后续行为）—— 未命中（扩展名判断是纯运行时分支，结果不持久化）
- ☑ 新增跨模块调用路径 —— **命中**（gateway 新增 readFileBuffer 方法，usecase 调用它）

**判定**：命中「跨模块调用路径」，但走修法决策树①（既有机制语义内修）——`readFileBuffer` 是既有 `readFile` 的二进制对偶，同属 WorkspaceGateway 文件读取语义，不引入新机制类别。论证：它不是新机制，是既有 readFile 机制对二进制数据的自然延伸（此前 utf-8 硬编码是缺陷而非设计）。

### 契约 DTO 加字段 vs 独立 raw endpoint

对比两个方案：
1. **DTO 加 encoding 字段（选中）**：改动集中在既有 endpoint，前端 fetch 逻辑不变；DTO 可选字段向后兼容；双端 tsc 锁死；三侧改动各 1 处
2. **独立 /workspace/file/raw endpoint**：需要新路由 + 新 controller 方法 + 前端额外 fetch 分支 + Content-Type 管理（svg 需 image/svg+xml，png 需 image/png……）；endpoint 数量 +1

选方案 1：改动面更小、无 Content-Type 分发负担、与 issue #558 契约单一真相源纪律一致。raw endpoint 的优势（大文件流式、浏览器原生缓存）在 1MB 上限 + 弹窗预览场景用不上。

## 验证

### 最简实现检查

已过：复用现有 Modal / ReactMarkdown / sandbox iframe / PlainRenderer，新增代码仅 ImageRenderer（~15 行）+ 后端 readFileBuffer（~10 行）+ 契约字段。无新依赖、无新 endpoint、无新组件库。

### 测试

- 后端全量：5506 passed, 6 skipped（365 文件）
- 前端全量：688 passed（68 文件）
- 双端 tsc --noEmit：0 错误

### 真机截图（Playwright + Chromium，1440×900）

alpha 实例（port 3158，独立数据根）+ vite dev（port 5199，VITE_API_TARGET 指向 alpha）：

| 文件 | 截图 | 关键数值（getBoundingClientRect） |
|---|---|---|
| doc.md | screenshots/md-modal.png | dialog 860×294，title「doc.md」，ReactMarkdown 渲染完整 |
| page.html | screenshots/html-modal.png | dialog 720×303，iframe 678×200，sandbox 渲染正常 |
| chart.png | screenshots/image-modal.png | dialog 860×263.5，img 200×120 居中，src=data:image/png;base64,... |

截图路径前缀：/Users/orca/ai/otter-buddy/data/workspaces/9107310c-1653-4495-a6e9-0df86e664448/

回归断言：关闭 Modal 后面板内无内联预览残留（inlineGone: true）。

### 负面向验收

本次变更破坏了什么旧契约？无破坏性变更——encoding 是可选字段，旧前端（忽略 encoding）对图片会收到 base64 字符串显示乱码，但前后端同版本部署，不构成兼容承诺破坏。内联预览被 Modal 替换，旧「面板底部内联展示」行为不再存在（这是特性目标本身）。
