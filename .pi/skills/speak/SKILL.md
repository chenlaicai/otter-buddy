---
name: speak
description: 回合交接。调用 speak 结束你的回合，系统自动叫下一个人发言。
---

# speak

## 用法

调用 `speak(body, talkingStonePassedTo)` 结束你的回合。

- **body**：你的最终答复（Markdown 格式，不能为空）
- **talkingStonePassedTo**：下一个发言者的 ID 数组（不能包含自己）

## 判断传给谁

- 回答完用户 → 传 `user`
- 对话需要继续 → 传给对方参与者
- 先调 `get_active_participants` 查看在场成员

## 规则

- 每次回复只调用一次
- 调用后停止生成（系统自动接力）
- 不传给自己
