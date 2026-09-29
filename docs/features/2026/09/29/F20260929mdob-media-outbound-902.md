---
id: F20260929mdob
title: "#902 媒体出站能力恢复：Web speak/user 消息附件到飞书/微信"
summary: "修复出站附件链三断点：entry.speak SSE 事件 attachments 管线 + 双通道（飞书/微信）附件投影与媒体真实投递（飞书 replyImage 新增 image 分支；微信恢复 replyMedia 调用 + attachmentDeps 重注入）"
feature_id: F20260929mdob
created: 2026-09-29
created_in_conversation: a9260c50-cef6-412e-a0b4-282287a13103
change_type: fix
capability_test: "n/a: 媒体出站需真实 IM 凭证与外部网络（飞书上传 API/微信 CDN），capability 场景不可离线复现；回归由 tests/usecases/im/feishu-media-outbound.test.ts + weixin-media-outbound.test.ts + tests/interface-adapters/agent-runtime/entry-speak-attachments-baseline.test.ts 锁定"
tags: [im, feishu, weixin, media, attachments, outbound, bugfix]
modules:
  - src/interface-adapters/agent-runtime/agent-invoker.ts
  - src/usecases/im/feishu-message-channel.ts
  - src/usecases/im/weixin-message-channel.ts
  - src/usecases/im/feishu-gateway.ts
  - src/frameworks/feishu/client.ts
  - src/bootstrap/platforms.ts
  - src/app.ts
  - api-contract/sse/events.ts
causal_links:
  - F20260828fsyc（ctlv 前的出站媒体设计，接口形态参考）
  - F20260913ctlv（entries 彻底切换，出站附件链随死链删除——本特性的修复对象）
  - issue #902（恢复路径来源）
  - issue #567（媒体出站原始 issue）
---

# #902 媒体出站能力恢复：Web speak/user 消息附件到飞书/微信

## 背景

PR #886（F20260913ctlv）对抗审视处置轮发现：ctlv 切换前 IM 出站的 attachments 投影（onMessage 链路，F20260828fsyc 时代）随死链一并删除。现行 entry.speak / entry.user 事件面不含附件载荷（user 侧后已在 #886 终审修复中补上），微信/飞书侧收不到 Web 端消息的附件。issue #902 立项恢复。

## 现场核实（2026-09-29，worktree 基于 628078f5）

三断点（大獭 09:00 在 79cf39ae 核实，行号在 628078f5 有偏移，以符号定位）：

1. **SSE 契约与发射点**：`api-contract/sse/events.ts` 的 `entry.speak` 载荷无 attachments 字段；`agent-invoker.ts` handleStreamEvent 的 entry.speak 发射行不透传 attachments。**entry.user 契约与发射点（message-controller.ts:236）已带 attachments**——user 侧断点实际只剩通道消费。
2. **飞书通道**：`deliverSpeakToFeishu`/`deliverUserEntryToFeishu` 的 `projectForChannel` 调用未传 attachments 参数（投影层 F20260920 多模态 Phase 1 已支持 options.attachments，纯消费侧断线）。
3. **微信通道**：同款投影断线 + `attachmentRepo` 参数在 F20260913ctlv 被删（git -S 溯源 #886），replyMedia 调用链消失。

关键核实发现（与任务书预期的差异）：

- 微信 `WeixinGateway.replyMedia` port + `WeixinGatewayAdapter.replyMedia`（CDN 上传）+ platforms.ts CDN 注入**全部完好**——只差通道侧调用与 attachmentRepo 重注入。
- 飞书 `FeishuGateway` 从无媒体接口（F20260828fsyc 时代飞书出站也只有占位投影）。任务书「飞书侧本期仅 image 分支」落地为本特性新增：`replyImage`（FormData 上传 im/v1/images → msg_type=image 发送），Node 原生 FormData/Blob 零新依赖。
- **speak entry 现阶段无附件写入源**：speak 工具参数仅 body；createSpeakEntry 无 attachmentIds 入参；獭侧无上传工具（#608 范围）。因此 entry.speak 事件载荷 attachments 恒缺席——通道侧按 entryId 补拉是 speak 侧唯一取附件路径。

## 方案

### 数据流（修复后）

