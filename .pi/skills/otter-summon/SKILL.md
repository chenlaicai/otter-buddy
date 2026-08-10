---
name: otter-summon
description: >-
  Summon specialized sub-agents for independent review, parallel research,
  multi-role discussion, or workload delegation.
  For single-agent tasks, use the corresponding skill directly.
co_loads: []
---

# Otter Summon Protocol

大獭召唤小獭的决策框架和协作编排。

## 触发

**触发条件**：需要独立审视（异体执行）、并行做多件事、模拟多角色讨论、或任务量大需要分担时。

**排除**：搭档在讨论/闲聊/发散 → `companion`。需求明确且简单 → 大獭直接做。搭档说"你来就行" → 尊重。

**输入**：
| 输入 | 必选 | 缺失时 |
|------|------|--------|
| 任务描述 | 是 | 停下来明确任务 |
| 任务类型 | 否 | 从描述推断，不确定则问搭档 |
| 背景信息 | 否 | 尽量收集，不阻塞 |

## 工作流

1. **判断是否召唤**：能自己做的自己做，真正需要帮手时才召唤。核心判断表：

   | 场景 | 动作 |
   |------|------|
   | 需要独立审视 | 召唤检视獭 |
   | 需要并行做多件事 | 召唤多只小獭 |
   | 需要角色讨论 | 召唤按立场命名的小獭 |
   | 任务量大需分担 | 召唤开发獭 |

2. **写 systemPrompt**：身份信息不需要写（SMALL_OTTER.md 已覆盖），只写任务相关内容：

   ```
   你的任务：[一句话]
   背景信息：[相关上下文、已有结论、约束条件]
   预期产出：[格式]
   完成标准：[什么算做完]
   ```

3. **接住产出**：审视小獭产出质量 → 整合有价值的产出 → 发现遗漏决定自己补或再召唤 → 向搭档汇报。

> 约束：召唤要有明确任务，不要让小獭从零开始。小獭的产出是你的输入，不是最终交付物。

## 产出

本 skill 是编排层，后续动作由被召唤的小獭的 skill 决定。

## 参考

- `references/collaboration-patterns.md` — 多轮协作编排模式
