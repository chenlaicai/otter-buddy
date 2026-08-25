---
id: F20260825ktt2
title: 锁获取超时落结构化诊断日志（issue #423 方案 1）
summary: |
  Issue #423（8/24 09:00 UTC 事故）：Lock acquire timeout 连续刷屏，用户被迫手动干预，
  但除报错文本外无任何可定位证据（持有者是谁、持有了多久、队列多深），#383 修复后
  仍复现、根因无日志可查。方案 1（可观测性·必做）：SimpleLockManager 跟踪 heldAt，
  超时 reject 前经可选注入的 logger 落结构化 error 日志（lockKey/otterId/waitedMs/
  timeoutMs/holderHeldForMs/queueLength/activeLocks）；healing event 上报因
  messageId/conversationId 在锁层不可得（schema NOT NULL）降级为日志，注释说明边界。
change_type: bugfix
status: active
capability_test: "n/a: 纯日志可观测性改动，无 LLM 参与行为"
created_in_conversation: 3241317b-99d6-4d78-9248-ff208a7461bc
---

# 锁获取超时落结构化诊断日志（issue #423 方案 1）

## 背景与需求

### 问题描述

8/24 09:00 UTC，大獭在 PR #414 流程中连续报错 `Lock acquire timeout for key: session:dac90b40-...`，刷屏到搭档手动介入（"如果有需要你自己重启下"）。事故后复盘发现：除报错文本本身外，系统**没有任何可定位证据**——

- 持有者是谁？不知道
- 持有者持有了多久？不知道
- 等待队列多深？不知道
- 是偶发慢调用还是真死锁？不知道

#383（SimpleLockManager 并发安全修复）已合入但未覆盖此场景。issue #423 列出三个修复方案：①可观测性（必做）；②基于日志诊断根因（依赖①落地后的真实日志）；③锁超时自动熔断（后续评估）。本特性只做方案 1。

### 治理约束（A1 反面教材的教训）

issue 中海獭两次推测归因均未验证。本特性**不包含任何根因推测**——只加证据采集能力，根因诊断留给方案 2 拿到真实日志后进行。

## 方案设计

### 锁层改动（session-helpers.ts）

1. **锁条目新增 `heldAt`**：跟踪「锁被持有的起始时刻」。三处维护：
   - 获锁时（`lock.held = true` 处）记录 `Date.now()`
   - 锁转移给下一等待者时重置（持有权换手，计时重新开始）
   - 释放且无等待者时置 null
2. **构造函数新增可选 `logger`**：向后兼容——未注入时行为与之前完全一致。
3. **超时路径落结构化日志**：reject 前经 `logger.error` 输出诊断字段：
   - `lockKey`：锁 key（如 `session:<otterId>`）
   - `otterId`：从 `session:` 前缀解析，便于按獭聚合排查
   - `waitedMs` / `timeoutMs`：本次等待时长 / 超时阈值
   - `holderHeldForMs`：**持有者已持锁多久**——定位「谁长期持锁」的关键证据
   - `queueLength`：超时时刻仍在排队的等待者数量
   - `activeLocks`：进程级活跃锁总数（锁竞争强度信号）

### healing event 上报为何降级

现有 healing event 上报路径是 speak 工具的 `interceptHealingReport` → `healingRepo.create()`，而 `healing_events` 表 `message_id` / `conversation_id` 为 **NOT NULL**（schema.ts:618）。锁层拿不到 message/conversation 运行上下文，按任务简报降级为结构化日志，并在代码注释中说明边界。若方案 2 诊断后需要事件化，建议在 factory 层（otterId 可得）或日志告警侧补桥接。

### 不改的东西（边界）

- 锁的获取/释放/超时判定逻辑本身——本特性只加观测，不改行为
- 不引入新依赖
- 方案 2（根因诊断）与方案 3（自动熔断）不在本特性范围，issue #423 保持 open

## 影响范围

- `src/frameworks/agent/session-helpers.ts`：SimpleLockManager 跟踪 heldAt + 超时结构化日志
- `src/frameworks/agent/pi-session-factory.ts`：构造锁实例时注入 logger
- `tests/frameworks/agent/simple-lock-manager.test.ts`：新增 3 用例
- 行为变化：超时发生时多一条结构化 error 日志；锁行为本身不变；logger 可选注入

## 验证

- [x] 新增：超时落结构化日志并断言全部诊断字段（lockKey/otterId/waitedMs/timeoutMs/holderHeldForMs/queueLength/activeLocks）
- [x] 新增：正常等待后获锁不落日志（无噪音）
- [x] 新增：无 logger 时超时行为不变（向后兼容）
- [x] 既有 9 个并发安全用例不受影响（12/12 通过）
- [x] 全仓 123 测试文件 1504 测试通过，tsc/eslint 通过

## Discovered Issues

无。

## 决策史

- 2026-08-25：初始实现（开发獭-423，kimi）。healing event 降级理由经 schema.ts:618 NOT NULL 约束核实；PR 描述按治理约束不写未验证的根因推测
- 2026-08-25：对抗审视（检视獭-434，mimo）：代码质量过关（heldAt 三路径维护完备、降级理由核实属实、Logger 接口匹配、12/12 测试独立验证）；2 严重发现 = 分支落后 main + 本特性文档缺失，本轮处置补齐
