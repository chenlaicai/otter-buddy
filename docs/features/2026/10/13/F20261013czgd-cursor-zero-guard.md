---
id: F20261013czgd
title: 游标归零防线——batchMaxSeq=0 哨兵无守卫写坏已读游标的全链修复
summary: 修复「已读游标被写成 0 → 下一轮全历史当未读注入爆窗」的系统性缺陷（10-13 同日三起：121K/75K/304K 字符注入）。根因链：触发消息被 triggerMessageId 去重后空批 → batchMaxSeq=0 哨兵 → pushCursorOnStartup 只挡 undefined 不挡 0 → updateLastReadSeq 无单调性校验无条件写入 → 游标从 2412 被覆盖成 0。修复：① 空批 batchMaxSeq 取对话当前 max(seq) ② updateLastReadSeq SQL 层单调性闸 ③ pushCursorOnStartup 对 <=0 直接 return（双保险）④ scheduler 直连兜底补传 batchMaxSeq。
change_type: fix
capability_test: "tests/frameworks/db/conversation/cursor-zero-guard.test.ts（7 用例：空批取 max(seq)、回退/等值/NULL 写入拦截、事故场景复现+反证）"
created_in_conversation: 526d9447-6b07-4783-8595-9977791e23f5
causal_links:
  - F20260922ctxi（触发消息去重引入空批场景；三处 invokeFn 闭包漏传 batchMaxSeq 的前科）
  - F20260929czi0（进场游标零点修正——「换世自动痊愈」论证建立在「游标永远读对」的无兜底假设上，本修复补上兜底）
  - F20260908rlcp（batchMaxSeq 游标推进机制的原始引入）
---

# 游标归零防线

## 事故实证

2026-10-13 对话《issue处理》（a9260c50）中大獭 session（01a13401）16:57:43 收到一条 528,082 字节的注入消息（session jsonl 第 784 行），内嵌 608 条历史条目（9/15 seq 1 → 10/13 16:53 全量），模型输出当场被 token 上限截断（stopReason=length）。同日另两起同型爆窗（06:39 121K 字符 / 08:31 304K 字符）。

字节级对账：DB 按「游标=0」口径回放 = 608 条/265,776 字符，与实际注入精确吻合。

## 根因链（双獭交叉核验：大獭 kimi 初判 + mimo-pro 对抗核验纠正归因）

1. `dispatch-chain-engine.ts`（buildMessageWithContext）：`filtered=[]` 时 `batchMaxSeq=0`——0 是「无新读」哨兵
2. 空批触发条件：触发消息是唯一未读、被 `excludeMessageIds`（triggerMessageId 去重，F20260922ctxi 引入）剔除后为空——**1:1 安静轮次必然命中**，与 restart 无因果
3. `pi-session-factory.ts:994`：只挡 `batchMaxSeq !== undefined`，**0 照写**
4. `conversation-repository-mixins.ts`（updateLastReadSeq）：无条件 `SET last_read_seq = ?`，无单调性校验
5. 下一轮 `getUnreadEntries` 按 `sequence_num > 0` 全量涌入；再下一轮 pushCursor(全量 max) 自愈——故表现为偶发

mimo 核验纠正的关键点：大獭初判归因于「14:44 restart 后空集批次」，证伪——真正的写 0 点是 16:53 普通消息轮次（jsonl L761，hist_rows=0/160 字符），restart 只是时间背景。

## 修复（四条）

| # | 改动 | 位置 | 性质 |
|---|---|---|---|
| ① | 空批 batchMaxSeq 取对话当前 max(seq)（经 idleStatsRepo.getMaxEntrySeq）而非 0——触发消息此刻已被消费（以 userMessageContent 形态在发言流末尾），游标本就该越过它 | dispatch-chain-engine.ts buildMessageWithContext | 根治（单点，覆盖全部 invokeFn 调用方 + scheduler 链路径同款缺陷） |
| ② | updateLastReadSeq 加 `AND (last_read_seq IS NULL OR last_read_seq < ?)`——任何未来路径写小值/0 在 SQL 层直接无效；被拦时 console.warn 留痕 | conversation-repository-mixins.ts | 纵深防线 |
| ③ | pushCursorOnStartup 对 batchMaxSeq<=0 直接 return + 推进打 debug 日志（prev→new） | pi-session-factory.ts | 双保险 + 观测补齐（本次全靠推断定位） |
| ④ | scheduler 直连兜底补传 batchMaxSeq（此前永不推进游标，定时任务消息反复当未读重注入）；entryRepo 无 getUnreadEntries 时降级跳过（行为与修复前持平） | scheduler-service.ts invokeAgentWithTimeout | 顺手修独立缺陷 |

## 验证

- 新增 7 用例（cursor-zero-guard.test.ts）：空批取 max(seq)、回退/等值/NULL 写入拦截、事故场景复现+反证（手动写 0 → 全量涌入，闸拦截后 unread 为空）
- 全量单元 5477/5477 绿（364 文件）；tsc --noEmit 干净
- scheduler 三套件（109 用例）修复前后对比：修复前主仓全绿；第一版改动致 28 失败（entryRepo mock 缺 getUnreadEntries），加降级守卫后 109/109 绿

## 影响范围

所有走 dispatch-chain-engine 的 invoke 路径（web/scheduler/resume/signal）；scheduler 直连兜底路径。不改读路径语义、不改游标推进时机（仍在启动成功后推进）。

**scheduler 直连兜底语义变化**（检视建议 2 处置补记）：invoke 启动成功（首事件到达）即推游标——若 invoke 中途失败，已消费的消息不再重注入（原口径：失败保持未读重注入）。取舍理由：启动成功=消息已进 LLM 上下文，中途失败重注入会重复消费；失败场景由 invoke 级重试/告警承接，不靠游标回退。

## 非目标

- 游标读路径的瞬态读异常防御（内存态合理性闸）——本次事故实证为写路径缺陷，读路径防御待有实证再补
- restart 恢复路径携带前世已读 seq 下限——mimo 核验证伪与本事故无因果，不做
