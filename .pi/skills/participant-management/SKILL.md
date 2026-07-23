---
name: participant-management
description: 参与者管理。查看在场成员、决定发言石路由。
---

# 参与者管理

## 查询

调用 `get_active_participants` 获取当前对话中所有参与者（名称、ID、类型）。

### 必须查询的场景

1. 决定 `talkingStonePassedTo` 之前
2. 需要确认谁在场时
3. 创建新 Otter 之前（避免重复创建）

## 发言石路由

`speak` 的 `talkingStonePassedTo` 决定谁下一个发言。

- 回答用户 → 传 `user`
- 需要其他参与者接手 → 传其 ID
- 不传给自己
