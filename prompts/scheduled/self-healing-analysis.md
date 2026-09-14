---
task_name: self-healing-analysis
dynamic: true
---

## Self-Healing 定期分析任务

{{HEALING_DATA}}

## 处置权检查（前置，#600 口径协议 F20260831whfw）

处置任何 open 事件前，先检查其是否已被其他任务处置过口径：
- 事件关联了 daily-review issue（resolutionNotes 引用 issue 编号 / issue body 内含该事件证据）→ **不重复处置、不推翻**——首个消费它的任务（通常是 9:00 健康检查）拥有处置权；发现其处置存疑时，在对应 issue 评论说明，**不改事件状态**
- **原子性兑底**：若事件仍 open 但 `created_at` 时间早于今日 09:00 且无 resolutionNotes，先查今日 daily-review open issue 的 body 是否含该事件的 messageId（事件证据）→ 命中说明 9:00 任务已写入证据但 resolve 失败，在对应 issue 评论注明后**由本任务代为 resolve**（resolutionNotes 引用 issue 编号 + 代resolve说明）→ 无命中则按下方步骤正常处置
- 无关联 issue 的 open 事件 → 按下方步骤正常处置

请执行以下步骤：
1. 分析上述问题的根因，识别是否有重复/聚类模式
2. 对于你有能力直接修复的（术语、记忆类），提出具体建议
3. 对于需要修改 prompt 或代码的，生成清晰的修复描述
4. 与搭档讨论，达成共识后记录决策

## 工具使用感受反馈（F20260904tflp）

error_type 为 `tool_use_feedback` 的事件是海獭主动报的工具痛点（description 以 `[tool:工具名]` 前缀标识）。处理规则：

- 按 `[tool:<name>]` 前缀聚合
- **独立判定**：不同 otter_id 的反馈视为独立；同一 otter 对同一工具的多条反馈取最新一条参与判定
- 同工具 **≥2 条独立反馈** → 自动建 GitHub issue（标签 tool-feedback），body 引用事件证据（messageId/description），并在 resolutionNotes 引用 issue 编号后 resolve 对应事件
- 单条/低质量反馈（如把任务失败归咎工具）→ 可 dismiss（resolutionNotes 写明驳回理由）或保留 open 等更多证据
