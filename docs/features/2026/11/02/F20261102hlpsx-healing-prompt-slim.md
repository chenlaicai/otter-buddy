---
id: F20261102hlpsx
title: healing 分析任务 prompt 瘦身（#1512）：数据区线索化 + 锚点补齐 + 预算控制
change_type: refactor
status: implemented
created: 2026-11-02
created_in_conversation: a9260c50-cef6-412e-a0b4-282287a13103
modules:
  - src/usecases/scheduler/scheduler-service.ts
  - prompts/scheduled/self-healing-analysis.md
summary: "#1512：self-healing-analysis 任务数据区由「20 条事件样本全家桶」构成——description 平均 207 字（含固定引导全文逐条重复）+ suggestion 随行（+100 字/条）+ 样本行无 event ID（处置锚点缺失），数据区约 7K 字占 prompt 2/3。线索化改造：样本行带锚点（id 前 8 位短锚 + msg 前 8 位前缀）、同形聚类（description 前 30 字相同合并带 ×N 计数）、描述截断 80 字保留差异首段、suggestion 不随行（下钻获取）、数据区 2K 字符预算硬顶（超限逐行丢弃保最新+尾部标注）。模板静态区补「样本下钻」段（行格式说明 + 查询路径），fallback 双源同步。6 红测锁定（锚点/不随行/截断/聚类/预算/下钻指引）。"
tags: [scheduler, healing, prompt-slim, observability]
capability_test: "n/a: 调度器数据区构造重构，无 LLM 行为变更"
intent:
  problem: "self-healing-analysis 每日任务的 prompt 数据区是 20 条事件全家桶（description 平均 207 字含 guard 引导全文逐条重复 + suggestion 随行 + 无事件 ID 锚点），约 7K 字占 prompt 2/3；处置獭拿不到锚点需回查数据库对时间戳，固定话术重复 20 遍零信息增益"
  expected_effect: "数据区 ≤2K 字符且每条样本行含 id 短锚与 messageId 前缀（验证断言：连续 7 天，到 2026-11-14）；同形事件归并后处置獭可直接复制锚点查详情；引导话术只出现在模板静态区一处"
  verify_by:
    type: scheduled_task_output
    detail: "合入后由每日 self-healing-analysis 任务产出实证：数据区长度与样本行形态由 regression-verify 在 2026-11-14 到期核验（issue #1512 既定口径）；单测侧 6 用例锁定构造逻辑（锚点/聚类/截断/预算/下钻指引）"
---

# healing 分析任务 prompt 瘦身（#1512）

## 问题

self-healing-analysis 任务 prompt 数据区（`{{HEALING_DATA}}`）三大缺陷（issue #1512 排查结论，2026-10-15 证据链）：

1. **样本全家桶**：`findOpen(20)` 20 条事件逐条输出 description（平均 207 字、最长 349 字——guard_intercept 的 description 内嵌正道引导全文）+ suggestion（+100 字/条），固定引导话术重复 20 遍，数据区约 7K 字占 prompt 2/3
2. **锚点缺失**：样本行只拼 `[severity] description`，无 event ID——处置时拿不到锚点，需回查数据库对时间戳
3. **样本既不全又太长**：open 池 581 条只喂 20 条（样本选取本身有偏），归口决策仍需处置獭自行查库——数据价值 < 查询能力

实施时现状核验（2026-11-02）：open 池已缩至 7 条（流水线清理见效），但三个机制缺口仍真（代码实证：样本行拼接无 ID / suggestion 随行 / findOpen(20) 上限 + MAX_PROMPT_LENGTH 截断无预算控制）——池回升即复发，非幽灵。

## 修复

`buildHealingDataSection`（新函数，替换原数据区拼接循环）：

- **样本行格式**：`- [severity] 类型×计数｜id前8位｜msg=messageId前8位｜描述首段(≤80字)`——处置锚点直接可复制（manage_healing_events 接受前 8 位短锚）
- **同形聚类**：`errorType·description前30字` 相同 → 同族合并，保留最新样本 + `×N` 计数（N 为族内总条数，含所示样本；实测 main_write 族同前缀 110 条，聚类价值真实）
- **suggestion 不随行**：详情下钻获取（模板写明路径）
- **预算硬顶**：数据区 2000 字符（验证断言口径），超限逐行丢弃保最新 + 尾部标注未展示条数
- **模板静态区**：补「样本下钻」段（行格式说明 + 同形归并语义 + 查询路径）；`HEALING_FALLBACK_PROMPT` 双源逐字节同步（守卫测试锁定）

## 测试

`tests/usecases/scheduler/healing-analysis-template.test.ts` 新增 describe（6 用例，修复前全红）：

- 样本行含处置锚点（id 短锚 + msg 前缀）
- 建议不逐条随行
- 描述线索化（截断 + 固定引导全文不占版面）
- 同形聚类（×N 计数）
- 数据区预算控制（20 条长事件全样本 ≤ 2K）
- 下钻路径声明（模板/数据区含查询指引）

既有 8 用例更新 1 处断言（`### 工具故障 (N 条)` 分组头 → 线索化行形态），其余不回归。

实现过程踩坑留痕：mock 的 id/msg 前缀恰为 8 字符边界，`slice(0,8)` 截掉断言目标字符——测试基建与实现口径耦合时前缀设计要避开边界。

## 验证

- 全量 425 文件 5614 用例零回归（pre-commit 全链 check 过）
- 纯函数探针独立验证：20 条长事件 → 数据区恰好压在 2000 预算内（13 行保留 + 尾注）

## 影响范围

- self-healing-analysis 每日任务 prompt：数据区 7K → ≤2K（约 70% 缩减）；处置锚点补齐
- 处置獭工作流变化：样本行可直接复制 id 短锚查详情，不再需要回查数据库对时间戳
- **验证断言**（issue #1512 定义）：合入后连续 7 天数据区 ≤ 2K 且每条样本行含 messageId——观测期到 2026-11-14，到期由 regression-verify 任务自动核验

## 设计取舍

- **同形聚类只在样本内做（20 条内），不做全库聚类**：全库分布已有 stats 行（按类型 JSON）；样本职责是「给处置獭最新线索」而非「完整统计」——统计查库，线索进 prompt
- **保留 findOpen(20) 上限不动**：issue 方案 1 的「每族一行」全库形态需要新仓储查询（按 ruleId 分组 count），超出瘦身范围；20 条 + 聚类 + 预算已达成 ≤2K 目标。池若回升至样本覆盖不足，后续按需扩
- **描述截断 80 字**：guard_intercept 的差异信息集中在首段（拦截理由 + 命中命令头），引导全文恒定尾部截掉无损
- **机制判定**：数据区构造重构，无新机制引入——机制预算四问不触发；验证断言沿用 issue 既定的 7 天观测口径（regression-verify 已有到期核验机制，不新增守卫）

## 关联

- issue #1512；#416（模板 git 化，本 PR 改动其数据填充侧）；#428（fallback 双源守卫，本 PR 同步维护）；#998（二维分账行保留不动）
