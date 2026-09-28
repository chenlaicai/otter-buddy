---
id: F20260928zq7d
title: capability 长跑 DB 假死：vitest 超时僵尸采样根因定位与 budgetMs 预算修复（#1187）
change_type: fix
tags: [capability, test-infra, vitest, timeout, zombie-sampling]
modules:
  - tests/capability/helpers/assert-behavior.ts
  - tests/capability/*.capability.test.ts
created_in_conversation: d7377cfd-8497-4338-9fb5-366967ffe87e
summary: "#1187 根因：vitest it 超时只 reject 不取消测试函数，采样循环变僵尸，afterAll dispose 关 DB 后僵尸请求打 500 假象；修复 = expectSampledBehavior 加 budgetMs 墙钟预算 + 21 调用点对齐 it 帽"
from:
  - F20260928be9j
intent:
  trigger: "搭档指令：那你把1187干了，你重启下自己再来干吧（2026-09-28 15:26）"
  purpose: 根因定位 #1187（capability 单文件长跑后期 app SQLite 连接死掉级联失败）并修复
---

# capability 长跑 DB 假死：vitest 超时僵尸采样（#1187）

## 现象（issue #1187）

PR #1167 验证轮（9/25 round1）发现：capability 测试单文件长跑（big-otter-dispatch 2h+）后期，app 实例的 SQLite 连接死掉，后续采样级联失败：

1. bod AT-1 #2 起：`等待 invoke 创建超时`（480s 窗内 invoke 行不出现）
2. AT-2 #2-#3：`等待獭消息终态超时（240s）`
3. AT-2 #4 起：`createConversation HTTP 500: {"error":"The database connection is not open"}`——app 侧 DB 句柄已关闭
4. tsr 文件全部采样同型失败

对照证据：分文件跑（每文件 <30min）零复现；端点探活正常（0.9s）；r7/r8 短跑无此错误。

## 根因（三层证据闭环）

**不是 app 的 DB 自己死掉——是测试编排超时后 afterAll 关掉 app，僵尸断言还在打。**

### 机制链

1. **vitest it 超时只 reject Promise，不取消测试函数**（`@vitest/runner` withTimeout 源码：new Promise + setTimeout reject，无 abort）——超时后采样循环变"僵尸"继续挂在事件循环里
2. **预算算术超支**（结构性）：bod AT-1 单采样最坏 180s（消息）+480s（invoke）=11min，×5=55min > it 帽 50min；AT-2 240s+600s=14min ×7=98min > 帽 70min。端点一慢必撞帽
3. **撞帽后级联**：文件内 it 全部结束（含超时失败）→ afterAll `cleanup()` → `dispose()` 关 DB → 僵尸采样醒来继续请求 → HTTP 500 "database connection is not open" → 后续样本同型失败

### 机制实验（worktree 内 5 组零 LLM 复现，秒级）

| 实验 | 几何 | 证据（文件时间戳日志） |
|---|---|---|
| v1 | 3 采×1200ms vs 2000ms 帽 | sample#1 201 → it 超时 2006ms → afterAll 立即关 db |
| v4（决定性） | it1 撞帽 + it2 撑住事件循环 | it1-sample#2/#3 **在 it2 运行期间复活**，与 it2 并发共享 app/db |
| v5（终局） | 僵尸循环带 catch 结构（真实 helper 形态） | 僵尸 #2/#3/#4 与 it2 并发跑完，throw 被 catch 吸收，无文件终止 |

v4/v5 证明：超时被标失败的采样循环在下一个 it 运行期间继续执行（共享同一 app/db/事件循环），且其 throw 会被 expectSampledBehavior 的 catch 结构吸收——500 是僵尸打在已关 DB 上的症状。

### 时间线自洽对齐（9/25 round1）

- AT-1 #2 起超时 = bigOtterId bug（已修 07515eb4）每采样烧满 480s → AT-1 撞 50min 帽 → 僵尸挂起
- vitest 继续跑 AT-2 → AT-2 采样 #1 OK、#2-#3 消息超时（helper catch）→ **AT-2 也撞 70min 帽** → 文件 it 结束 → afterAll cleanup → dispose 关 DB
- **AT-2 僵尸 #4-#7 从 sleep 醒来** → createConversation 打死 DB → 500 级联
- tsr 文件（独立 fork）同型自爆：自己也撞帽（tsr it 帽 30min，3 采样×6min=18min 边缘 + 端点慢即穿）——非跨文件传染
- 「2h+ 才触发」= 需要端点足够慢 + 采样足够多把帽烧穿；「分文件跑零复现」= 不撞帽

### 已排除路径

- 生产代码唯一 DB close 点：`frameworks/db/database.ts:63` ← `shutdownDatabase` ← `app.dispose`（app.ts:655-662）← main.ts 信号/退出 & 测试 afterAll——无运行中触发点
- 多 DB 实例 GC finalize：initDatabase 单点单实例（bootstrap/database.ts:48）
- patrol/retryWorker 后台误关：duty 失败隔离 catch 落账，无 dispose 权限
- 跨文件进程传染：vitest forks+isolate，独立进程独立 DB

## 修复（narrow-fix）

### A. `expectSampledBehavior` 加墙钟预算（tests/capability/helpers/assert-behavior.ts）

新增 `opts.budgetMs`：采样循环开头检查 `Date.now() - start >= budgetMs` 即记 `SKIP 预算耗尽` 并 continue（不跑剩余采样）；成功数不变仍需 ≥ minSuccess。把"撞帽僵尸"变成"预算耗尽"的可读红。僵尸征兆专项诊断：异常消息含 "database connection is not open" 时附加提示。

### B. 全部 21 个调用点插入 budgetMs = it 帽 − 120s 余量

| 文件 | 调用数 | budgetMs |
|---|---|---|
| agent-behavior | 2 | 480000 |
| agent-collaboration | 1 | 480000 |
| big-otter-dispatch | 2 | 2880000 / 4080000 |
| html-card-proactive | 1 | 480000 |
| magic-words-signal | 5 | 480000 |
| memory-recall | 1 | 480000 |
| system-prompt-behavior | 8 | 480000 |
| talking-stone-routing | 1 | 1680000 |


## 验证

- 机制复现：v1/v4/v5 秒级复现僵尸链（证据日志见「机制实验」表）
- budgetMs 机制单测：预算 500ms/3 采×300ms → ran≤2（SKIP 生效）；无预算全跑不变
- 回归：tsc 干净 + 全量 4024 用例 passed（286 files）

## 影响范围

- **测试基建**：capability 采样循环新增预算护栏——慢端点下从"级联 500 假象"变成"预算耗尽 SKIP 明细"
- **不影响生产代码**：src/ 零改动；app 侧 dispose 链无变更
- 长跑回归建议：下次全量 capability 真跑时观察预算日志（`[capability] label 采样结果` 行）确认无僵尸 500

## 预期 vs 实际对照

| 项 | 预期（修复后） | 实际 |
|---|---|---|
| 慢端点撞预算 | 剩余采样 SKIP + 明细日志，测试红在根因处 | 单测验证 ✓ |
| it 超时僵尸 500 | 不再出现（预算 < it 帽，先耗尽先停） | 机制实验证明路径已封 |
| 快速端点正常跑 | budgetMs 不触发，行为与原来一致 | 4024 用例回归 ✓ |

## 参考

- issue #1187（现象与对照证据）
- F20260928be9j（#984 桥接，round1 日志来源）
- vitest withTimeout 源码（node_modules/@vitest/runner/dist/chunk-artifact.js:2261）
