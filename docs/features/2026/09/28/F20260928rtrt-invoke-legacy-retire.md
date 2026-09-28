---
id: F20260928rtrt
title: 右栏状态旧补丁退役（门控/双函数/重试链/反查链四件收敛）
doc_type: feature

summary: |
  F20260928icmm 缓存模型换轨（阶段1 #1179 + 阶段2 #1185）落地后，历史上为对抗
  弱合并缺陷而生的四件补丁失去存在理由，本 PR 集中退役防患：① invokeStatesLoadedRef
  防双拉门控退役（弱合并换轨后双拉无害化，幂等 merge 重复拉取零副作用）；②
  syncInvokeStatesFromServer/OnReconnect 双函数收敛为单函数（#1161 的过渡拆分完成
  使命）；③ 600ms/2500ms 重试链降级为单次 600ms（60s 周期对账 + focus/导航/流结束
  读点是更强兜底，短重试链无增量价值）；④ findOtterByInvokeId 反查链退役（唯一
  发射点 agent-invoker.ts:554 恒带 otterId（必填非空，检视核实 createTurnCallbacks 单一
  调用点传入），退役无丢失风险）。
  净删约 40 行机制代码与一个 ref/一个反查函数，零新增机制。

type: Refactor
domain: web
status: implemented
created: 2026-09-28
created_in_conversation: 5603032d-569c-42c1-b318-1e3b4629ab1f
related_issues: [1160]
related_pr: []
causal_links:
  - F20260928audt
  - F20260928icmm
  - F20260924ircc
  - F20260923sswd
---

# 右栏状态旧补丁退役：四件收敛

## 背景

架构獭-mimo 联合排查（9/25）的完整方案分三阶段，阶段 3 是退役清单——搭档拍板
「把 3 做完，省的回头 3 引入问题还得重来」。四件补丁全是弱合并时代的产物：
缓存模型换轨后，它们的防护对象（双拉覆盖、事件丢终态无兜底、invoke.end 无 otterId）
要么不再存在、要么已有更强的接替者。退役越早，未来改动与旧补丁互相踩的面越小。

## 退役清单

| # | 补丁 | 引入背景 | 退役理由 | 接替者 |
|---|---|---|---|---|
| 1 | `invokeStatesLoadedRef` 防双拉门控 | F20260923sswd（#1144）：初始内联拉取与重连补偿双拉竞态 | 弱合并退役后 merge 幂等（无变更返回原引用），双拉零副作用——门控失去存在理由；且它曾在 #1144 错误覆盖补偿路径引入回归（#1160 根因之一），是历史风险点 | mergeInvokesFromServer 幂等语义 |
| 2 | `syncInvokeStatesOnReconnect`（无门控补偿函数） | F20260924ircc（#1161）：门控误伤补偿路径的过渡拆分 | 双函数职责已随门控退役而重合，收敛为单函数 `syncInvokeStatesFromServer`（无门控），全部 7 处调用点统一 | 单函数 |
| 3 | 600ms/2500ms 双次延迟重试链 | F20260923sswd（#1144）：初始内联拉取失败静默吞的补丁 | 阶段2 的 60s 周期对账 + focus/导航/POST·retry 流结束读点是更强兜底（检视补：空态也拉后覆盖「拉取全败+用户不动」残余窗口），短重试链无增量价值 | 阶段2 读点矩阵 + 周期对账 |
| 4 | `findOtterByInvokeId` 反查函数 | 旧注释称「invoke.end 发射不带 otterId」（架构獭已证过时） | 唯一发射点 agent-invoker.ts:554 恒带 otterId（检视核实：emitInvokeEnd 唯一生产实现、orchestrator 六处调用全走它、otterId 必填非空传入） | 事件自带 otterId |

## 修改点

- `web/src/pages/conversation/index.tsx`：删门控 ref 及读写（3 处）、双函数合一（保留 FromServer 名、7 处调用点统一）、重试链 2500ms 分支退役、3 处 `d.otterId || findOtterByInvokeId(...)` 改 `d.otterId`、deps 数组去重；检视处置补：周期对账空态也拉（初始拉取全败且用户不动时状态空、hasRunning 门不可达的残余窗口）
- `web/src/lib/invoke-tracker.ts`：删 `findOtterByInvokeId` 函数（留退役说明注释）
- 测试：invoke-tracker.test.ts 删反查用例块；index.spa-nav.test.tsx 重试用例按单次 600ms 语义改写（failCount 3→2，断言 3000ms 后无第二次重试）

## 取舍记录

- **为什么重试链保留一次 600ms 而非全删**：初始拉取失败时 600ms 快速重试能覆盖「瞬时抖动」（常见：页面刚进入时连接未就绪），成本一行；全删则首屏右栏空状态要等用户交互或 60s 周期——首屏体验不值得省这一行。
- **为什么不顺手退役 SSE 看门狗**（40s liveness）：它管「连接活性」（检测静默半截），周期对账管「数据正确性」——两者正交（检视獭-1185 亦确认互补），非冗余。
- **Modification-Class: narrow-fix**（净删机制，零新增）。

## 测试

- 重试用例语义反转改写（单次 600ms + 3000ms 无二次重试断言）
- web 573/573（59 文件，反查用例 -1、重试用例语义改写）+ tsc 0 + eslint index.tsx 0 warnings
- 服务端零改动（纯前端退役）

## 影响范围

- 净变化：index.tsx 约 -30 行、invoke-tracker.ts -7 行、测试改写 2 处
- 消费者面（RightPanel 中断/重试按钮、Session 弹窗）读的 invokeStates 数据形状零变化
