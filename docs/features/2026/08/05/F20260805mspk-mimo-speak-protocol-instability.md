---
id: F20260805mspk
title: mimo-speak-protocol-instability
doc_type: feature

summary: |
  发现（由首个 B 类能力测试捕获）：mimo 模型在多步任务中 speak 协议遵从不稳定。
  3 轮观测：1 次全链路成功（search_memory→speak 答出事实）、1 次未搜索直接答、
  2 次搜索记忆并拿到事实后未调 speak 收尾，回合被系统强制关闭（"未调用 speak 工具结束发言"）。
  用户视角即"记忆查到了但没送到嘴边"，与此前记忆系统能力缺失的体感一致。
  处置：旗舰测试改为 3 次采样 ≥1 次成功的统计断言；本档记录根因线索，prompt 修复另立项。

causal_links:
  from:
    - F20260805rsto   # 测试体系重构缘起（mock 体系无法发现此类行为缺陷）
  to: []

status: proposed
change_type: fix
tags: [llm-behavior, mimo, speak-protocol, memory-recall, capability-test, finding]
modules:
  - prompts/identity/BIG_OTTER.md
  - .pi/skills/core-workflow/SKILL.md
  - tests/capability/memory-recall.capability.test.ts
---

# F20260805mspk: mimo speak 协议遵从不稳定（发现记录）

## 现象（可复现）

`npm run test:capability` 的 memory-recall 旗舰测试，真 mimo（mimo-v2.5-pro）3 轮独立运行：

| 轮次 | 工具轨迹 | 结果 |
|---|---|---|
| 1 | search_memory → speak，答案含事实 token | 全链路成功 |
| 2 | [speak]（未搜索直接作答） | 不达标 |
| 3（含重试共 2 次采样） | search_memory ×2 →（get_memory_detail）→ 无 speak | 不达标：系统强制闭回合，body="[系统] 未调用 speak 工具结束发言" |

记忆检索链路（真 bge-m3 + FTS5 RRF 融合）在所有轮次均正常——**缺口在"搜到之后稳定走完 speak 协议"**。

## 根因线索（未坐实，供修复立项参考）

1. 单步任务（"回复：冒烟正常"）speak 遵从率正常；多步任务（搜索→综合→发言）失败率高——
   疑似工具返回结果后，模型把"已获得答案"误判为任务结束，直接停止生成而非调 speak。
2. mimo 有自发退化倾向（repeat_window），多步场景放大概率。
3. BIG_OTTER.md / core-workflow skill 对 speak 收尾的约束措辞，对 mimo 的约束力不足——
   修复方向优先考虑让 LLM 理解"拿到工具结果后必须用 speak 交付"（机制约束只是兜底）。

## 处置

- 旗舰测试改为**统计断言**：3 次采样 ≥1 次全链路成功。每次采样结果打印，成功率归 0 则测试失败。
  既不因模型抖动让套件长红（长红=无回归价值），也不掩盖问题（采样明细全量可见）。
- prompt/skill 层的修复（提高 speak 收尾遵从率）另立 F 文档处理，不在测试体系重构范围内。

## 复现

```bash
npm run test:capability   # 需 config/config.test.local.yaml 配置 mimo 端点
```
