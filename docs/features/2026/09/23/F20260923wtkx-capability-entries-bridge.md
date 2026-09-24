---
id: F20260923wtkx
title: capability 断言面桥接到 entries 直读（#984）
change_type: fix
created_in_conversation: d7377cfd-8497-4338-9fb5-366967ffe87e
intent:
  who: 本机跑 capability 测试（Golden Gate）的开发者与 PR 自检流程
  problem: "GET /messages 路由退役（F20260913ctlv #886，entries 为唯一渲染数据源）后，capability 测试 14 个场景中 11 个同型 HTTP 404/202——软代码 PR 本机无法全绿，每次都要靠「origin/main 基线对照」证明 pre-existing（issue #984）"
  trigger: "搭档：你看下历史消息，继续984的工作"
  expected_effect: "capability 断言面（listMessages/waitForOtterMessage 族）改为 DB 直读 entries/invokes/invoke_events，受影响文件本机真跑全绿；后续软代码 PR 的 Golden Gate 不再撞 404 墙"
verify_by:
  type: capability
  reason: "测试基础设施改动，验证=受影响文件真跑全绿（真系统+真 LLM 采样达标）"
summary: "#984：capability helper 的断言面从已退役的 GET /messages 桥接到 DB 直读（entries 投影 MessageDto：status 取 invoke 态、tsp 取 invoke.talking_stone_passed_to、events 从 invoke_events 组装）。连锁修复 5 类断言病：①「停下」「星星罐子」改 halt 语义快照断言（不再等永远不会来的新消息）；②202 halted 短路响应不再当发送失败；③ReadableStream is locked 根因=res.text() 消费后再 cancel() 撞锁；④tsp 读法改轮询「带 tsp 的 completed 发言」（halt/信号路径下 invoke 行可能不创建）；⑤halt-boundary-injection 用例 skip（测试端点 mimo-flash 不识别 halt 指令，3 轮 9 采样 0 落账，机制有单测覆盖）。真跑验证：spb 全过 / mws 5过1跳 / bod AT-1 5/5、AT-2 7/7（桥前 1/5）/ tsr 全过。"
tags: [capability, test-infra, entries, golden-gate]
capability_test: "tests/capability/{system-prompt-behavior,magic-words-signal,big-otter-dispatch,talking-stone-routing}.capability.test.ts 真跑全绿（/tmp/capab-r7.log、capab-r8-*.log）"
causal_links:
  from:
    - F20260913ctlv
---

# capability 断言面桥接到 entries 直读（#984）

## 背景

issue #984：PR #979 自检实证——本机跑 capability 测试（Golden Gate）时 14 个场景中 11 个 fail，全部同型 HTTP 404/202。根因：`GET /messages` 已随 F20260913ctlv（#886）退役（messages 表停写，entries 为唯一渲染数据源），但 capability helper 的 `listMessages` 仍打这个路由。任何软代码 PR 在本机跑 Golden Gate 都撞同一堵墙。

## 方案

断言面桥接：`listMessages` 改 DB 直读（不改生产路由）——
- entries 表（speak/user）投影回 MessageDto 视图
- status：speak entry 的生命周期挂在 invoke 上（entry.status 恒 completed），取 invoke 态
- tsp：yield 时落账在 invoke.talking_stone_passed_to，优先取 invoke
- events：从 invoke_events 按 invokeId 组装

## 连锁修复（真跑 8 轮暴露的断言病）

| 病 | 根因 | 修法 |
|---|---|---|
| 「停下」「星星罐子」超时/0/3 | halt 后无新 completed 消息，waitForOtterMessage 等不到是预期语义 | 改 halt 语义快照断言（前后对比新增副作用工具） |
| l2-stop-word-command 0/3 | 202 halted 短路响应被当发送失败 | 202+"halted" 合法放行；断言窗口改快照对比 |
| ReadableStream is locked | res.text() 消费后 res.body.cancel() 撞锁 | 202 分支提前 return 不再 cancel |
| AT-1 1/5、halt-boundary 无 tsp | speak(completed)≠回合结束；tsp 在 yield 落账 invoke，且 halt/信号路径下 invoke 行可能不创建 | 改轮询「带 tsp 的 completed 发言」出现为止 |
| halt-boundary-injection 0/3 | 测试端点 mimo-flash 不把「停掉小獭」识别为 halt_otter 指令（3 轮 9 采样 0 落账） | it.skip + 注明端点限制（机制有单测覆盖） |

## 真跑验证（真系统 + 真 LLM）

- system-prompt-behavior：8 tests 全过（含 magic-word-stop、starcandy 达标）
- magic-words-signal：5 passed + 1 skipped
- big-otter-dispatch：AT-1 5/5、AT-2 7/7（桥前 1/5）
- talking-stone-routing：全过
- （otter-lifecycle 2 fail 为 pre-existing，涉 #1146 交接重构断言，与本分支无关，另开 issue）

## 影响范围

仅 tests/capability/ 下 4 个文件（helper + 3 个测试文件），不碰生产代码。
