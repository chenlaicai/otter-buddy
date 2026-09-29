---
id: F20260929cssm
title: bash 守卫 sleep 拦截跨段求和
date: 2026-09-29
change_type: fix
capability_test: "n/a: 纯守卫规则改动（verify_by=static_only：跨段求和 10 用例 + frameworks/agent 911 回归全绿——判定面为确定性静态规则，无 LLM 行为）"
created_in_conversation: d7377cfd-8497-4338-9fb5-366967ffe87e
summary: 修 #1216 守卫 sleep 拦截逐段独立判定可拆分绕过——改命令内跨段累计（sleep 3 && sleep 3 = 6s 拦），unparseable 段保守放行，跨命令（invoke 级）累计归已知逃逸面留观测锚。生产合法微 sleep 实测最大累计 3s，门槛 5s 有 2s 余量零误拦。
tags: [guard, sleep, security, rule]
modules: [src/frameworks/agent/guard-model-judge.ts, tests/frameworks/agent/guard-sleep-cross-segment.test.ts]
closes: 1216
intent:
  problem: "#1216 守卫 sleep 拦截逐段独立判定、跨段不累加（guard-model-judge.ts judgeSleepCommand）——sleep 4×N 拆分可静默任意时长，绕过「等待必须走 wait 工具」的引导漏斗"
  expected_effect: "命令内拆分形态（sleep 3 && sleep 3）被拦；生产合法微 sleep（kill 后功能等待，累计 ≤3s）零误拦；跨命令累计不做（生产零逃逸 + 有状态成本），归已知逃逸面"
  verify_by:
    type: static_only
causal_links:
  - rel: relates-to
    target: F20260928slan
    note: "#1126 建立守卫 sleep 拦截（单段口径）——本 PR 封跨段拆分缺口，变量形态（sleep $X）维持宁漏勿误同口径"
  - rel: relates-to
    target: F20260929sawt
    note: "#1210 检视轮发现该缺口（范围外观察 + delta 建议），delta1 确认守卫真实口径为弹回漏斗——本 PR 是漏斗的拆分面补全"
---

# bash 守卫 sleep 拦截跨段求和

## 背景（#1216）

PR #1210 检视轮发现：守卫对 sleep 的拦截是逐段独立判定、跨段不累加——`sleep 4`×5 串联或分次全部放行，合计可静默 20 秒+，绕过「等待必须走 wait 工具（speak 先行 + reason 自证）」的引导漏斗。

## 方案选型（生产数据驱动）

三条路（issue 列举）：①invoke 级累计（有状态）②拆分启发式（复杂）③保持现状+声明。**实际选第四条：命令内跨段求和（无状态）**——依据：

- 生产合法微 sleep 全为 `kill; sleep 1/2` 类功能性等待（日志实测分布），单命令内累计最大 3s（sleep 2; sleep 1）
- 求和门槛 5s → 2s 余量，合法面零误拦
- 拆分逃逸形态（sleep 4×N）生产零出现，但规则层面应封——封了才能让「弹回漏斗」的漏斗壁完整
- 跨命令（invoke 内多次 bash 调用）累计需要跨调用状态，生产零逃逸下暂不做——归已知逃逸面，`[guard-v2]` 拦截日志为观测锚

## 实现（guard-model-judge.ts judgeSleepCommand）

原逻辑：逐段独立判定（段内多参数已求和：sleep 5 6 = 11s）。

新逻辑（#1220 检视处置后最终形态）：
1. `commandTotal` **命令树**累计（顶层段 + 各层载荷段——bash -c / $() 套壳内 sleep 同计，同构 kill 判定 payload 树遍历先例）；文案统一在判定后构造、报累计总值（`sleep 3 && sleep 6` 报 9 秒，镜像序同）
2. `unparseable` 段（sleep $X）：不计入求和、该段保守放行——宁漏勿误（#1126 同口径：变量值不可判，求和面取放行侧）。不可解析载荷含 sleep 词样同样放行（sleep 拦截是体验引导非安全红线，与 kill 判定的保守拦截不同档）
3. `infinite` 优先于有限累计判拦（语义更严重）
4. float 求和取 1e-9 容差（`sleep 0.1`×50 = 4.999999…不因 IEEE 舍入漏拦）
5. 跨段累计 ≥5s：拦，文案在全树扫完后统一构造（判定与文案分离——delta Δ1：镜像序 `sleep 6 && sleep 3` 曾提前 return 报首段 6 秒实 9）；float 显示取整（≥10s 四舍五入到秒，<10s 保留 1 位——`sleep 0.1 && sleep 4.9` 报「5 秒」非 4.999…）

**已知逃逸面声明**（宁漏勿误口径，非「封堵」）：
- **循环倍数**（`for i in 1..N; do sleep 2; done`、`while true; do sleep 2; done`）：循环次数静态不可判，循环体按 1 次计——保守拦循环体会误杀合法轮询重试形态，归逃逸面（接受型逃逸面，真相源 = 本文档；生产日志实测循环内 sleep 零出现，风险纯理论）
- **xargs 载荷倍数**（`seq 5 | xargs -I{} sleep 2` 等）：xargs 展开次数静态不可判，与循环倍数同档，归逃逸面
- **跨命令累计**（invoke 内多次 bash 调用各 <5s）：需跨调用状态，生产零逃逸，归逃逸面留观测锚（`[guard-v2]` 拦截日志；接受型逃逸面，真相源 = 本文档）

## 验证

- 跨段求和 20 用例全绿（初版 10 + 检视处置 7 + delta 处置 3：镜像序文案总值 / 镜像序 infinity 优先 / float 显示去尾）
- frameworks/agent 全量回归绿（守卫家族 47 files；用例数随补锚增长，以当轮跑数为准——收敛轮 921）
- tsc 干净

## 影响范围

- 命令内拆分（含套壳载荷）逃逸面封堵；循环倍数与跨命令累计为**已知逃逸面**（见上声明）——漏斗壁覆盖直接拆分与套壳形态
- 误拦面：合法命令内累计 ≥5s 的多段微 sleep 会开始被拦（生产实测该形态不存在；真出现时弹回文案引导改 wait，属设计内引导非误伤）
- 跨命令累计仍开放（已知逃逸面，观测锚 = 拦截日志）
