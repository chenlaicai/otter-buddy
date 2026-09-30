---
id: F20260930brcb
title: bug_recurrence 检测器口径修订
summary: 同 PR 去重 + 非逻辑载体排除 + evidence 语义澄清——修正 42 条 critical 里约 9 成假聚集（#1214，承接 #1012 根因分析）
change_type: fix
capability_test: "n/a: 检测器纯函数逻辑（全确定性无 LLM），34 用例单测覆盖三处口径修订全分支"
intent:
  problem: "bug_recurrence 按文件级统计 30 天窗口 bugfix commit（≥3 触发 critical），两类误报致 9 成假聚集：①同 PR 连锁——一个系统性修复 PR 触碰 7-9 文件/squash 前链式 commit 计多次「复发」；②非逻辑载体污染——types/组装/测试文件被被动触碰计为「复发」载体。critical 常态化（44 条=默认值）淹没真复发信号，每日处置成本爆炸且事实上无人做。"
  expected_effect: "同 PR 多 commit 计 1 个修复事件（触发判据改为不同 PR 数 ≥3）；types/index/platforms/usecases/bootstrap/测试文件不计；evidence 报「N 个不同修复事件 + PR 清单 + 首末修复日期」。42 条存量假聚集随 30 天窗口滑出自然 auto-resolve（无需手工清理），新产生信号回到个位数。"
  verify_by:
    type: static_only
    reason: "检测器为全确定性纯函数（detectSignals 输入 commit 流输出信号），34 用例覆盖同 PR 去重/无 PR 号 sha 计数/非逻辑载体排除/混合载体不误伤/新 evidence 口径全分支；行为面由存量信号 auto-resolve 速度回查（issue #1214 验证断言，#1012 容器型关闭标准：绑定信号全终态且 14 天无新增，预计 10 月中下旬）"
created_in_conversation: d7377cfd-8497-4338-9fb5-366967ffe87e
tags: [rhi, bug-recurrence, detector, signal-quality, daily-review]
modules: [src/usecases/health/]
from: []
causal_links: ["#1214", "#1012", "#406"]
created_at: 2026-09-30
---

# bug_recurrence 检测器口径修订

## 问题（#1214，来自 #1012 根因分析）

bug_recurrence 检测器按文件级统计 30 天窗口内 bugfix commit（≥3 次触发 critical），产生两类误报，42 条 critical 里约 9 成是假聚集：

1. **同 PR 连锁计数**：系统性修复 PR 触碰 7-9 个文件 = 一次性产生 7-9 条「文件复发」信号（同一修复事件的展开被计成多处复发）；squash 合入前的链式修复 commit 同理
2. **非逻辑文件污染**：types.ts / platforms.ts / usecases.ts（组装）/ 测试文件被计为「复发」载体——它们是被多特性被动触碰的架构节点，不是「同一根因反复修」的载体
3. **occurrences 语义误导**：面板大数字（1005 等）实为「条件持续满足的小时数」（worker 每小时刷新），非修复次数

**后果**：critical 常态化 → 真复发被淹没；每日健康检查按 #406 被迫逐条处置 44 条，成本爆炸事实上无人做（first_seen 多为 9/2 起，两周无认领）。

## 方案设计（三处口径修订，单文件 detect-signals.ts）

### 1. 同 PR 去重（核心）

触发判据从「bugfix commit 次数 ≥3」改为「**不同修复事件数 ≥3**」：
- 有 PR 号的 commit：同 PR 号去重计 1 个事件（`prs: Set<number>`）
- 无 PR 号的 commit（本地修复链）：按 sha 去重计（`noPrShas: Set<string>`）

效果：`c1/c2/c3` 三个 commit 若同属 PR #500 → 1 个事件不触发；跨 3 个不同 PR → 3 个事件触发。系统性修复 PR 展开 7-9 文件不再连锁报警。

### 2. 非逻辑载体排除（isNonLogicCarrier）

