---
id: F20260803pncv
title: conversation-pinning
doc_type: feature

summary: |
  对话置顶功能：给对话增加 pinned 字段，实现通用置顶。
  排序加 pinned DESC 前缀，置顶对话排在前面。
  Self-Healing 对话创建时自动置顶，unpin 时通过 settings 表判断拒绝（简单保护）。
  前端分组渲染（置顶组 + 普通组），右键菜单置顶/取消置顶。

causal_links:
  from:
    - F20260730heal   # self-healing-system：Self-Healing 对话需要置顶在列表顶部
    - F20260802hybrid # hybrid-architecture：右键菜单操作后整页刷新

status: final
change_type: feature
tags: [conversation, pinning, ui, self-healing]
modules:
  - src/entities/conversation/
  - src/usecases/conversation/
  - src/usecases/healing/
  - src/interface-adapters/http/
  - web/src/

created_at: 2026-08-03
---

# F20260803pncv 对话置顶功能

## 背景

对话列表按创建时间倒序排列，无置顶机制。Self-Healing 对话因最早创建反而排在最后。用户也无法标记重要对话。

## 方案

### 1. 数据层：pinned 字段

`conversations` 表加 `pinned INTEGER NOT NULL DEFAULT 0`。通过现有迁移机制（PRAGMA 检查 + ALTER TABLE）加列。

pinned 是元数据字段，不参与对话状态机，不更新 updated_at。

### 2. 排序

`getAllIds` 排序从 `ORDER BY created_at DESC` 改为 `ORDER BY pinned DESC, created_at DESC`。

### 3. API

- `PATCH /api/conversations/:id/pin` -> `{ status: "pinned" }`
- `PATCH /api/conversations/:id/unpin` -> `{ status: "unpinned" }`

幂等（重复 pin/unpin 不报错），做存在性检查（不存在返回 404，与 complete/archive 一致）。

### 4. Self-Healing 自动置顶 + 简单保护

- **自动置顶**：`ensureHealingConversation` 创建/ensure 已有对话时调用 `manageConversation.pin()`
- **不可取消**：controller 的 unpin 方法查 settings 表 `__self_healing_conversation_id__`，匹配则返回 403
- **启动恢复**：即使被绕过，重启时 ensure 会恢复 pinned

### 5. 前端

- LeftPanel 分组渲染：置顶组在上，普通组在下，置顶对话显示图钉图标
- 右键菜单：普通对话显示"置顶"，置顶对话显示"取消置顶"
- unpin 返回 403 时 toast "系统对话不可取消置顶"
- API client 的 `request()` 附加 HTTP status code 到 Error，前端用 `err.status === 403` 判断

## 关键决策

1. **pinned 是元数据**：不参与状态机，不更新 updated_at，幂等，允许任何状态对话调用 pin。

2. **排序直接改 getAllIds**：IM 等消费者也跟着变，语义上合理（置顶对话在所有端都排前面）。

3. **简单保护不用函数端口**：只有 healing 一种受保护对话，直接在 controller 查 settings 判断。如果将来受保护对话种类增多，再重构为函数端口。

4. **不处理归档 healing 对话的边缘场景**：归档 healing 对话后 settings 仍指向旧 ID，用户 unpin 会被拒绝。但此场景低频（归档 healing 对话本身罕见），且重启后创建新 healing 对话，旧的被挤到下方。不值得为此引入终态清除、no-op 等规则。

## 对抗检视决策记录

经过三轮架构师对抗检视。前两轮发现的 2 个阻断项（存在性检查/幂等性、create INSERT 漏 pinned 列）和重要项（ensure 用 manageConversation.pin、request 附加 status code）已采纳。

第三轮发现的边缘场景（pin 终态对话僵尸置顶、systemPinned 终态不一致、排序分页交互）经评估为过度设计，选择不引入额外规则。理由：核心功能是"加字段+排序"，复杂度应与此匹配。受保护对话种类增多时再演进。
