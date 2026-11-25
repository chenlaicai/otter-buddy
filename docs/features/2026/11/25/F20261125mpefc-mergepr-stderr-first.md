---
id: F20261125mpefc
title: "merge_pr 检视闭环闸失败回显事实前置：子进程退出码与原始输出先于语义解释（#1976）"
summary: "healing 8c07b8cc 现场：闭环闸子进程因 module not found 崩溃（退出码 1，与检视断环同码），回显首句是 fail-closed 语义文案「未持有有效检视回执」——排障方向被误导去补检视环。#1929 已有 stderr brief 透传但拼在语义文案之后。本单把顺序反过来：退出码 + 子进程原始输出（前 6 行）前置，fail-closed 语义解释放后并区分两种排障方向（检视缺口 → 补环；基础设施错误 → 修环境）。"
change_type: fix
intent:
  problem: "闭环闸执行子进程失败时，fail-closed 语义文案（「未持有有效检视回执」）排在错误消息首行，子进程原始 stderr 拼在后——module not found 类基础设施错误与检视断环的退出码同为 1，排障第一眼读到语义文案就被带偏方向（#1976 案发现场：实际是 dist 路径解析错误，被当检视断环排查）。"
  expected_effect: "闭环闸失败回显的第一行是「退出码 + 子进程原始输出」，语义解释在后且明确给出两种排障方向——基础设施错误形态下排障者第一眼看到的是 Cannot find module 原文而非检视缺口文案。"
  verify_by:
    type: behavior_check
    assertions:
      - "merge-pr-tool.test.ts 39/39：既有断环用例补「子进程退出码 1」与「—— 子进程输出（前 6 行）——」前置断言；新增 module not found 用例断言 Cannot find module 文本位置早于「未持有有效独立检视通过回执」"
created_in_conversation: a9260c50-cef6-412e-a0b4-282287a13103
tags: [merge-pr, review-closure-gate, fail-closed, error-transparency, diagnostics, bugfix]
modules:
  - src/interface-adapters/agent-runtime/tools/tool-factory.ts
  - tests/interface-adapters/agent-runtime/tools/merge-pr-tool.test.ts
---

## 背景（#1976）

healing 8c07b8cc（2026-11-19，high/tool_failure）：merge_pr 闭环闸报「当前 head 未持有有效独立检视通过回执」拒合——真根因是运行中进程执行旧版脚本路径解析（module not found），被 fail-closed 包装误导。主问题（路径解析）已由 #1950 修复；本单是次生问题：失败回显的**信息顺序**误导排障。

## 根因

#1929 引入闭环闸时 catch 里已拼 stderr brief（`output.split("\n").slice(0, 6)`），但消息结构是「fail-closed 语义文案在前 + brief 在后」。基础设施错误（module not found）与检视断环的子进程退出码同为 1，无法靠退出码区分——排障方向只能由原始输出判断，而原始输出埋在后文。

## 方案

错误消息三段式反转：**事实在前、语义在后**——

```
[错误] 检视闭环闸拒绝合入（fail-closed），子进程退出码 <code>。
—— 子进程输出（前 6 行）——
<stderr/stdout brief>
—— 语义说明 ——
若上方输出为检视缺口描述：…补 delta 复核或豁免；
若上方输出为基础设施错误（module not found / 超时）：…修环境，勿按检视断环排障。
```

- 退出码非数字（spawn 失败/超时）显式标注，不假装有码。
- 语义说明同时给出两种方向的排障指引——不猜哪种，让原始输出说话。

## 设计取舍

- **不做「自动区分两种失败」**（如解析 stderr 关键词判定基础设施错误后走不同文案）：module not found 之类形态会随环境演化，关键词清单是维护负担且漏判即回退到误导；「原始输出前置 + 双方向说明」让排障者一眼判断，鲁棒。
- 退出码语义标注（1=断环 / 2=拒判）不写死在文案里：脚本退出码语义可能演化，回显只报事实。

**机制识别检查点判定**：无新增配置/枚举/状态/信号/持久化/决策分支/跨模块路径——错误消息文案重组，`narrow-fix`。

## 验证

| 场景 | 操作 | 预期 |
| --- | --- | --- |
| 断环（exit 1）回显结构 | 既有用例补断言 | 含「子进程退出码 1」「—— 子进程输出（前 6 行）——」，语义说明在后 |
| 基础设施错误回显 | 新增用例：mock 闭环闸调用抛 code=1 + Cannot find module stderr | Cannot find module 文本位置**早于**「未持有有效独立检视通过回执」；不 merge |
| mock 真实性 | stubGh 断环分支错误对象补数字 code | 与真实 execFile 错误形态一致 |

测试：`npx vitest run tests/interface-adapters/agent-runtime/tools/merge-pr-tool.test.ts` → 39/39 绿。

## 已知边界

- 只改了 merge_pr 闭环闸一处；issue 提到的「同类 fail-closed 包装点」未全仓排查——本单按最小范围修（issue 案发现场唯一命中点），其余点如再现误导另行立案。

## 关联

- issue #1976；healing 8c07b8cc
- F20261118rvcls（闭环闸本体，#1929）/ #1950（脚本路径解析主修复）
