---
id: F20260922wxeg
title: 微信出站锚断裂修复：出站目标经 metadata.lastChatId 定向（ilinkUserId）+ 删助理号连同助理对话移除
summary: 搭档重启系统后实测两个 bug。①严重：微信侧完全收不到回复——F20260921wxba 把入站路由锚统一为 bot 账号 id 后，出站链（weixin-message-channel 四处）仍拿 connection.externalId（已是 bot 账号 id 如 weixin-muawxk7x）当收信人，而 context_token 表按真实用户 id（ilinkUserId）键——收件键错误 + token 查不到，ilink sendmessage ret=-3 invalid arguments（日志 1121344 实锤，hasContextToken:false）。这是 #1073 入站锚修复的镜像遗漏：入站锚修了、出站消费侧没跟上。修复照飞书增量五同构：入站 processor noteChatId 记录 fromUserId + provision 建线时记录扫码人 ilinkUserId + resolveReplyTarget 扩展 weixin 分支（bot 锚 connection 走 metadata.lastChatId，无目标返回 null 跳过发送不裸发）。②删助理账号时对应助理对话只解绑不删，Web 侧留残对话（连接走了对话还在）——onWeixinAccountDeleted 释放绑定前按 connection.metadata.assistantConversationId（provision 时记录的归属护栏，防 /in 挪线误删）archive 该对话；前端删除确认文案说明会连同对话删除。
doc_type: feature
change_type: fix
capability_test: "n/a: 出站路由/清理链变更，无 prompt 行为语义可测（回归用例：tests/usecases/im/weixin-message-channel.test.ts F20260922wxeg 三例 + manage-connection.test.ts resolveReplyTarget 五例）"
created_in_conversation: b11cf010-f20d-4f92-88e6-ecc6414017a6
tags: [weixin, im, assistant, routing, egress, bugfix]
modules:
  - src/usecases/im/weixin-message-channel.ts
  - src/usecases/im/manage-connection.ts
  - src/interface-adapters/weixin/message-processor.ts
  - src/app.ts
  - web/src/pages/im/index.tsx
  - tests/usecases/im/weixin-message-channel.test.ts
  - tests/usecases/im/manage-connection.test.ts
  - tests/interface-adapters/weixin/message-processor.test.ts
causal_links:
  - F20260921wxba
  - F20260920imax
created_at: 2026-09-22
---

# 微信出站锚断裂修复 + 删号连删对话

## 预注册（动手前冻结）

- 预期根因方向：P1 出站链用了 bot 账号 id 当收信人（#1073 入站锚修复的镜像遗漏），context_token 表按用户 id 键查不到
- 验证标准：日志出现 `toUserId=weixin-*` + `hasContextToken:false` + `ret=-3`；代码中出站链消费 connection.externalId 的 file:line
- 若证据指向「context_token 过期/账号 token 失效/账号目录已删」则放弃原预期

实际：预期命中。日志行 1121344（`toUserId:"weixin-muawxk7x"`, `hasContextToken:false`, `ret:-3 invalid arguments`），stack 指向 `weixin-message-channel.js:135 deliverSpeakToWeixin`；账号目录存在且 context-tokens.json 有真实用户 token（`o9cq8003MV3gt9XILrwg5RHYIgHg@im.wechat`），只是出站按 bot 账号 id 键查表必然 miss。

## 问题现象

搭档 9/22 重启系统（合入 #1073+#1075 后）实测：

1. **微信侧完全收不到回复**（web 能看到微信发来的 hi，回复从未送达）
2. IM 页移除助理账号后，对应的助理对话仍残留在 Web 对话列表

## 根因分析

### P1 出站锚断裂（严重）

证据链：
1. 入站正常：用户「hi」落 `entries`（conv `09f8e8a6`，entry `572c982d`，07:18:53），context_token 正常落盘（`data/weixin/weixin-muawxk7x/context-tokens.json` 键 = `o9cq8003…@im.wechat`）
2. 出站断裂：`weixin-message-channel.ts` 四条投递路径（deliverSpeakToWeixin / deliverUserEntryToWeixin / deliverFailureNotice / maybeSendThinkingMessage）全部以 `connection.externalId` 为收件人
3. F20260921wxba 后 bot 锚 connection 的 externalId = accountId（`weixin-muawxk7x`），不是收信人 → `weixin-gateway-adapter.resolveContextToken(toUserId)` 按 bot id 查表必然 miss → `hasContextToken:false` + 错误收件人 → ilink `ret=-3 invalid arguments`（日志行 1121344，pid 88991，07:19:48）
4. 镜像关系：#1073 修的是**入站**锚（建线锚 accountId vs 消息锚 fromUserId 分裂），本次是**出站**消费侧没跟上同一锚变更——出站目标仍是「人」的 id，而 connection 的 externalId 已经不再是人

为何审视没抓到：#1073/#1075 两轮检视焦点在入站路由与 UX 流程，出站投递的收信人语义在测试里被 mock 的 connection（externalId=wx-user-1 形态，不触发 bot 分支）掩盖——mock 形态与线上真实 connection 形态（weixin-*）不一致，测试通过但线上必炸。本轮测试 mock 已改为穿透真实 resolveReplyTarget 语义。

### P2 删号不删对话