```
Web 用户发消息带附件（entry.user 路径）
  message-controller → sendUserEntry（attach + 回查带投影）→ broadcastEvent(entry.user, attachments)
    → 飞书/微信通道：data.attachments 直接消费
      → projectForChannel(attachments)（占位投影 + Web 链接，truncate 前注入不丢）
      → 飞书：sendImageAttachments（attachmentRepo.getByIds → filePath 拼 storageRoot → replyImage）
      → 微信：sendAttachments（同查询 → replyMedia，CDN 上传按 MIME 路由 item）

獭 speak 带附件（entry.speak 路径——写入源 #608 就绪前，靠事件载荷透传管线 + 补拉兜底）
  speak 工具 details（现阶段无 attachments）→ agent-invoker 发射（有则透传）
    → 双通道：data.attachments 缺席时按 entryId 补拉（sendEntry.getEntryById 自带投影）
      → 同上投影 + 媒体投递
```

### 修复点明细

| # | 文件 | 改动 |
|---|---|---|
| 1 | api-contract/sse/events.ts | entry.speak 载荷加 `attachments?: EntryAttachmentDTO[]`（预留字段，与 entry.user 同形） |
| 2 | agent-invoker.ts | entry.speak 发射行加 speakAttachments 透传管线（details 有则带，无则缺席——不虚构数据） |
| 3 | feishu-message-channel.ts | 双 deliver 方法消费 attachments；resolveAttachments（载荷/补拉两源）；sendImageAttachments（仅 image）；attachmentDeps 可选注入（旧装配兼容） |
| 4 | weixin-message-channel.ts | 同构：双 deliver 消费 + resolveAttachments + sendAttachments（全类型 replyMedia）；attachmentDeps 重注入 |
| 5 | feishu-gateway.ts + client.ts | 新增 replyImage：读文件 → FormData 上传（image_type=message）→ image_key → msg_type=image |
| 6 | platforms.ts / app.ts | 双通道装配注入 attachmentDeps（attachmentRepo + entryReader + storageRoot） |

### 设计取舍（含 r1 处置）

- r1-S1：四处 deliver 的媒体投递移出文本 try（文本失败时媒体仍发，媒体 per-item 失败内部降级不向上抛），行为锁测试已补（双通道各一）。

- **补拉而非改 speak 工具**：speak 侧附件写入源属 #608（voice/file/video 白名单 + 獭侧上传），本特性不越界扩 speak 参数。发射点消费端管线已就位（details 有 attachments 即透传，r1-A3 已补真实透传用例）；**#608 接入时产出端还需在 speak 工具 details 补 attachments 字段（tool-factory 一行）——「消费端零改动，产出端差一行」**，非全程零改动。
- **attachmentDeps 而非裸 attachmentRepo**（对当年死参数的纠正）：旧版只注入 attachmentRepo（拿 filePath），本次补拉还需要 entryReader——打包成对象参数，命名显式。
- **filePath 绝对路径在通道层解析**：entity.filePath 是相对 storageRoot 的内容寻址路径（`attachments/<sha前2>/<sha次2>/<sha>.<ext>`），与 attachment-injection-service.ts:156 的 `path.join(storageRoot, filePath)` 同构。旧版（7bb98c6f）replyMedia 直传相对路径属 F20260913ctlv 前旧存储形态，已修正。
- **飞书仅 image 分支**：任务书明确本期范围。document/audio/video 在飞书侧由占位投影（`[文件: name (size)]` + Web 链接）兑底；微信侧 CDN 协议天然支持全类型（replyMedia 按 MIME 路由 IMAGE/VIDEO/FILE），不做人为收窄。
- **单项失败不阻塞（r1-S1 修正后语义）**：文本与媒体各自独立 try——文本失败（含降级链尽）媒体仍发；媒体 per-item 失败不阻塞其余且不向上抛（占位投影已随文本可见，或文本也败时媒体本体仍可达）。与 7bb98c6f sendAttachments 先例语义一致并收窄了其缺陷。

### 机制识别检查点（命中申报）

- [x] 新增跨模块调用路径：通道 → attachmentRepo/entryReader 补拉与实体查询（既有 repo 方法，无新存储）
- [x] 新增决策分支：载荷 attachments vs 补拉两源选择；image vs 非 image 投递路由（飞书）
- [ ] 新增状态生命周期：否（无新状态机）
- [ ] 新增持久化存储：否（复用 attachments/entry_attachments）
- [ ] 新增后台进程：否
- [ ] 新增配置字段/枚举：否（storageRoot 复用 appConfig.attachments）

