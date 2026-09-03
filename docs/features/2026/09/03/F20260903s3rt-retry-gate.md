---
id: F20260903s3rt
title: 'sgp2 S3：retry 入口换轨——闸门绕过漏洞修复'
doc_type: feature
summary: |
  09-03 全员会议定性的调度漏洞修复：retry 曾直连 executeChain 绕过全部调度闸门——
  限流熔断期间手动 retry 照跑撞 429 → orchestrator 落新 rate_limit 事件 →
  熔断窗口重置 → 自动点火继续冻结（搭档实锤）。修复：新增 SignalRouter.retrySignal
  （闸门限流/停机判定 + source='retry' 记账 + 与自动点火共用 invokeTarget），
  message-controller 的 startRetryChain 换轨调用；路由器未注入降级保留直连链。
  附带 routeTarget/invokeTarget 的 source 参数化与 HALT 守卫方法抽取（lint 复杂度收敛）。
status: final
change_type: fix
tags: [signal-protocol, retry, dispatch-gate, incident-hardening]
modules: [src/usecases/conversation/signal-router.ts, src/interface-adapters/http/controllers/message-controller.ts]
created_in_conversation: 52bfdd91-a61e-4323-b1f7-1fe3daaadc32
capability_test: "n/a: 后端调度变更（A 类），行为由 S3a/S3b/S3c 三判据 + 全量回归覆盖"
causal_links:
  from:
    - F20260902sgp2   # 父特性
    - F20260903ihlt   # 闸门机制（retry 绕过的正是它）
---

# F20260903s3rt: retry 入口换轨（S3）

## 漏洞（09-03 全员会议定性，搭档实锤）

retry 直连 executeChain 绕过 #766 的全部调度闸门：限流熔断期间手动 retry →
invoke 撞 429 → orchestrator 落新 rate_limit healing 事件 → **熔断窗口被重置** →
自动点火继续冻结。用户想修一个问题，结果把全会话恢复推后一小时。

## 修复

**SignalRouter.retrySignal(conversationId, messageId, targetOtterId, signal)**：
1. 闸门（双判）：用户停机（防御性，调用方应已 clearUserHalt）→ retry_gated；
   限流熔断 → retry_gated——**用户显式 retry 不能重置熔断窗口**（「点一下重试」≠
   「把全会话恢复推后一小时」）
2. 记账：routeTarget → invokeTarget 传 source='retry'，INSERT OR REPLACE 覆盖
   同 (message,target) 槽位，前情压缩进 note（§8.2）
3. 点火：与自动点火共用 invokeTarget（busyQueue 排队语义一致）
4. message-controller：startRetryChain 检测「路由器在位 + retry 信号实体」→ 换轨
   retrySignal；retry_gated 时向用户推送 system.message 如实反馈（不再静默）；
   settle 等待与 K3 同语义（attempt 终态驱动关流）；路由器未注入 → 降级直连链

## 结构收敛（顺带）

- routeTarget/invokeTarget 参数化 source（chain/router/retry）——retry 与自动点火
  共用档位矩阵、busyQueue、阻尼全套机制，零分叉
- HALT-到-小獭拦截抽为 haltToSmallOtterGuard 私有方法（routeTarget 复杂度回落阈值内）
- invokeTarget 六参数（lint 上限 5）：triggerMessageId+source 合并 ledger 对象

## 测试（S3a/S3b/S3c，signal-router-ledger.test.ts）

- S3a 正常 retry：过闸门 + source='retry' 记账 + 链点火
- S3b 熔断中 retry → retry_gated，零点火零记账零新 rate_limit 事件（**漏洞修复判据**）
- S3c 用户停机 → retry_gated；clearUserHalt 后可正常 retry

## 验证

后端 232 files / **2863 tests** 全绿；tsc 干净；eslint 0 error（routeTarget/invokeTarget
的复杂度/参数数用结构性重构解决——HALT 守卫抽取 + ledger 对象，非 disable 压制）。
