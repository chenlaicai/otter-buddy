---
id: F20260831ccnb
title: 收尾清理扩展（工作区+关键资源）+ 子对话死代码删除 + 参与者时间格式统一
doc_type: feature
summary: |
  三项变更：(1) post-merge-cleanup skill 扩展工作区文件清理与关键资源状态流转两步；
  (2) 删除「创建子对话」三处死代码（菜单项、confirmChild 函数、弹窗）；
  (3) 参与者卡片时间格式从 UTC ISO 串改为本地时区格式（复用 fmtTime）。
change_type: refactor
tags: [conversation, cleanup, frontend, skill]
created_in_conversation: c31d47ed-aa34-44d0-b810-cf6b451441bb
---

# F20260831ccnb：收尾清理扩展（工作区 + 关键资源）+ 死菜单排查结论

## 背景
搭档反馈三点：
1. post-merge-cleanup 收尾清理时，应该把「工作区」「关键资源」也清理——多个常用对话的这两处已堆积大量数据
2. 右键对话菜单的「创建子对话」功能早就没有了，系统中已无子对话概念，要求排查
3. 右侧栏参与者卡片里海獭的时间是标准格式（UTC ISO 串），难看懂，应改为当前时区可读时间（与消息一致）

## 任务 2 排查结论（已完成排查，本文档只记录结论，实现归入本 PR 前端部分）
- 后端 `src/` 中无任何「子对话」概念：router.ts 的 conversation 路由无 child/parent 端点，conversation-controller.ts 无相关逻辑
- 前端残留三处死代码：
  - `web/src/pages/conversation/index.tsx:1452` 右键菜单项「创建子对话」（ctxAction('child', ...)）
  - `web/src/pages/conversation/index.tsx:1188-1199` `confirmChild()` 函数（实际调用 `api.createConversation({title})`——普通创建对话，并无父子关系）
  - `web/src/pages/conversation/Modals.tsx:123-143` 「创建子对话」标题弹窗（含「子对话将继承父对话的关键资源」的误导文案）
- 结论：纯死菜单/死弹窗/死函数，直接删除。ctxAction 里 'child' 分支、modal.type === 'child' 相关类型与分支一并清理
- 注意：`Modals.test.tsx` 与 `index.tsx` 相关测试若覆盖了 child 弹窗，需同步更新/删除测试

## 任务 3 排查结论
- 位置：`web/src/pages/conversation/RightPanel.tsx:354` 与 `web/src/components/OtterProfileCard.tsx:60`
- 代码：`activeS.startedAt.split(' ')[1] || activeS.startedAt` —— startedAt 是 ISO UTC 串（如 `2026-08-31T02:59:09.374Z`），`split(' ')[1]` 永远 undefined，fallback 直接裸显示整串 UTC
- 消息列表用 `fmtTime()`（`web/src/lib/utils.ts:16`，格式 `yyyy-MM-dd HH:mm:ss` 本地时区）
- 方案：复用 `fmtTime`（或新增 `fmtTimeShort`：`MM-dd HH:mm` 本地时区——卡片空间小，全格式过长可自行判断，取「与消息展示一致」优先，直接用 fmtTime 也合理）。两处 `split(' ')[1]` 写法全部替换
- OtterProfileCard.test.tsx 中 `startedAt: '2026-08-25 10:00'` 的 fixture 需同步为 ISO 串并断言本地时区格式

## 方案设计（任务 1：收尾清理扩展）
见本文档 §方案设计。

### 目标
1. post-merge-cleanup skill 流程扩展：清理范围在原有「worktree/分支/issue/产物」之上，增加「工作区文件」与「关键资源（linked resources）」
2. 提供数据支持的操作路径：清理时能看到工作区/资源堆积的量级与列表，能按规则归档/删除

### 非目标
- 不改「哪些对话算收尾对象」的判断逻辑（仍以 PR/issue 为锚点）
- 不做资源的状态机重构（active/superseded/archived 流转已存在，复用）
- 不动 archived 对话的工作区（历史归档，删了会破坏可追溯性，除非搭档显式要求）

### 方案
**A. 数据事实（已核）**：
- data/workspaces/ 共 83 个目录 33MB，其中两个巨型工作区（17MB「简历」、13MB「股神」）占大头，内容是截图 PNG（5MB+ 单文件）与临时脚本
- linked_resources 共 279 条：active 205 / archived 69 / superseded 5
- 孯立工作区目录检查：仅 1 个非 UUID 目录（docs/），无「对话已删但工作区残留」的严重孤儿问题
- 结论：工作区堆积的元凶是**会话内临时产物（截图/脚本）没有清理动作**，关键资源堆积的元凶是**收尾流程不覆盖资源状态流转**

**B. skill 流程扩展（.pi/skills/post-merge-cleanup/SKILL.md）**：
- 步骤「清理结构化清理」扩展两步：
  - 工作区：列出本对话工作区文件清单（size 排序），临时产物（截图/脚本/中间生成物）默认建议删除；研究/报告等持久化产物默认保留并提示搭档
  - 关键资源：列出本对话 linked resources（list_artifacts），PR 已合入且资源状态仍 active 的 pr/worktree/branch 类型资源 → 状态流转 archived；fact/file 等记录型资源保留
