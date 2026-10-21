---
id: F20261021plbd
title: 全量并行测试 flake 处置——vitest 并行负载预算收窄（M-d39f3327）
summary: "全量 vitest 并行下 5s 默认预算测试随机红（cursor-zero-guard ③ 等，5.3-6.9s 停顿拖时）污染每单 PR 零回归判定。根因=负载超订：默认 worker 池=16（CPU 计数）×isolate per-file 把 8 物理核打满，叠加常驻 200% CPU 的 bge-m3 嵌入 worker 等环境负载，冷启动重的测试被调度饿死拖过预算——负载调度问题非被测代码问题。修法=vitest.config.ts maxWorkers:4（对照矩阵：默认 3/5 跑红 → 4 workers 3/3 全绿、受害测试 2.1-2.2s 余量 2.9s；8 workers 贴线 4.99s 统计必复发；--no-isolate vi.mock 失活语义污染 52 红硬否决）。只收并发不碰断言/超时预算。"
capability_test: "n/a: 测试基础设施配置变更，无产品行为面——验证=对照矩阵与重复全量证据（默认 3/5 红 vs maxWorkers=4 3/3 全绿 + 停顿分布证据），非单测钉死对象。golden 豁免声明（沿 #1318/#1377 先例）：不涉 golden_replay 断言面，无 golden-results.jsonl 记录系按设计不落账"
change_type: fix
intent:
  problem: "M-d39f3327：全量并行测试 flake——vitest 并行负载下 5s 超时类测试随机红（今天 5 次全量 3 红），隔离复跑恒绿、基线复现坐实 pre-existing；每单 PR 的零回归判定被污染"
  expected_effect: "全量并行下 5s 默认预算测试不再随机红（受害测试停顿从 5.3-6.9s 降到 2.1-2.2s）；测试断言/超时预算零改动（非测试弱化）；CI（2-4 vCPU）不受负面影响（预算上限在小机器上是无操作）"
  verify_by:
    type: capability_test
modules:
  - vitest.config.ts
from:
  - F20261014czgd
created_in_conversation: 7b41e085-5c21-4bd1-adfe-dc3ef051753d
doc_type: feature
tags: ["test-infra", "vitest", "flake", "parallel-load", "timeout-budget", "bugfix"]
created_at: 2026-10-21T17:30:00+08:00
---

## 预注册段（排查前冻结的预期，防 HARKing）

> 1. **预期根因方向**：全量并行下 worker 池（411 isolate workers）把 16 逻辑核打满——重导入链（DB/app 装配）冷启动 + 系统级 CPU 竞争把个别测试拖过 5s 默认预算。是负载调度问题不是被测代码问题（症状集中在冷启动重的文件、机器负载越高越红）
> 2. **验证标准**：①全量并行可复现 ≥5s 停顿 ②限制并发（maxWorkers 减半/再减半）后多次全量零红 ③隔离单跑恒绿 ④停顿落点随机（非特定测试独有）——四条全成立=预期成立
> 3. **放弃条件（最强反例）**：限制并发后 cursor-zero-guard ③ 仍稳定红、或隔离单跑也偶红 → 问题在测试自身（真异步等待/DB 慢路径/全局状态），转向测试代码级根因

## 问题现象

全量 `npx vitest run` 并行负载下 5s 默认预算测试随机红（同日 5 次全量 3 红：cursor-zero-guard ③ 停顿 5331/5981/6886ms、build-app 健康端点 6873ms），隔离复跑恒绿（16/16）。flake 非确定性落点、跨 PR 复发（#1533 二轮首跑 7 例、#1597/#1600 各撞一次），每单 PR 的「零回归」判定被污染。`tests/frameworks/db/conversation/cursor-zero-guard.test.ts`（无显式超时、真 better-sqlite3 同步原生调用）是最常见受害者，但落点不唯一（④ 预注册项成立）。

## 根因分析

**负载超订（调度问题，非被测代码问题）**——预注册①成立：

| 证据 | 锚点/出处 |
|---|---|
| vitest 配置全默认：无 maxWorkers/pool/testTimeout——worker 数=CPU 计数（16 逻辑）×isolate per-file | `vitest.config.ts` test 块（改前形态，git 历史 7b5d7c05 前） |
| 机器底子 8 物理核/16 逻辑 + **常驻 bge-m3-worker.js 200% CPU**（吃 2 核）+ 多 node 常驻进程 | `ps` 实测（排查现场记录） |
| 默认负载下停顿重尾：28-29 例 >2s、3 例 >5s、受害测试 5.3-6.9s | 对照矩阵 A 臂（flake-A1/A2.json） |
| culprit 测试本体通常 18-33ms——停顿纯属调度饿死非自身慢 | 对照矩阵 C 臂同测试 2.1-2.2s、隔离 18ms |

