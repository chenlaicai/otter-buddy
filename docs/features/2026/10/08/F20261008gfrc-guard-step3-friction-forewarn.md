---
id: F20261008gfrc
title: 守卫三步走第③步：裁决摩擦 + 元规则预告
summary: batch_resolve 高危批量闸（匹配集含 high 拒绝批量、逼逐条处置）+ create_otter 回包元规则预告（变体重试计数升级），治「升级信号被批量静默淹没」与「重试规则创建时点不可见」
change_type: feature
capability_test: "n/a: 工具回包文案与批量闸分支逻辑，验证走单测（healing-batch-high-gate / create-otter-retry-escalation-hint），无独立 LLM 能力面"
intent:
  problem: "#844 升级信号（变体重试 ≥3 次升 high）会被 batch_resolve 一键静默；create_otter 时点大獭不知道重试计数规则，无法在派工 prompt 里预防"
  expected_effect: "batch_resolve 对含 high 匹配集 100% 拒绝并给出逐条指引；create_otter 成功回包 100% 含变体重试预告文案"
  verify_by:
    type: behavior_check
created_in_conversation: 3241317b-99d6-4d78-9248-ff208a7461bc
created_at: 2026-10-08
tags: [bash-safety-guard, healing, governance]
modules: [guard, health]
---

# 守卫三步走第③步：裁决摩擦 + 元规则预告

## 背景

三步走（2026-09-30 搭档拍板 go_all）收官步，规格载于 F20261008gcon 路线图「后续」节：
- 第①步 F20260930gslog（#1253，已合入）：拦截事件结构化落账
- 第②步 F20261008gcon（#1260，已合入）：守卫宪法
- **第③步（本特性）**：裁决摩擦 + 元规则预告

两个问题面：
1. **升级信号可被批量静默**：#844（F20260914dsrv）建立了变体重试升级判定——同 otter 6h 内 guard_intercept ≥3 次自动升 high 落账。但 `manage_healing_events` 的 batch_resolve 按 filter 批量处置**无 severity 过滤**，high 事件会被一键静默掉——「正当诉求无出路」的升级信号淹没在批量处置里，正是 suggestion 文案里「勿再静默批量 resolve」警告的反面。
2. **重试规则创建时点不可见**：升级判定器（guard-intercept-escalation.ts）只在小獭已被拦 3 次后才生效，大獭在 create_otter 派工时不知道这条规则，无法在 systemPrompt 里预防（写明「被拦报 blocked、勿变体重试」）。

## 方案

### 改动 A：裁决摩擦（batch_resolve 高危批量闸）

**层级**：宪法 L5 habit 层之上的治理机制（不新增守卫规则，是处置通道的摩擦设计）——挂治理层，与宪法「生长规则」三问的对应见「设计取舍」。

- 工具层（healing-tools.ts `handleBatchResolve`）：真实执行前 `countByFilter({...filter, severity:'high'})` 探测匹配集中 high 条数，>0 则 errorResponse 拒绝——文案含 high 条数 + 逐条处置指引 + 收窄 filter 避开提示
- repo 层新增 `countByFilter`：与 `batchResolveByFilter` 同 WHERE 语义（buildBatchWhere 抽出共用，防判定漂移），只 count 不更新；filter 扩展 `severity` 可选字段
- **闸的三个放行面**（有意设计，非漏洞）：
  - dryRun 预览不触发（预览不产生处置，保持中性观察通道）
  - 逐条 resolve/dismiss（eventIds 路径）不受限——摩擦加在批量面，不是禁止处置
  - filter 收窄避开 high 后可批量（如按 errorType 过滤）——闸文案明示这条正道

### 改动 B：元规则预告（create_otter 回包）

- tool-factory.ts `createCreateOtterTool` 成功回包追加 `retryEscalationHint`：3 行预告「变体重试 6h 内 ≥3 次自动升 high 落账 + 建议派工 systemPrompt 写明被拦报 blocked 勿变体绕试」
- 纯回包文案增强，零行为变更；消费 #844 既有判定器（guard-intercept-escalation.ts），不新建机制

## 宪法三问（治理层条目）

本特性不新增守卫拦截规则，是宪法「治理层」的机制补全（③步是路线图既定项）：

1. **挂哪层？** 处置通道摩擦（healing 工具层）+ 创建时点提示（otter 工具层）——非守卫拦截规则，无 ruleId
2. **carve-out？** 闸的三个放行面（dryRun/逐条/收窄后批量）即正道——批量闸禁的是「无差别一键静默」，不禁处置本身
3. **退役条件？** 若 high 事件误升级率（升级后人工核实为误拦的比例）连续 4 周 = 0 且批量处置需求实测存在，可议降级为 warning 提示不硬拦——当前无此数据，暂不设时间表

## 设计取舍

- **闸放工具层而非 SQL/repo 层**：闸语义是「拒绝批量、引导逐条」的交互约束（需要文案引导），repo 层保持纯数据操作；count 探测独立成 `countByFilter` 而非复用 findAll（100 条上限对 >100 匹配集会漏检 high）
- **WHERE 构建抽出 buildBatchWhere 共用**：闸与更新面若两套 WHERE 会漂移（闸探测的面 ≠ 实际更新的面 = 假安全）——抽函数锁同源
- **预告放回包而非 systemPrompt 注入**：注入会占小獭上下文且规则是给大獭的（写派工 prompt 时用），回包零成本直达正确读者
- **最简实现检查**：已过——两个改动均为最小侵入（一个分支 + 一段文案），无新增依赖/文件/表

## 变更清单

- `src/usecases/healing/healing-event-repository.ts`：接口 +countByFilter，HealingEventBatchFilter +severity
- `src/frameworks/db/healing/sqlite-healing-event-repository.ts`：countByFilter 实现 + buildBatchWhere 抽出
- `src/interface-adapters/agent-runtime/tools/healing-tools.ts`：批量闸分支 + description 补闸语义
- `src/interface-adapters/agent-runtime/tools/tool-factory.ts`：create_otter 回包 retryEscalationHint
- 测试 +3 文件用例：healing-batch-high-gate.test.ts（闸 5 例 + countByFilter 2 例）、create-otter-retry-escalation-hint.test.ts（1 例）、rhi-signal-aging-worker.test.ts mock 补 countByFilter

## 验证

- 单测：新增 8 用例全绿；相关域回归 203/203 绿（interface-adapters/agent-runtime + frameworks/db/healing + usecases/healing 全量）
- tsc --noEmit 干净；eslint 零输出；lint:docs 零告警
- 既有 healing-batch-resolve.test.ts（检视獭-454 补的回归）全绿不回归
- Modification-Class: mechanism-addition（修法决策树④：新增治理机制——但为路线图既定项，非临时起意）
