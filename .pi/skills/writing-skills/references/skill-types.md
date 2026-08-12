# skill-types.md

otter skill 的三种 category。

## technique（方法步骤）

**特征**：有明确工作流，按步骤执行，产出结构化交付物。

**判别**：
- description 含具体触发条件（"搭档要求 X"）
- 工作流有顺序步骤（1. 2. 3.）
- 产出是可验证的交付物（文档、PR、报告）

**例**：
- `troubleshooting`：症状 → 根因 → 修复建议
- `code-implementation`：方案 → 代码 → 测试 → PR
- `requirement-analysis`：模糊意图 → 技术方案
- `adversarial-review`：PR/方案 → 问题清单
- `worktree-isolation`：准备 → worktree → commit → PR
- `writing-skills`：意图 → 合规 SKILL.md

## pattern（思维原则）

**特征**：无固定步骤，是行为模式或思维模型。

**判别**：
- description 是模糊触发的兜底或常驻模式
- 无严格工作流步骤，是行为指引
- 产出是行为状态而非具体交付物

**例**：
- `companion`：默认 fallback，非结构化协作——"搭档觉得搞定了就完成"

## reference（查表文档）

**特征**：给 LLM 在工作中查阅的查表/规范文档，不主动触发。

**判别**：
- description 标注"查阅用"，触发靠其他 skill 内部 read 引用
- 内容是事实/规范，不是流程
- 无产出

**例**：（otter 当前无此类，未来如术语库查表 skill 可用此 category）

## 边界情况

**既是 technique 又是 pattern？** 按**主要职责**归类：
- skill 的核心产出是结构化交付物 → technique
- skill 的核心产出是行为状态 → pattern

**重写 skill 时 category 是否可变？** 可以。重写后由当前职责决定，commit message 记录变更理由。
