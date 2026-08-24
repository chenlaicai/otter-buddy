---
id: F20260821rfrc
title: "yield to user 反思检查点：reason 参数 + description 反思引导"
summary: "yield 工具新增 reason 参数 + description 反思引导，通用机制覆盖所有 yield to user 场景。核心洞察：LLM 跳过流程不是做不到，而是没有在决策时刻停下来思考。"
status: implemented
change_type: prompt
tags: [prompt, yield, reflection, agent-behavior]
modules: [src/interface-adapters/agent-runtime/tools/tool-factory.ts]
created_in_conversation: 47511d68-1467-4f42-83c9-2c3a5319f65f
capability_test: "n/a: 纯 prompt 层引导改动，reason 参数由 LLM 自由使用，无强制行为需验证"
---

## 背景

两天内 4 次「修复后跳过 delta 复核直接找搭档终审」（PR #354、#362、#361 + 08-19 历史）。三轮 prompt 修复（#314、#334+#335、review-loop-baseline-enforcement）都没生效。

根因分析（MiMo + Kimi 独立分析，高度一致）：
- 三轮修复都在用 prompt（遵从式约束）解决需要 mechanism（生成式触发）才能解决的问题
- LLM 跳过流程不是因为"做不到"，而是没有在决策时刻停下来思考
- 训练先验劫持："完成任务 → 向汇报"是 LLM 的默认路径

## 设计决策

### 核心洞察（搭档）

> "如果要传递给用户，就必须暂停思考一下是否真的需要用户介入。只要提醒一下，LLM 基本都会自我纠正。"

这比代码层拦截更高明：
- 代码层拦截 = 水坝（拦截所有流量，包括合法的）
- 暂停思考 = 减速带 + 路标（LLM 自己看清楚该往哪走）

### 设计演进

1. **方案 v1**：yield execute 软守卫（检测检视獭在场 → 阻断 → 二次放行）
   - 搭档否决："这只是具体问题的堆积，不是系统设计"
2. **方案 v2**：yield execute reason 参数校验
   - 受 cyclomatic complexity 限制（execute 函数 12/12），无法添加 if 分支
3. **方案 v3（最终）**：description 反思引导 + reason 可选参数
   - 纯 prompt 层，通用机制，不绑定任何具体场景
   - 搭档认可

### 为什么选择纯 prompt 层

搭档的关键纠偏：「不能把具体场景的针对性定制修改放入系统中，那只是具体问题的堆积，不是叫"系统"。」

reason 参数是通用的元认知触发——适用于所有 yield to user 场景：
- 修完代码该交搭档？→ 说明理由 → 可能发现"检视獭还没确认"
- 遇到问题该问搭档？→ 说明理由 → 可能发现"我自己能查"
- 任务做完该汇报？→ 说明理由 → 确认"确实需要搭档拍板"

## 改动范围

| 文件 | 改动 |
|------|------|
| tool-factory.ts | yield 工具 description 加反思检查点 + parameters 加 reason 可选参数 |
| speak-tool.test.ts | 新增 4 个测试（含 description 存在性验证） |

## 验证

- 117 test files / 1435 tests 通过
- CI 通过
