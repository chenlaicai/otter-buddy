---
id: F20260805p5bt
title: capability-tests-batch2-agent-behaviors
doc_type: feature

summary: |
  能力测试批次 3：獭的主动行为四件套——召唤小獭、术语捕获、skill 触发、多模型路由 + 确定性 dissolve。
  LLM 决策行为全部用统计采样（expectSampledBehavior 抽取为共享断言）；路由/生命周期等确定性部分严格断言。
  观测亮点：大獭为小獭撰写的 systemPrompt 与任务高度相关；repo-safety skill 生效（獭自建 worktree 写代码，
  零主树污染）；术语入库率 3/3；skill 触发率 3/3。
  范围裁剪：memory-vs-messages 歧义测试删除（场景设计不诚实，与旗舰重叠）；recruiting/healing 上报留批次 3。

causal_links:
  from:
    - F20260805capt   # 能力测试层骨架
    - F20260805mspk   # 统计断言依据
    - F20260728skrp   # repo-safety skill（本次观测到其真实生效）
  to: []

status: implemented
change_type: feature
capability_test: tests/capability/agent-behavior.capability.test.ts
tags: [test, capability-test, otter-summon, skill, terminology, multi-model, dissolve]
modules:
  - tests/capability/agent-collaboration.capability.test.ts
  - tests/capability/agent-behavior.capability.test.ts
  - tests/capability/multi-model.capability.test.ts
  - tests/capability/helpers/assert-behavior.ts
  - config/config.test.yaml
---

# F20260805p5bt: 能力测试批次 3（獭主动行为）

## 用例与实测观测

| 用例 | 断言方式 | 实测 |
|---|---|---|
| otter-summon | 采样 3≥1 | 2/3：大獭 create_otter 并为小獭撰写任务相关的 systemPrompt（"排序獭""排排獭"）；1/3 直接自己答 |
| 术语捕获 | 采样 3≥1 | 3/3 入库（2 次显式 add_terminology，1 次其他路径入库） |
| skill 触发 | 采样 3≥1 | 3/3：实现类请求触发 read core-workflow SKILL.md |
| 多模型路由 | 严格（确定性） | 别名落库 otter_configs + ModelPool 解析非回退 + agent session 建立 |
| dissolve | 严格（确定性） | otters.dissolved + session 封存 + agent_sessions 销毁，三层清理 |

## 重要观测：repo-safety skill 真实生效

skill 触发用例初版让獭真实现功能，獭**自发创建 git worktree 隔离作业**（.claude/worktrees/timestamp-tool-*），
主树零污染——这正是 repo-safety skill 的设计意图，首次被测试实证。后改为"只做需求分析"提示
（真实现需 25 个工具调用 ~5 分钟，副作用与耗时双高；产物 worktree 已清理）。

## 范围裁剪（设计决策）

- **memory-vs-messages 歧义**：删除。同对话问题上下文可直接答（不查工具是合法行为），
  跨对话召回已被旗舰 memory-recall 覆盖——强造歧义场景是不诚实的测试。
- **多模型路由的「别名模型真实 invoke」**：降级为确定性断言。别名可指向同一端点，
  invoke 链路已由 restart/身份注入覆盖（默认模型）；跨对话点名依赖活跃回合时序，不适合能力层。
- **recruiting 分类 / healing 上报**：留批次 3（recruiting 需 inbound 配置与更重 harness；
  healing 上报的触发条件难以从真实模型确定性引出）。

## 共享设施

`expectSampledBehavior(label, samples, minSuccess, fn)` 抽取为通用统计采样断言
（memory-recall 旗舰可后续改用，暂保持原样以稳为先）。

## 验证

- 能力套件累计 11/11 绿（5 文件）：memory-recall 3 + otter-lifecycle 3 + 本批 5
- 运行时长：全套件约 8 分钟（skill 触发占 ~5 分钟，接受为本地层成本）
- A 类套件无回归：85 文件 / 1045 用例
