---
id: F20260923wtkx
title: capability 断言面桥接到 entries 直读（#984）
change_type: fix
created_in_conversation: d7377cfd-8497-4338-9fb5-366967ffe87e
intent:
  who: 本机跑 capability 测试（Golden Gate）的开发者与 PR 自检流程
  problem: "GET /messages 路由退役（F20260913ctlv #886，entries 为唯一渲染数据源）后，capability 测试 14 个场景中 11 个同型 HTTP 404/202——软代码 PR 本机无法全绿，每次都要靠「origin/main 基线对照」证明 pre-existing（issue #984）"
  trigger: "搭档：你看下历史消息，继续984的工作"
  expected_effect: "capability 断言面（listMessages/waitForOtterMessage 族）从已退役的 GET /messages 改为 entries 直读（GET /entries HTTP 路由拉全量投影 MessageDto + invokes/invoke_events 表测试进程内 DB 直查的混合），受影响文件本机真跑全绿；后续软代码 PR 的 Golden Gate 不再撞 404 墙"
verify_by:
  type: capability
  reason: "测试基础设施改动，验证=受影响文件真跑全绿（真系统+真 LLM 采样达标）"
summary: "#984：capability 断言面从已退役的 GET /messages 桥接到 entries 直读（GET /entries 拉全量投影 MessageDto + invokes/invoke_events DB 直查混合；status 取 invoke 真实态、tsp 优先 entry.yieldTargets+同 invokeId yield entry 回填、events 从 invoke_events 组装）。连锁修复 5 类断言病：①「停下」「星星罐子」改 halt 语义快照断言；②202 halted 短路响应不再当发送失败；③ReadableStream is locked 根因=res.text() 消费后再 cancel 撞锁；④tsp 改轮询「带 tsp 的 completed 发言」；⑤halt-boundary-injection skip（端点不识别 halt 指令，机制有单测覆盖）。真跑：spb 7过1跳 / mws 5过1跳 / bod 5:5+7:7（桥前 1/5）/ tsr 3/3。"
tags: [capability, test-infra, entries, golden-gate]
capability_test: "tests/capability/{system-prompt-behavior,magic-words-signal,big-otter-dispatch,talking-stone-routing}.capability.test.ts 真跑全绿（9/28 提交态分文件：/tmp/capab-round5-mws.log、round7-bod.log、round8-tsr.log、round3.log）"
causal_links:
  from:
    - F20260913ctlv
---

# capability 断言面桥接到 entries 直读（#984）

## 背景

issue #984：PR #979 自检实证——本机跑 capability 测试（Golden Gate）时 14 个场景中 11 个 fail，全部同型 HTTP 404/202。根因：`GET /messages` 已随 F20260913ctlv（#886）退役（messages 表停写，entries 为唯一渲染数据源），但 capability helper 的 `listMessages` 仍打这个路由。任何软代码 PR 在本机跑 Golden Gate 都撞同一堵墙。

## 方案

断言面桥接：`listMessages` 改 entries 直读（GET /entries HTTP 路由拉全量 + invokes/invoke_events 表测试进程内 DB 直查的混合，不改生产路由）——
- entries 表（speak/user）投影回 MessageDto 视图
- status：speak entry 的生命周期挂在 invoke 上（entry.status 恒 completed），取 invoke 态
- tsp：优先 entry.yieldTargets，同 invokeId 的 yield entry 回填兜底（不读 invokes.talking_stone_passed_to）
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

**最终轮（9/28，提交态 07515eb4，分文件跑）**：

- system-prompt-behavior：7 passed + 1 skipped（stop 3/3、starcandy 1/3 达标、detour 3/3）
- magic-words-signal：5 passed + 1 skipped（halt-boundary skip；l2 两用例 3/3、objection/blocked 3/3）
- big-otter-dispatch：AT-1 5/5、AT-2 7/7（桥前 1/5）
- talking-stone-routing：3/3 全过
- （otter-lifecycle 2 fail 为 pre-existing，涉 #1146 交接重构断言，与本分支无关，另开 issue）

**整改期间暴露的三个新问题（均以提交态复现验证修复）**：

| 轮次 | 问题 | 根因 | 修法（commit） |
|---|---|---|---|
| round1/2（9/25） | starcandy/stop 部分采样「场景未成立」 | 固定 8s 窗不够 boot 首响应 30s+ | 等 setupReply（afterSeq 锚定）替代 8s（aad81a65） |
| round1-6（9/25-28） | bod AT-1 #1 OK #2 起全挂、AT-2 0/7，反复出现 | 4157b0c9 整改引入 bug：`WHERE type='big' LIMIT 1` 在「每对话独立大獭」设计（R20260821tutv）下拿到 boot 獭，采样 #2 起 waitForInvokeSettled 等错獭 | bigOtterId 改取 bigOtterMsg.si（07515eb4）；mws 同病一并修 |
| round1（9/25） | 长跑后期「database connection is not open」 | bod 单文件 2h+ 长跑中 app DB 连接死掉 | 分文件跑规避；根因待查（与本分支测试面无关） |
| delta 轮（9/28） | 多 invoke 行时取行随机化致「提前返回→未派工」型假阴 flaky | 建议 2 处置引入：`ORDER BY id DESC` 假设 id 序=创建序，但 invoke.id = crypto.randomUUID()（send-entry.ts:217）字典序随机 | 改 `ORDER BY started_at DESC, rowid DESC`，注释改事实表述 |


## 影响范围

仅 tests/capability/ 下 4 个文件（helper + 3 个测试文件）+ 特性文档，不碰生产代码。

## 建议处置决策树产物（检视建议 4/5）

- **建议 4**：issue **#1186**（bug + P1）——otter-lifecycle 2 fail 两根因拆分：fail 1（restart summary 双写）归因 #1146 可信；fail 2（身份注入前缀）归因 #1146 已反驳（注入链路 pi-session-factory.ts:635 未被 #1146 触碰，d319b453 改动仅锁路径），独立排查
- **建议 5**：`Modification-Class: narrow-fix`（修法决策树①既有语义内修；测试基建 + 文档无机制新增；五个整改 commit 追溯适用，后续 commit 逐个声明）
