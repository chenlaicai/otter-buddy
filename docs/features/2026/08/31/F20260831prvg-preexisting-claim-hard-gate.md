---
id: F20260831prvg
title: "pre-existing 失败声明硬门禁：skill 层三落点防「自引入失败误报无关」"
created: 2026-08-31
status: implemented
summary: 自检报告中的 pre-existing 失败声明必须附 stash 基线复跑/对照证据，无证据不得写入；检视侧对无证据声明直接打回。生成侧/核验侧/召唤侧三落点。
change_type: prompt
tags: [skill, self-check, review-protocol, trust-gate]
modules:
  - .pi/skills/code-implementation/SKILL.md
  - .pi/skills/adversarial-review/references/review-dimensions.md
  - .pi/skills/otter-summon/SKILL.md
created_in_conversation: 3241317b-99d6-4d78-9248-ff208a7461bc
issue: 614
capability_test: "n/a: prompt/skill 层协议文本，验证靠下次小獭自检现场（见 #614 验收）"
---

# 背景（issue #614）

8/30 #599 P0 修复现场：开发獭自检报告称「其他测试 pre-existing 失败与本次修复无关」，大獭核实后发现 **5 个失败全部是该 commit 自己重写测试文件引入的**。防线是偶然的——恰好大獭亲自跑了全量测试。同日 #605 现场证明标准动作（stash 复跑验证）存在，但只在大獭的习惯里，不在小獭协议里。

问题本质：**pre-existing 声明无验证门槛**——既没有 stash 复跑也没有基线对照，仅凭印象断言，失败与己无关的声明被带进 PR。

# 方案：三落点闭环

不是代码改动，是把「验证动作」沉淀进协议层，生成侧与核验侧都覆盖：

1. **生成侧（code-implementation SKILL.md 步骤 6 自检段）**：自检报告中的任何「pre-existing / 与本次变更无关」失败声明，必须附验证证据——`git stash` 后基线复跑输出，或 checkout 合入前基线对照输出。无证据 = 未验证，不得写入自检报告。
2. **核验侧（adversarial-review review-dimensions.md B3 节）**：作者自检报告中的 pre-existing 声明若未附证据，检视者直接打回；检视者可自行 stash/checkout 基线单跑抽查。
3. **召唤侧（otter-summon SKILL.md systemPrompt 指导段）**：开发獭范本必须携带该门槛，确保指令链从大獭→小獭不丢。

# 验证

- 下次小獭自检报告含 pre-existing 声明时，应能看到 stash/基线复跑输出作为附件证据
- 检视獭收到无证据的 pre-existing 声明时按协议打回
- 已过最简检查：本修复是 3 处协议文本插入，无代码、无新依赖——低于此粒度的替代方案不存在（不改协议则门槛仍是「大獭习惯」）

# 关联

- issue #614（本次修复对象）
- 对照正例：#605 现场的 stash 验证（标准动作已存在但未协议化）
- 反例现场：#599 开发阶段 commit 516de351
- 同型先例：F20260831dgim（规则只存在于口头 → 落规 + 机械拦截的思路）
