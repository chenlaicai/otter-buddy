---
id: F20260916rgsv
title: 验证断言回查机制：daily-review issue 修复的可证伪闭环
doc_type: feature
summary: |
  修复后没人回头验证「真的修好了」——自优化闭环第五环（新版本→新数据）没有闭合（R20260916rsis 缺口 2，
  issue #1004）。本特性两层落地：①规范层——daily-health-check.md 的 issue 产出规范加「验证断言」必填段
  （断言/检查方式/到期日期三要素，可证伪才合规）；②机制层——新增 regression-verify 定时任务
  （每日 11:00，seed 在 self-healing 对话），复用 [占位符] 动态注入模式（resolveEffectiveBody），
  扫近 62 天 closed 的 daily-review issue，提取「## 验证断言」段的到期日期，到期者注入 prompt
  由大獭逐条回查（执行检查方式→判定✅/❌/⚠️→评论回写带 regression-verify 标记；❌ 已关闭的重开升级）。
change_type: feature
capability_test: tests/usecases/scheduler/regression-verify.test.ts
created_in_conversation: 325ef7b7-8e42-4edc-9abf-eae8f332a2c4
intent:
  problem: "daily-review issue 修复后无人回验，「修好了」不可证伪，假修复静默累积"
  expected_effect: "带验证断言的 issue 到期后收到回查评论（含 ✅/❌/⚠️ 判定与证据）；❌ 的已关闭 issue 被重开升级"
  verify_by:
    type: behavior_check
causal_links:
  from:
    - R20260916rsis
tags: [self-optimization, regression, scheduler, healing, issue-process]
modules:
  - prompts/scheduled/daily-health-check.md
  - prompts/scheduled/regression-verify.md
  - src/usecases/scheduler/scheduler-service.ts
  - src/usecases/healing/ensure-healing-scheduler.ts
  - tests/usecases/scheduler/regression-verify.test.ts
---

# F20260916rgsv: 验证断言回查机制

## 背景

R20260916rsis（RSI 业界洞察，#997）第二部分缺口 2：daily-review 产出的 issue 修复后无人回头验证「真的好了」——改完即忘，「修复」从可证伪假设退化为一次性动作。搭档急讯定调落地（issue #1004）。

业界依据：Anthropic AAR 的预注册纪律（mini-paper 看到结果前冻结）+ 常规 regression 思想；可证伪性是自优化系统区别于「自我感觉良好」的分界线。

## 方案设计

### 两层结构

**规范层**（daily-health-check.md）：issue 产出规范加「验证断言」必填段：

```
## 验证断言
- 断言：<具体可检查的条件，含数据源>
- 检查方式：<sqlite 查询 / gh 命令 / 人工观察>
- 到期：<YYYY-MM-DD，创建+30天>
```

写不出可证伪断言 = 问题定义不清，回去重写。「观察一下」「应该会好」不合规。

**机制层**（复用现有动态注入，不造新引擎）：
- 新定时任务 `regression-verify`：每日 11:00（错开 9:00 health-check / 10:00 healing 分析），seed 在 self-healing 对话（ensureHealingScheduler 内随同 seed，不新开对话）
- body 含 `[regression-verify]` 占位符；`resolveEffectiveBody` 扫描近 62 天 closed 的 daily-review issue（30 天到期 + 32 天余量），`extractAssertionDueDate` 提取到期日期，到期者（≤今天）注入 prompt；无到期 → 返回 null 跳过本轮
- prompt 模板 `prompts/scheduled/regression-verify.md`（git 化，{{REGRESSION_DATA}} 占位符），执行步骤：读 issue → 真跑检查方式 → 判定 → 评论回写（带 `<!-- regression-verify: ... -->` 机器标记）；❌ 已关闭的重开并升优先级；日上限 10 条防爆量

### 机制识别检查点（issue 驱动未经 RA，必做）

逐项过：①新状态机？否（复用定时任务+占位符注入）②新持久化表？否（断言在 issue body，回查结果在 issue 评论，全是 GitHub 侧状态）③新协调协议？否（regression-verify 标记评论只是审计锚，无状态语义）④新生命周期？否。**结论：不涉及净新增机制**——整个实现是「扫描器 + 模板填充」组合既有原语，GitHub issue 即存储层。

### 关键取舍

- **状态存 GitHub 不落本地 DB**：断言在 issue body、回查结果在 issue 评论——天然可审计、搭档可见、无迁移负担。代价：依赖 gh CLI 可用；gh 失败时返回 null 跳过本轮（不阻塞调度器）
- **扫描窗口 62 天**：覆盖 30 天到期 + 余量；issue 关超过 62 天还没回查的视为放弃（量级上不可能——每日跑）
- **fail-closed 不做硬门**：回查是 LLM 软强制（同锚点抽查 #981 的定位）——价值在固定流程+必产出+事后可追溯，不做机器断言

## 验证

- `tests/usecases/scheduler/regression-verify.test.ts`：extractAssertionDueDate 7 条用例（标准段/段在末尾/中文冒号/无段/无到期行/非法格式/后续段干扰）
- 全量 scheduler+healing 测试 149 通过
- tsc --noEmit 零错误
- 已过最简检查：复用 `[占位符]` 动态注入（scheduler-service.ts resolveEffectiveBody）+ ensureHealingScheduler seed 模式 + gh CLI 扫描，无新表无新引擎；曾考虑本地 DB 存断言（否决：重复 GitHub 已有状态，引入同步问题）

### 验收场景

| AT | 场景 | 预期 |
|---|---|---|
| AT-1 | daily-review 新 issue | body 含验证断言段（规范生效） |
| AT-2 | 断言到期日 | regression-verify 任务触发，issue 收到回查评论带 regression-verify 标记 |
| AT-3 | 无到期断言 | 任务 skipped（resolveEffectiveBody 返回 null），不发消息 |
| AT-4 | gh CLI 不可用 | 返回 null 跳过，调度器不炸（catch 兜底） |
| AT-5 | 回查 ❌ 且 issue 已 closed | 重开 + 升优先级 + 评论说明 |

### 负面向条目（#962 刹车二）

本次变更破坏/绕过什么旧契约：无——纯新增任务与规范段；唯一行为变化是 self-healing 对话多一个每日 11:00 的任务（该对话原本就有 10:00 任务，节奏兼容）。存量 issue 无验证断言段 → 永远不会被扫到（extractAssertionDueDate 返回 null），不造成回查风暴；规范生效后的新 issue 才会进入回查管道。

## 遗留与后续

- 存量历史 issue 不回标断言（量太大且多数已时过境迁）；规范只管新产出
- 回查判定质量是 LLM 软强制的已知边界——若发现 ❌ 误判率高的模式，走 healing 事件上报
- 关联：R20260916rsis（来源洞察）、#1004（跟踪 issue）
