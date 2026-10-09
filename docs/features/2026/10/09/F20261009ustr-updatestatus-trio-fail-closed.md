---
id: F20261009ustr
title: updateStatus fail-closed 三仓收尾 + assertUpdated 断言收敛（#1391）
summary: "#1370 族模式收尾：scheduled-task / im-connection / conversation 三仓 updateStatus 对 changes=0 抛错；同时将散点复制 6 处的 fail-closed 断言收敛至公共 helper assertUpdated"
change_type: fix
capability_test: "n/a: DB 回执语义修复，验证走单测（三仓 updatestatus 七用例），无独立 LLM 能力面"
created_in_conversation: 3241317b-99d6-4d78-9248-ff208a7461bc
created_at: 2026-10-09
tags: [db, bugfix]
modules: [scheduled-task, im, conversation, document, healing]
causal_links:
  from: [F20261009dusc]
---

# updateStatus fail-closed 三仓收尾 + assertUpdated 断言收敛（#1391）

## 背景（#1391）

PR #1389（#1385 修复）对抗审视发现：「按 ID 更新单实体、不看 `result.changes`、不匹配静默成功」的 #1370 族模式全仓另有三处残留：

1. `src/frameworks/db/scheduled-task/sqlite-scheduled-task-repository.ts:91-95`——上游 scheduler-service.ts:652,1018,1422
2. `src/frameworks/db/im/sqlite-connection-repository.ts:89-93`——上游无生产调用方（实证：全仓 grep `.updateStatus(` 无 im 路径命中）
3. `src/frameworks/db/conversation/sqlite-conversation-repository.ts:105-112`——上游 manage-conversation.ts:100

## 上游行为核查（动手前，issue 特别提醒项）

**conversation 仓幂等语义核查**：上游 `manage-conversation.archive()`（manage-conversation.ts:92-109）已有双层前置防护——`getById` 不存在抛 `DomainError("not_found")` + `canArchiveConversation` 拦重复归档（已归档再归档抛 validation）。因此 updateStatus 层加 fail-closed **不改变上游幂等语义**，仅在「前置检查与写入之间的删除竞态窗口」触发——正是期望的防静默失败行为。无需保留幂等静默（与 mergeMetadata 的调用方不感知删除竞态语义不同——archive 调用方本就要求实体存在）。

**scheduler-service 三处调用点**：均为「本轮调度的 task 对象在 repo 侧突然查无 ID」= 并发删除竞态。错误传播路径核查：轮询循环 tick 有 catch 兜底（scheduler-service.ts:310-315），once 重试链错误有上游捕获——fail-closed 抛错不会 crash 调度器，落日志告警。

**im-connection**：updateStatus 当前零生产调用方（manage-connection.ts 未调用）——fail-closed 护住未来调用路径，无行为变更风险。

## 修法（narrow-fix + 断言收敛）

### 三仓新修复（照搬 #1383/#1385 模式）

repo 层 `updateStatus` 对 `changes === 0` 抛错（`<实体> 不存在: <id>`）：

- scheduled-task：`scheduled task 不存在` 
- im-connection：`connection 不存在`（附注释说明当前无调用方）
- conversation：`conversation 不存在`（archived 分支，附上游防护说明注释）

### assertUpdated 公共断言收敛

**动机**：fail-closed 两行模式已散点复制 5 处（healing #1370 → feature/research #1385），本次新增第 4/5/6 处——前世决策（PR #1389 处置轮）「第 3 次复制是抽取时机」。新建 `src/frameworks/db/assert-updated.ts` 导出 `assertUpdated(result, entityLabel, id)`，六处统一收敛（3 新 + 3 老改造，老改造纯等价替换：`if (result.changes === 0) throw new Error(...)` → `assertUpdated(result, '<label>', id)`，抛错文案逐字保持）。

**机制识别检查点（动手前判定）**：清单「新增跨模块调用路径」形态命中（新文件被 6 仓 import）——显式论证不涉净新增机制：assertUpdated 是纯函数（无状态、无持久化、无决策记忆——changes 判断是运行时临时分支），六个调用点行为与收敛前逐字节等价（含抛错文案），属既有语义的代码组织收敛，非新机制。判定 narrow-fix（①既有语义内修）。

### 最简实现检查

已过——三仓修复无更简路径（repo 层 fail-closed 是 #1383/#1385 已验证的最小修法）；收敛 helper 是净减重复（6 处 × 2 行 → 1 处定义 + 6 处单行调用）。

## 验证

- 新增三份测试（7 用例）：每仓「不存在 ID 抛错」+「存在 ID 正常更新不回归」，conversation 附「不支持 status 仍按原语义抛错」——7/7 通过
  - `tests/frameworks/db/scheduled-task/sqlite-scheduled-task-repository-updatestatus.test.ts`
  - `tests/frameworks/db/im/sqlite-connection-repository-updatestatus.test.ts`
  - `tests/frameworks/db/conversation/sqlite-conversation-repository-updatestatus.test.ts`
- 修复前行为证据：better-sqlite3 `UPDATE ... WHERE id = ?` 不匹配返回 `changes: 0` 不抛错（#1370 已实证，同族同机制）；fail-closed 用例在修复前代码上必失败（静默成功不抛错）
- 回归：`tests/frameworks/db` + `tests/frameworks/healing` 36 文件 311 用例全绿（含老 3 处收敛后的 healing/document 既有 fail-closed 断言）；`tests/frameworks/scheduler` + `tests/usecases` 107 文件 1505 用例全绿
- tsc --noEmit 干净；eslint 受影响 10 文件零告警
- 旧契约破坏面（负面向验收）：无——老 3 处收敛为等价替换，抛错文案逐字保持；三仓新抛错只落在「原本静默成功」的路径上

## 影响范围与风险

- 行为变更仅一处：三仓 updateStatus 对不存在 ID 从静默成功 → 抛错。上游核查确认无「依赖静默成功」的调用方（见上游行为核查节）
- 风险残留：scheduler-service catch 到 `scheduled task 不存在` 后仅落日志，无自动清理任务引用——竞态窗口极窄（扫描与状态写入间删除），日志告警已满足闭环可见性；若后续发现高频触发再评估自动清理（届时另立 issue）