机制链：16 workers（每文件独立进程，~635ms 启动）× 重导入链（DB/app 装配）+ 2 核被嵌入 worker 常驻占用 → 物理核 2x+ 超订 → 同步原生调用（better-sqlite3）与冷启动导入在 CPU 排队里被拖过 5s 默认预算 → 随机红。

**放弃条件核验（预注册③）**：未触发——限制并发后受害测试稳定 2.1-2.2s，隔离单跑恒绿。

## 对照矩阵（全量 6614 例，串行执行避免相互污染）

| 臂 | 配置 | 全量结果 | over2s | over5s | 最慢 5s 预算测试 | wall |
|---|---|---|---|---|---|---|
| A1/A2 + 历史 3 跑 | 默认（16 workers） | **3/5 跑红**（历史）+2/2 本次绿 | 28-29 | 0-3 | cursor③ 5331-6886ms | ~56s |
| C1/C3/C4 | **maxWorkers=4** | **3/3 全绿** | 12-25 | 0-1* | cursor③ 2087-2211ms（余量 2.9s） | 107-164s |
| C2 | maxWorkers=8 | 1/1 绿 | 26 | 0 | **4.99s 贴线**（11ms 余量） | 78s |
| D1 | --no-isolate | **52 红（语义污染）** | 38 | 5 | cursor③ 4999ms | 66s |

\* C4 的 >5s 例是 game-harness 自带长预算用例（非 5s 预算受害者）。D1 定性：52 红全是**测试独立性破坏**——`vi.mock` 失活（mock 注册表按 worker 隔离，共享模块缓存使拦截失效，guard-dual-chain 12 连红自报「mock 失活静默虚绿」）、bash-sandbox OS 探测状态串台、merge-pr-tool 23 连红——vitest 输出提示的「no-isolate 快 16s」是陷阱，硬证据否决。

**预期 vs 实际**：预注册四条验证标准 ①可复现 ≥5s 停顿 ✓（3/5 红）②限并发后多次全量零红 ✓（3/3）③隔离恒绿 ✓ ④落点随机 ✓（cursor③/build-app/game-harness 轮换）——**预期成立**。

## 修法

`vitest.config.ts` test 块设 `maxWorkers: 4`（附证据注释）——收窄测试运行器的并行调度管辖到证据担保的预算。**只收并发，不碰任何测试断言/超时预算**（大獭派工红线：不许加长默认超时糊弄；diff 零测试文件触碰，test-weakening gate 零删除零放宽）。

**选择 4 不选 8**：8 workers 实测最慢 4.99s=5s 预算 11ms 余量，环境负载波动（常驻嵌入 worker + 其他进程）下统计必然复发；4 workers 受害测试稳定 2.1-2.2s=2.9s 余量，C4 臂环境负载高峰下 5s 预算受害测试仍稳（>5s 仅长预算用例）。**CI 不受影响**：GitHub runner 2-4 vCPU，预算上限在小机器上是无操作。

**机制识别检查点**：命中「新增配置字段」字面项（vitest.config.ts 增 maxWorkers 键）——**为何命中但不涉净新增机制**：maxWorkers 是测试运行器 vitest 的既有旋钮（非产品机制、无运行时行为、无状态/定时/信号/持久化/跨模块调用），只是此前未设值；无新代码路径。修法决策树②（收窄问题机制=并行调度器的并发管辖）。

## 影响范围

- **全量本地 wall**：~56s → 107-164s（明确接受的代价，换确定性绿）
- **CI**：无负面影响（runner 核数 ≤ 预算上限时无操作；CI 全量 ~3min 不变）
- **测试面**：零改动——断言/超时预算/隔离语义全保留（no-isolate 曾是候选，因破坏 vi.mock 语义被否决）
- **高核开发机**：32 核也只有 4 workers 是天花板——当前证据只担保 4；若需提速应先补停顿分布证据再调预算，不拍脑袋

## 验证（验收断言化）

| 场景 | 操作 | 预期结果 |
|---|---|---|
| flake 消除 | `npx vitest run` ×3（maxWorkers=4 已入配置） | 3/3 全量零红 |
| 受害测试停顿 | 同上（JSON reporter 取 cursor③ 时长） | ≤2.5s（余量 ≥2.5s） |
| 零弱化 | `git diff origin/main -- tests/` | 零输出（测试文件零触碰） |
| 单测不回归 | `npx vitest run tests/frameworks/db/conversation/cursor-zero-guard.test.ts` | 全绿 |

**残余记档**：①环境负载极端高峰（多重型进程叠加）时长预算用例仍可能超自身预算——但那属用例自身预算声明责任，非本 flake 面；②若未来全量文件数增长再度推高停顿尾部，按同一对照矩阵方法重测预算，不回退默认值。