判定：**未命中净新增机制**——飞书 replyImage 上传分支属既有出站能力的接口面补齐（与 replyText/replyMarkdown 并列的端口方法，实现层一次 fetch 调用），非新机制。整体为既有语义内恢复 + 接口面增量，Modification-Class = narrow-fix。

（机制预算四问不触发；若审视判定 replyImage 属机制增量，四问补答：① 谁需要——飞书侧收图的终端用户（搭档在 Web 发图，飞书群/私聊可见真图）；② 失败后果——上传/发送失败抛错被通道 catch，占位投影兜底，无半成品态；③ 后续机制——无新状态，image_key 即用即弃；④ 退役条件——#608 扩展飞书全类型媒体时，replyImage 泛化为 replyMedia，本方法并入。）

## 撞车协调

#1194（飞书扫码建线/多账号，OPEN 未合）同改 feishu-message-channel.ts。已细读其 diff：

- #1194 改动面：构造函数**对象参数化**（this.x → this.o.x 全量改写）+ ownsConnection 键控出站 + botKey 注入——**不含任何附件逻辑**（diff 无 attachments 相关行）
- 本 PR 改动面：deliverSpeak/deliverUserEntry 的附件消费 + 新增 attachmentDeps 参数（构造函数尾部可选参数）
- **语义不重叠**；文本层面有轻微冲突（同文件构造函数区），rebase 时 #1194 的对象参数化会与本 PR 的尾参合并（本 PR 在 rebase 时将 attachmentDeps 并入其对象参数形态，预计 ≤10 行手工合并）
- 时间序：#1194 先开（9/28），本 PR 后开（9/29）——本 PR 承接 rebase 义务，已在 #1194 落协调 comment

## 验证

### 修复前失败证据（worktree-isolation bugfix 硬规则）

在 origin/main 基线（628078f5，git stash -u 后仅恢复新增测试文件）上运行本特性三个新测试文件：

```
Test Files  3 failed (3)
Tests  13 failed | 1 passed (14)
```

13 个失败 = 三断点直接体现：
- entry-speak-attachments-baseline：发射行无 attachments、契约无字段（断点 1）
- feishu-media-outbound：`expected '看这张图' to contain '[图片: cat.png]'`（断点 2——投影断线）、replyImage 不存在
- weixin-media-outbound：`expected [] to have a length of 1`（断点 3——媒体零投递）

唯一通过的是「补拉失败降级纯文本」用例——main 上补拉不存在，行为恰好等于降级路径，符合预期。

### 修复后通过输出

```
npx vitest run（全量）
Test Files  298 passed (298)
Tests  4211 passed (4211)
```

- tsc --noEmit：0 错误
- ESLint：0 错误（app.ts max-lines 超限按 platforms.ts 先例豁免，注释声明净增行数）
- 新增测试：feishu-media-outbound（6 用例）+ weixin-media-outbound（6 用例）+ entry-speak-attachments-baseline（2 用例）

### 覆盖矩阵

| 场景 | 飞书 | 微信 |
|---|---|---|
| entry.user 带附件 → 占位投影 + 媒体投递（绝对路径断言） | ✅ | ✅ |
| entry.speak 无载荷 → entryId 补拉 → 同上 | ✅ | ✅ |
| document 附件 | 占位 only（image 分支边界） | replyMedia（全类型） |
| 附件依赖未注入（旧装配兼容） | ✅ 降级 | ✅ 降级 |
| 单项媒体失败不阻塞 | ✅ | ✅ |
| 实体查不到跳过 | ✅ | ✅ |

### 最简实现检查

已过最简检查：无新文件（除测试）、无新依赖（FormData/Blob 用 Node 原生）、无新表。投影层复用 F20260920 已有的 projectForChannel attachments 支持，通道侧只做消费接线。

## 影响范围

- 双通道出站投递（含附件场景新增行为；无附件消息路径零改动——`attachments.length > 0` 条件展开）
- entry.speak SSE 契约加可选字段（前端不消费新字段无影响）
- 飞书 client 新增上传调用（仅附件场景触达）
- 不动：入站链（message-processor 附件下载管线）、voice/file/video 白名单（#608）、speak 工具参数

## 已知遗留

- speak 侧附件写入源（獭上传工具）属 #608——本特性的发射点透传管线 + 补拉已为其预留接入位
- 飞书 document/audio/video 真实投递（需 im/v1/files 上传 API）——本期范围外，占位投影 + Web 链接兑底
- #1194 合入后本 PR 需 rebase（构造函数对象参数化合并，已落协调 comment）