`onWeixinAccountDeleted`（app.ts）只释放 connection 活跃绑定（releaseSession），对话本体（conversations 表）不动——Web 列表仍显示「我的微信」等残对话。搭档指令（9/22）：「移除已有的助理时，对应的对话也要直接删除移除掉」。

## 修法排序与机制识别

- 命中清单：新增跨模块调用路径（processor→noteChatId、app.ts→mergeMetadata/archive）——但均为**既有机制的语义内复用**：noteChatId/mergeMetadata 是 F20260920imax 增量五为飞书 bot 锚建的现成机制，resolveReplyTarget 是现成出站定向口，archive 是现成对话生命周期动作。本修复 = 微信侧接入既有机制 + 出站消费侧改用既有解析口，无新增机制。
- 修法排序：① 既有机制语义内修（缺啥补啥）——Modification-Class: narrow-fix
- 不新增机制论证：出站目标记录/解析（noteChatId + resolveReplyTarget + metadata.lastChatId）飞书侧已全量存在并在生产运行，微信只是同构接入；对话删除复用 manageConversation.archive（软删归档语义，数据保留可查）。

## 方案设计

### P1 出站目标 = ilinkUserId（稳定身份）

不采用「provision 时改写 connection.externalId = ilinkUserId」方案——那会打断与 ingress ensureConnection(botAccountId) 的同键汇合，路由锚再次分裂。

采用与飞书增量五同构的 metadata 方案：

1. **入站记录**：`message-processor.process` 在 ensureConnection 后 `noteChatId(connection.id, fromUserId)`（每次入站刷新，最新发话人成为出站目标；失败 warn 不阻断）
2. **建线记录**：`provisionWeixinAssistantLine`（app.ts）用扫码人 ilinkUserId 即刻 `noteChatId`——不依赖「用户先发一条消息」才恢复出站（Web 侧先发起对话的场景）
3. **出站解析**：`resolveReplyTarget` 扩展 weixin 分支——`weixin-*` 形态 connection 走 `metadata.lastChatId`；无目标返回 **null**，四条出站路径全部跳过发送记 warn（发给 bot 账号 id 只会 ret=-3 假失败，绝不投递）；旧时代按人建的 connection（externalId=用户 id）直用 externalId 向后兼容

恢复路径闭环：删号重扫 → 新 connection 无 lastChatId → 用户发第一条消息 → noteChatId 重建出站锚 → 回复恢复。与 context_token 的既有恢复语义（「对方需先发一条消息建立会话」）一致。

### P2 删号连删对话（归属护栏）

- provision 建线成功后在 connection metadata 记 `assistantConversationId`（这条线建出来的对话）
- `onWeixinAccountDeleted`：释放绑定前，若活跃绑定对话 === metadata.assistantConversationId（**我建的那条**）→ `manageConversation.archive`（软删归档：列表消失、数据保留、工作区清理复用既有链）；用户后来 /in 挪到别的对话不误伤
- 前端 `handleDeleteWeixinAccount`：确认文案改为「对应的助理对话将一并删除」，删除后刷新助理对话列表

覆盖流程（confirmOverwrite 删旧号）自动获得新语义：旧号建的助理对话随删号归档——与搭档「覆盖移除」预期一致。

## 影响范围

- 行为变化①：微信出站回复恢复投递（bot 锚 connection 场景从「必然 ret=-3」到「按 ilinkUserId 正常发送」）；无出站目标时从「裸发假失败」变为「跳过 + warn 日志」（更可诊断）
- 行为变化②：IM 页删除微信助理账号 → 对应助理对话一并从列表移除（归档软删）；覆盖流程同
- 兼容：旧时代按人建的 connection（externalId=用户 id）出站直用 externalId，行为不变；飞书链零改动
- 存量数据：当前线上 connection（`334633dc` / `weixin-muawxk7x`）无 metadata.lastChatId——部署后搭档在微信侧发一条消息即重建出站锚（与 context_token 恢复同一次动作）

## Verification（失败证据链）

固化失败（修复前，stash 源码保留测试）：`npx vitest run tests/usecases/im/weixin-message-channel.test.ts` → **2 failed**：
- `bot 锚 connection（externalId=weixin-*）：speak 投给 metadata.lastChatId 而非 bot 账号 id` ×（旧代码投给 weixin-muawxk7x）
- `bot 锚 connection 无 lastChatId：跳过发送不裸发给 bot 账号 id` ×（旧代码裸发）

修复后：
- `tests/usecases/im/weixin-message-channel.test.ts`：13/13 通过（含 F20260922wxeg 三例）
- `tests/usecases/im/manage-connection.test.ts`：32/32 通过（含 resolveReplyTarget 五例）
- `tests/interface-adapters/weixin/message-processor.test.ts`：全通过（noteChatId 接线）
- 全量 backend：3666/3667 通过；唯一 fail = `tests/scripts/validate-commit-date.test.ts` dual-base 用例——main 上同样挂（硬编码「当前=9-14」预期，今日 9-22 超 7 天窗口，与本改动无关；flaky 治理 issue #1081 口径）
- web：vitest + tsc + lint 见 PR CI

线上复核（部署后）：搭档微信发一条消息 → 发消息日志后应见 `weixin sendmessage response` ret=0（对比修复前 1121344 行 ret=-3）。
