---
id: F20260915soe9
title: stale 双活 pendingRestart 误逐新 session 的归属校验
doc_type: feature

# 记忆索引
summary: |
  #904 修复：旧 invoke 卡死超 300s 被 stale steal（#599）放行新 invoke 冷启动新
  session 入池后，旧 invoke 苏醒收尾时 finally 消费 pendingRestart 按 otterId 无条件
  evict——逐出的是新 invoke 刚建的新 session（三条件叠加的边缘场景）。修复：
  提取 _evictPooledIfOwned 私有方法，evict 前比对池内条目归属
  （poolMeta.toolContext === 本 invoke 的 toolContext），不匹配则跳过。测试以
  副作用状态断言锁定三分支：归属自己 → evict；stale 双活（池内是别人的）→
  保留；池内无条目 → 安全跳过。

# 因果链路
causal_links:
  from: ["F20260912nlb896", "F20260911pspl"]   # #896 死锁修复的已知边界 / PiSessionPool
  to: []

# 元数据
change_type: fix
capability_test: "n/a: 确定性代码路径（Map 归属比对），无 LLM 行为变更；验证走 vitest 单测（3 用例：归属三分支，副作用状态断言）"
tags: [agent, session-pool, pendingRestart, stale-steal, ownership-check]
modules: [src/frameworks/agent/pi-session-factory.ts, tests/frameworks/agent/stale-evict-ownership.test.ts]

# 时间
created_at: 2026-09-15
created_in_conversation: a56c349e-c566-438c-97d0-653a260171ed
---

# stale 双活 pendingRestart 误逐新 session 的归属校验

## 背景与需求

issue #904（概率极低的边缘场景，来自 #894 检视边缘观察，F20260912nlb896 已知边界显式化）：

**误逐场景（三条件叠加）**：
1. 旧 invoke 卡死超 300s → stale steal（#599）放行新 invoke，冷启动**新 session** 入池（旧 session 已 markStale 出池成孤儿）
2. 旧 invoke 苏醒收尾时恰好调用过 restart 类工具（pendingRestart 已置位）
3. 旧 invoke 的 finally 消费 pendingRestart → `pool.evict(otterId)` 按 otterId 无条件驱逐——逐出的是**新 invoke 刚建的新 session**

**后果**：新 session 被误逐成孤儿，下次 invoke 重新冷启动；旧 invoke 的「临终清理」错杀新会话。

## 方案设计

issue 自带具体修复方案（比对池内条目归属），本次实施采纳并做两处工程化收敛：

1. **提取 `_evictPooledIfOwned(otterId, toolContext)` 私有方法**：归属校验 + evict + poolMeta 清除三步收口一处，finally 消费点只留一行调用——同时规避 finally 块 complexity 超限
2. **归属语义**：`poolMeta.get(otterId)?.toolContext !== toolContext` 即跳过。stale steal 后旧 session 已出池成孤儿，池内条目只会是新 invoke 的 toolContext——不匹配 = 不是自己的，不逐

**为什么 toolContext 是正确的归属键**：toolContext 随 session 创建（_createSessionWithTools），一个池条目一个；同一 otterId 的两次冷启动必然产生不同 toolContext。引用相等比对零歧义。

## 实现内容

| 文件 | 改动 |
|---|---|
| src/frameworks/agent/pi-session-factory.ts | finally 消费点改调 `_evictPooledIfOwned`；新增私有方法（归属校验 + 注释） |
| tests/frameworks/agent/stale-evict-ownership.test.ts | 新增 3 用例（pool-hit-path.test.ts 同款 mock 模式） |

测试三分支（副作用状态断言，遵守项目 no-restricted-syntax 规则——不断言 mock 调用细节）：
- 归属自己（正常自重启路径）→ evict 执行 + poolMeta 清除
- **stale 双活**（池内条目是新 invoke 的）→ 无逐出副作用 + 新 session 存活
- 池内无条目（LRU 驱逐/池 miss）→ 安全跳过不抛

## 验证

- 3 新用例全绿；agent 域 32 文件 434 测试全绿；全仓 250 文件 2957 测试全绿
- eslint 零错误（含新测试文件）；tsc --noEmit 零错误
- **最简实现检查**：已过——issue 方案是 finally 内联 1 行条件，本次提取成方法是工程化收敛（complexity lint + 可测性），非过度设计；无新依赖、无新状态
- Golden Gate / Intent 块：n/a——非软代码（agent 运行时确定性路径）

## 影响范围与风险

- 改动面：pi-session-factory.ts 单文件 +1 方法 +1 行调用变更，行为收敛（原无条件 evict → 归属校验后 evict）
- **行为变化**：唯一语义差异 = 三条件叠加的边缘场景下新 session 不再被误逐（issue 目标）；正常自重启路径行为不变（池内条目就是自己的 toolContext）
- 回退面：极小，单 commit revert 即可

## 取舍

- **内联条件 vs 提取方法**：issue 给的是内联 1 行。提取理由：① finally 块已有 complexity 压力（文件头 eslint-disable 注释可证）；② 三分支语义值得独立测试面（内联在 finally 里无法单测）。选择提取
- **为什么不 dispose 旧孤儿**：与 #897 stale 出池策略一致——旧 invoke 可能还在执行中，dispose → agent.abort() 会撕裂旧 invoke；孤儿由旧 invoke 生命周期托管，GC 兜底