```ts
tests 文件（isTestFile 复用）
/^types?.[cm]?[jt]s$/     // types.ts / type.ts（类型被动扩散）
/^index.[cm]?[jt]s$/      // 转发桶
/^(platforms|usecases|main).[cm]?[jt]s$/  // 组装/入口
/(^|/)bootstrap//         // 启动装配目录
```

排除理由：类型修改必然扩散（架构使然），组装/测试文件是多特性被动触碰面——计入只稀释区分度。同批 commit 里的逻辑文件不受影响（逐文件判定）。

### 3. evidence 语义澄清

旧：`窗口 30 天内 bugfix 10 次（sha, sha, …）`——「次」与面板 occurrences（小时数）混用误导
新：`窗口 30 天内 3 个不同修复事件（PR #501, #502, #503；bugfix commit 4 个，首末修复 2026-08-16→2026-08-22）`——独立 PR 数（触发判据）+ 原始 commit 数（保留展示）+ 首末日期，面板可区分「修复事件」与「commit 计数」。

## 设计取舍记录（机制判定）

Modification-Class: narrow-fix——检测器内部口径修订（判据/排除/文案），无新机制、无 schema 变更、无新依赖。信号消费方（面板/aging worker/triage）读 evidence 字符串与 detail 结构，两者兼容不变。

### Why（未选替代方案）

- **阈值动态化（占窗口 bugfix 总数 %）**：#1012 建议方向之一，但分母随迭代节奏漂移——高密度期阈值实际抬高，低密度期又过于敏感；同 PR 去重直接对准假聚集根因（同一修复事件被展开计数），语义更准
- **按文件 LOC 归一化**：LOC 采集需额外管道（git log + cloc），成本高且大文件本来就该更受关注（复发风险与 LOC 正相关是合理先验）
- **同根因聚类（相似 message/相邻行号）**：语义聚类不可靠（commit message 质量参差），PR 号是现成的「同一修复事件」显式边界——squash 工作流下天然成立

### 残留接受项

- 无 PR 号的本地修复链按 sha 计数，理论上同一修复拆 N 个 commit（无 PR）仍会触发——但本项目流程要求 PR-only 交付（R1），无 PR 的 bugfix commit 属违规形态，触发报警反而是正确行为
- 非逻辑载体清单是白名单式枚举，新形态的组装文件（如未来新增 barrel）需人工补充——量小可控，不为预见不了的形态过度设计

## 验证

### 测试证据（tests/usecases/health/detect-signals.test.ts，34 用例）

新增 6 用例（#1214 标注）：
- 同 PR 3 commit → 1 事件不触发（连锁报 7-9 条的形态根治）
- 4 commit 跨 3 PR → 3 事件触发，evidence 含 `#501` PR 清单 + 首末修复日期
- 无 PR 号 3 commit → 触发，evidence 含「无 PR 号」
- types.ts ×3 PR / platforms.ts ×3 PR / usecases.ts ×3 PR → 全不触发
- 混合载体（types.ts + invoker.ts 同批）→ invoker.ts 照常触发（排除不误伤）

更新 2 用例（旧「3 次」断言 → 新「3 个不同修复事件」口径）。

回归：health 域 22 文件 297 用例全过；tsc 0 错。

### Golden Gate

Golden Gate: n/a（verify_by=static_only——检测器为全确定性纯函数，无 prompt/skill/协议层软代码变更；信号面板消费的 evidence 是数据展示文案非模型可见行为面）

### 验证断言（issue #1214 回查口径）

断言：42 条存量假聚集随 30 天窗口滑出自然 auto-resolve（无需手工清理），新产生 bug_recurrence critical 回落到个位数。检查：sqlite signals 表 bug_recurrence open 计数趋势 + 新触发样本 evidence 含「N 个不同修复事件」。到期：随 #1012 容器型关闭标准（绑定信号全终态且 14 天无新增，预计 10 月中下旬）一并回查。

## 后续动作

- issue #1214 随 PR closes；#1012 按容器型标准（信号全终态 + 14 天无新增）等待自然关闭
- weixin/message-processor.ts 真复发观察继续（#1012 每轮动作：10 月再复发升级独立还债 issue）