- 产出表增加「工作区清理报告」与「资源状态流转报告」两行

**C. 工程配套（本 PR 实现，轻量）**：
- 后端补一个只读端点 GET /api/conversations/:id/workspace/stats（文件数/总大小/top N 文件），供收尾清理时展示量级——已存在的 workspace-controller.ts 上追加即可，复用 manage-workspace.ts usecase
- 則不新建前端页面（收尾清理是海獭侧动作，海獭直接 workspace_list/du 评估，前端无需 UI）

### 影响范围
- .pi/skills/post-merge-cleanup/SKILL.md（流程文本）
- src/interface-adapters/http/controllers/workspace-controller.ts、src/usecases/conversation/manage-workspace.ts、src/interface-adapters/http/router.ts、src/bootstrap/*（新端点）
- web/src/pages/conversation/index.tsx、Modals.tsx（任务 2 死代码删除）
- web/src/pages/conversation/RightPanel.tsx、web/src/components/OtterProfileCard.tsx（任务 3 时间格式）
- 测试：Modals.test.tsx、OtterProfileCard.test.tsx、新增端点测试

### 取舍
- C 工程配套做最轻版本（只读 stats 端点）：完全不做工程配套 vs 做重（前端 UI）之间取轻。理由：清理动作本身由海獭在收尾流程执行（读 du/ls 即可），端点仅是给「将来前端展示」留的钩子 + 收尾报告数据源。若审视认为过度设计，可砍掉只保留 skill 文本变更——此点向检视獭标注
- 工作区临时文件判定规则保守：宁可多提示搭档确认，不做激进自动删除——删除不可逆（R1 精神）
- 归档对话的工作区不清理：与「历史特性文档不可变」(F20260831dgim, #615) 的精神一致，历史数据不破坏

### 验证
- 单测：新端点 stats（空工作区/有文件/topN）；fmtTime 替换后的 RightPanel/OtterProfileCard 快照或断言
- 手动验证：右键菜单无「创建子对话」项；参与者卡片时间与消息时间格式一致且为本地时区
- skill 文本变更：lint（writing-skills 的 lint 规则）通过

## 实现记录

### PR #620 变更清单（14 files, +300/-57）

**任务 2：子对话死代码删除（-48行）**
- `Modals.tsx`：删除 ModalState.child 类型、onConfirmChild prop、ChildModal 组件、modal.type==='child' 渲染分支
- `index.tsx`：删除 confirmChild() 函数、ctxAction('child') 分支、右键菜单「创建子对话」项、onConfirmChild prop 传递
- `Modals.test.tsx`：删除两处 onConfirmChild={noop}

**任务 3：时间格式统一（+5行）**
- `RightPanel.tsx:354` / `OtterProfileCard.tsx:60`：`startedAt.split(' ')[1] \|\| startedAt` → `fmtTime(startedAt)`（本地时区 yyyy-MM-dd HH:mm:ss）
- `OtterProfileCard.test.tsx`：fixture startedAt 改 ISO 串 + 新增本地时区时间格式断言

**任务 1：后端 stats 端点 + skill 扩展（+240行）**
- `workspace-gateway.ts`：新增 statFile 抽象方法
- `node-workspace-gateway.ts`：实现 statFile（fs.stat）
- `manage-workspace.ts`：新增 getWorkspaceStats（递归遍历 + 大小统计 + topN 排序）
- `workspace-controller.ts`：新增 getStats 端点，topN clamp [0,50]
- `router.ts`：注册 GET /api/conversations/:id/workspace/stats?top=N
- `workspace-api.test.ts`：8 个 stats 测试（正常统计、空工作区、不存在工作区、topN 限制、非法 ID、top=0/负数/51+ 边界）
- `post-merge-cleanup/SKILL.md`：步骤8（工作区文件清理）+ 步骤9（关键资源状态流转），报告模板同步

### 对抗审视修复（2026-08-31）
检视獭-ccnb 发现 3 个严重问题，已全部修复：
1. **任务 1 主体缺失**：SKILL.md 步骤 8/9 补齐（工作区文件清理 + 关键资源状态流转）
2. **时间测试形同虚设**：OtterProfileCard.test.tsx 新增本地时区时间格式断言（断言 18:00:00 而非 UTC 10:00:00）
3. **topN 负数未 clamp**：workspace-controller.ts 添加 Math.max(0, ...) 下界 + 新增 3 个边界测试

其他修复：PR body 文件名补齐、测试计数修正、rebase onto main

### 测试结果
- ✅ 后端 workspace API 22 tests passed（含 8 个 stats 测试）
- ✅ TypeScript 编译通过（tsc --noEmit exit 0）
- ✅ ESLint 通过（6 warnings 均为存量，0 errors）
- ✅ CI 待运行确认
