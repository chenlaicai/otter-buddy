---
id: F20260910wrev
title: 工作区文件右键菜单在本机文件管理器中显示
summary: 工作区文件右键菜单 → 在本机文件管理器中显示
change_type: feature
capability_test: "n/a: 纯 A 类代码逻辑变更（后端端点 + 前端 UI），无 LLM 行为参与"
created_in_conversation: acf4e2d3-d0ae-4e93-90d8-a9d1f1f602b1
---

# 工作区文件右键菜单 → 在本机文件管理器中显示

## 背景（意图锚）

搭档原话：「海獭们会创建一些文件在工作区，然后我期望说，有时候我要把文件发给别人，所以我期望能在 ui 上右键某一个工作区文件，然后有一个选项就是打开本机的文件系统（比如当前 mac 就是访达，然后展示该文件所在的目录」

现状：右侧栏 WorkspacePanel 已有工作区文件树（懒加载、选中预览），文件节点 TreeFileNode 是 button，只有左键点击选中预览，没有右键菜单。

## 方案设计

### 后端

新增 `POST /api/conversations/:id/workspace/reveal` 端点：

- **入参**：`{ path: string }`（相对于工作区根目录的路径）
- **校验**：拒绝绝对路径、含 `..` 或 `.` 段的路径；statFile 验证目标存在（内部走 gateway 的 resolveSafe，含 symlink 逃逸检测）
- **平台适配**：`process.platform` 分发
  - macOS: `open -R <absolutePath>`（Reveal in Finder）
  - Windows: `explorer /select,<absolutePath>`
  - Linux: `xdg-open <parentDir>`（无原生 reveal，退化为打开所在目录）
- **进程管理**：`spawn` detached + unref，不阻塞响应；子进程 error 事件记日志不 throw
- **错误处理**：路径非法 → 400；文件不存在 → 404；工作区不存在 → 404

### 前端

WorkspacePanel 文件节点增加右键菜单：

- 右键 TreeFileNode → `preventDefault + stopPropagation` → 弹出 fixed 定位菜单
- 菜单项「在文件管理器中显示」（ExternalLink 图标 + 文案）
- 点击菜单项 → POST reveal API → 失败时显示错误横幅（复用现有 error state）
- 关闭机制：点击其他区域关闭（fixed 蒙层 z-40，菜单 z-50）
- 样式：仿 index.tsx ctxMenu 模式（glass-overlay rounded-2xl）

### 架构分层

- **UseCase** (`ManageWorkspace`)：路径校验 + 平台命令组装 + spawn
- **Controller** (`WorkspaceController`)：UUID 校验 + body 解析 + 错误映射
- **Router**：POST 注册（workspace 路由组内）
- **Bootstrap**：ManageWorkspace 构造时注入 Logger（原有 constructor 增加可选参数）

## 变更清单

| 文件 | 变更 |
|------|------|
| `api-contract/api/workspace.ts` | +WorkspaceRevealRequest/Response DTO |
| `src/usecases/conversation/manage-workspace.ts` | +revealInFileManager + validateRelativePath + spawnReveal |
| `src/interface-adapters/http/controllers/workspace-controller.ts` | +reveal handler |
| `src/interface-adapters/http/router.ts` | +POST reveal 路由 |
| `src/bootstrap/usecases.ts` | ManageWorkspace 构造注入 logger |
| `web/src/pages/conversation/WorkspacePanel.tsx` | +右键菜单 + reveal API 调用 |
| `tests/.../workspace-reveal.test.ts` | +9 个 reveal 端点测试 |

## 测试覆盖

### 后端集成测试（workspace-reveal.test.ts）

| 测试 | 预期 |
|------|------|
| 合法文件路径 | 200 + { ok: true } |
| 子目录文件路径 | 200 |
| 目录路径 | 200 |
| 不存在的文件 | 404 |
| 绝对路径 | 400 |
| 含 .. 的路径 | 400 |
| 缺少 path | 400 |
| 非 UUID conversationId | 400 |
| 不存在的工作区 | 404 |

### 自检结果

- ✅ 后端 tsc --noEmit：0 error
- ✅ 全量测试：248+ files passed
- ✅ reveal 专项测试：9/9 passed
- ✅ eslint：0 error（仅存量 warnings）

## 最简实现检查

已过最简检查：
- 后端用 `child_process.spawn` 直接执行平台命令，无额外依赖
- 前端复用现有 glass-overlay + fixed 蒙层模式，无新组件库
- 路径校验复用 gateway 的 statFile（内部 resolveSafe），不重复实现

## 验证

- 能力测试：n/a（纯 A 类代码，无 LLM 行为）
- 视觉变更：右键菜单渲染（待浏览器手动验证或截图证据）
