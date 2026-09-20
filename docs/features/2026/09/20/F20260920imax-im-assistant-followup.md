---
id: F20260920imax
title: IM 助理模式修订二：对话永续 + 8h 静默换 session + Web 分组可见
summary: 按搭档三条指令修订助理模式——① 移除群聊绑定 UI（连接大厅退场）② 一个 im 账号=一个对话（删 72h 软轮换，重扫码回同一对话）③ 8h 发言间隔触发全新 session（restartSession + 机械交接摘要，不用 Pi 内置压缩）；同时修 #1044 遗留的实现矛盾（前端分组架子在、后端沉底排序把它埋成永远空组）：kind 进 schema、删沉底排序、助理线模型可配（默认脱离 kimi 配额坑）、invoke 失败 IM 侧兜底提示不再静默。
doc_type: feature
change_type: feature
capability_test: "n/a: 会话编排/排序/UI 变更，无 prompt 行为语义可测（behavior_check 已在 intent 声明；单测覆盖于 tests/usecases/im/assistant-session.test.ts）"
created_in_conversation: b11cf010-f20d-4f92-88e6-ecc6414017a6
tags: [im, weixin, feishu, assistant, session-restart, ui, grouping]
modules:
  - src/usecases/im/assistant-session.ts
  - src/usecases/conversation/manage-conversation.ts
  - src/entities/conversation/conversation.ts
  - src/frameworks/db/schema.ts
  - src/frameworks/db/migration.ts
  - src/frameworks/db/conversation/conversation-mapper.ts
  - src/frameworks/db/conversation/sqlite-conversation-repository.ts
  - src/frameworks/config-service.ts
  - src/bootstrap/usecases.ts
  - src/bootstrap/platforms.ts
  - src/interface-adapters/weixin/message-processor.ts
  - src/interface-adapters/feishu/message-processor.ts
  - src/usecases/im/weixin-message-channel.ts
  - src/usecases/im/feishu-message-channel.ts
  - src/interface-adapters/http/dto/conversation-dto.ts
  - web/src/pages/im/index.tsx
  - web/src/pages/conversation/LeftPanel.tsx
from: [F20260918imas]
intent:
  problem: "IM 助理对话在 Web 不可见（沉底排序+分页截断）且 invoke 失败后 IM 侧静默，用户扫码后无反馈"
  expected_effect: "助理对话出现在左栏 IM 助理分组（kind=assistant 自然排序不截断丢失）；invoke 失败时微信/飞书收到兑底提示而非沉默；8h 静默后新消息触发 session 重启（对话不变）"
  verify_by:
    type: behavior_check
causal_links:
  - F20260918imas 原实现的「72h 软轮换 + 沉底排序」在本特性被取代（对话永续 + 自然排序）
  - #1049 统一交接架构（F20260920uhuc）合入后，本特性的 8h session 重启走 ManageSession.restartSession 独立路径，与水位触发的统一交接（reason='compaction'）并存
---

# IM 助理模式修订二：对话永续 + 8h 静默换 session + Web 分组可见

## 背景（问题现场）

搭档 2026-09-20 扫码实测微信助理：发 "hi" 收到「大獭回复中」（实为 invoke.start 的"正在思考..."ACK）后无下文，Web 上也看不到对话。排查结论（三层叠加）：

1. **kimi 周配额 403**（日志铁证：`LLM API error (403): weekly usage limit`，invoke failed，tool_call_count=0）——助理对话 otter 走 config `default: kimi`，配额耗尽即全链路静默
2. **沉底排序 + 分页截断**——#1044 的 SQL `ORDER BY CASE WHEN title LIKE '微信助理 · %' THEN 1 ELSE 0 END` 把助理对话压到列表尾部，前端每页 50 条、库里 active 203 个 → 分组架子在（LeftPanel kind 分流代码存在）但永远空组
3. **invoke 失败无 IM 侧兜底**——entry.failed 事件只有 Web 消费，微信用户只看到"正在思考..."然后永远沉默

搭档随后给出三条语义修订指令（对话原文）：
> 1. 移除群聊绑定
> 2. im助理连接应该是这样子的，不同账号扫码要对应不同的对话，但是同一个账号可能断联后重新扫码，那应该要进入同一个对话中。也就是说，一个im账号对应一个对话
> 3. 如果对话中发言间隔8小时，那当新发言时，此时应该直接用一个全新的session（注，这里由系统提供默认交接描述然后"重启獭生"，不要使用内置的默认压缩前世算法）

## 方案

### 语义修订对照（vs F20260918imas）

| 维度 | 原实现 | 本特性 |
|---|---|---|
| 对话生命周期 | 72h 软轮换（收篇翻篇新开对话） | **对话永续**（一个 im 账号 = 一个对话；删轮换） |
| session 生命周期 | 随对话永续（靠 Pi 内置 compaction 兜底） | **8h 静默 → restartSession**（机械交接摘要，非 Pi 内置压缩） |
| 助理对话标识 | title 前缀约定（DTO 解析 + SQL LIKE 双源） | **schema 字段 `conversation.kind`**（迁移回填存量；单一真相源） |
| 列表排序 | 助理沉底（不打扰工作对话） | **自然排序**（置顶 + 最新活跃；前端 kind 分组呈现） |
| 助理线模型 | 全局 default（当前 kimi，配额坑） | `im.assistant.modelAlias` 可配 |
| 群聊绑定 | IM 页「IM 大厅」卡片 | **UI 移除**（存量群绑定后端继续工作，不动数据） |
| invoke 失败 | IM 侧静默 | **entry.failed → IM 侧兜底提示**（微信/飞书同语义） |

### 8h session 重启设计（搭档指令 3）

- 触发锚 = 对话最后一条 entry 距今超过 `im.assistant.sessionIdleHours`（默认 8，config 可调）
- 动作 = 对话首 otter 走 `ManageSession.restartSession(otterId, summary, undefined, 'restart')`（manage-session.ts:210，#1049 后签名含 reason）——归档旧 session（摘要注入前世）+ 建新 session
- **交接摘要 = 机械拼接**（writeDigest 同源：最近 30 条 user/speak entry，与 #1049 的 narrative-synthesis LLM 引擎刻意区隔——8h 静默的边界语义简单，机械摘要足够且确定性可测）
- 摘要同时落 `conversation.summary` + 记忆（indexAssistantDigest）——跨 session 连续感由记忆承载
- 失败不阻塞入站消息（下次消息再试）
- Pi 内置 compaction 保留作水位兜底保险丝（#1049 统一交接主链路不动）

## 机制识别检查点判定（动手前完成）

逐项核对：新增配置字段（sessionIdleHours/modelAlias——**命中**）、新增决策分支（8h 判定→restartSession——**命中**，但结果走既有 restartSession 机制）。命中→判定：**修法排序①既有机制语义内修**——rotationHours 语义改为 sessionIdleHours、provision→maybeRotate 改为 maybeRestartIdleSession，删除的是机制（翻篇）而非新增机制；restartSession/记忆沉淀/摘要拼接全部复用 F20260918imas 已有件。无需重对抗门，Modification-Class 按混合声明（见 commit）。

## 实现

### schema 迁移

- `conversations.kind TEXT NOT NULL DEFAULT 'normal'`（schema.ts 新库 + migration.ts ensureConversationsKindColumn 存量库 ALTER）
- 存量回填：title 前缀「微信助理 · /飞书助理 ·」→ `kind='assistant'`（幂等：WHERE kind != 'assistant'）

### AssistantSessionManager 重写要点

- `ensureAssistantConversation`：无绑定→provision（create 传 `kind: 'assistant'` + 可选 modelAlias）；有绑定→`maybeRestartIdleSession` + 返回当前对话（永续）
- `maybeRestartIdleSession`：last-entry 距今 > sessionIdleHours → getOtterIds 取首 otter → buildDigest（机械摘要）→ restartSession + writeDigest（落 summary + 记忆）
- 删除：maybeRotate / provision 翻篇链 / manageConversation.complete 调用

### 配置

```yaml
im:
  assistant:
    enabled: true          # 总开关（默认开）
    sessionIdleHours: 8    # 8h 静默 → session 重启（原 rotationHours 废弃）
    modelAlias: glm        # 助理线模型（缺省全局 default）
```

### invoke 失败兜底（微信/飞书对称）

weixin-message-channel.ts / feishu-message-channel.ts 的 onEvent 新增 `entry.failed` 分支 → replyText 兜底提示（"⚠️ 助理这会儿没能回复……"）。发送失败静默（不反噬主流程）。

### Web

- **LeftPanel**：助理分组标签强化（teal 色点 + 计数徽章）；分组逻辑不变（`c.kind === 'assistant'`），后端不埋后自然生效
- **IM 页重写**：页头「IM 助理」+ 主 CTA 文案；微信卡（扫码 + 账号列表含对应助理对话展示 + "一个账号 = 一个助理对话"徽章）；飞书卡（三步 bot 好友引导，替代「连接测试」话术）；**「IM 大厅」卡片删除**（群聊绑定 UI 移除，存量群绑定注明继续工作）
- api client：IM 页复用 listConversations({limit:200}) 过滤 kind=assistant（无新端点——最简实现检查通过）

## 验证

- 单测：assistant-session 8 用例重写（永续/8h 重启/模型透传/失败降级）；conversation-dto kind 真相源改字段断言；sqlite-conversation-repository 沉底用例改为自然排序断言
- **全量 3676 用例 / 270 文件全绿**（ensure-hooks 与 halt-injection 两处并行波动重跑消失，非本次引入——单跑与二次全量均过）
- lint 0 error / tsc 0 error / web vite build 通过
- **真机浏览器验证**（alpha 实例 :3152 + Playwright，截图存对话工作区 imax-home-groups.png / imax-im-page.png）：
  - 左栏分组标签 boundingBox {x:21, y:138, w:206}——视口内可见；助理条目 y:205 位于标签下方（分组结构正确）
  - IM 页：h1「IM 助理」、微信徽章/扫码区/飞书引导在、「IM 大厅」计数 0（已移除）
- db 迁移真启动验证：alpha 实例（生产 config 副本 + 空 SQLite）启动健康、迁移执行、API 返回 kind 字段正确（curl 实测三条对话 kind 标注与排序符合预期）

## 对抗审视记录（2026-09-20）

检视獭「检视imax」（mimo，异模型）两轮审视：首轮 1 严重 + 3 建议，全部处置（3 修复 1 部分接受+反驳附证据）；delta 复核通过（commit a763d2ae）。发现清单：①buildDigest 双调用（空标题摘要→单次构建+真实标题）②IM 大厅死函数×4（已删）③kind 测试覆盖（补归一化断言；主断言反驳——检视看到的是注释非断言本体）④摘要与重启竞态（顺序反转：先落库后重启）。处置评论见 PR #1055。CI 未触发为 repo 级现象（03:47 后全 repo 零新 run，含其他分支），非本 PR 特有，本地 3677 用例绿 + 检视独立复核。

## 顺手修复（Discovered Issues）

- **主仓 config.yaml 缺 #1049 必填项 handoffThresholdTokens**（主服务未重启所以未炸；alpha 启动即炸暴露）——已按 contextWindow 比例补 8 个模型（1M→340000，128K→40000）。config.yaml 非 git 追踪，属本地配置修复，记录于此供溯源

## 设计取舍

- **机械交接 vs LLM 叙事合成（#1049 引擎）**：8h 静默边界语义简单（用户隔天回来），机械拼接确定性可测且零 LLM 成本；水位触发的复杂上下文才值得叙事合成。两路并存，各管各的触发器
- **存量群绑定不迁移不删除**：UI 入口移除即停止新绑定产生；存量（飞书海獭群聊01）继续工作——数据不动是边界声明，若搭档要彻底清理另开特性
- **IM 页账号↔对话对应用标题匹配**（acc.id 与对话 title.includes）：开户命名约定（`微信助理 · <id 尾6位>`）目前是唯一锚。若将来账号多、重名尾 6 位冲突，再上 connectionId 关联字段（本期不做，避免过度设计）

## 已知边界

- 同账号并发出站消息竞态（F20260918imas 检视发现 3）边界不变：入站主链单窗口串行假设维持
- kimi 配额 403 的根因处置在配置层（assistantModelAlias 或换 default），本特性不引入模型故障自动切换（那是独立机制，需要时另立项）

## 增量三（搭档语义纠偏，2026-09-20 午后）

### 语义修正（搭档裁决原文）

> 微信：每一个微信都只能有一个 clawbot，而这个 clawbot 只有自己能对话、别人看不到
> 飞书：机器人有归属（比如是我创建的），那这个机器人就是我的助理

推翻了增量三前的「每个私聊者各自开户」模型（我基于错误协议认知写的）：
- **微信**：bot = 号主私有。开户时机从「首条消息」提前到「扫码登录成功」——IM 页弹必填命名框（无默认值无跳过，搭档指令），提交即建线绑定账号；ingress 未建线时提示去 IM 页（不再自动开户）
- **飞书**：p2p 消息统一汇入单条「飞书助理」专线（固定 connection `feishu-assistant-line`，绕开对话独占约束）；消息体带 `[发送者姓名]` 前缀区分谁在说；群聊维持显式绑定
- **title 不再拼通道前缀**（「微信助理 · X」约定退役）——线名 = 搭档扫码时起的名 / 飞书专线默认「飞书助理」
- **rename 功能整体 revert**（搭档指令：取名必须、不许空、不要 rename）——增量二的 rename 三层 + IM 页改名 UI 全部回退；保留飞书 applink 二维码部分（selective checkout）

### 验证

- 全量 3677 用例绿（含微信 ingress 新语义 3 用例改写）；lint 0 error；tsc 0 error
- 截图 hifi-12~16 存对话工作区（新 IM 页 / 首页分组 / 飞书专线 / 命名弹层）

## 增量四（飞书暂停指令，2026-09-20 午后）

搭档裁决：「飞书这个好奇怪啊，下个再来改吧」——共享专线形态不 ship。回退到「每人一对话」（增量三前的已审视语义：p2p 首条消息按发送者开户，飞书真姓名命名）。

**搭档终态愿景（下次特性做，此处记锚防丢）**：
> 每个人扫码飞书时都会创建一个飞书机器人，然后一次扫码就是一个海獭对话，一个飞书侧机器人 = 一个海獭系统的助理对话

即：按人建 bot（一个飞书用户一个自建应用 bot）+ 一 bot 一对话。技术可行性要点（下个特性先验证）：飞书自建应用能否 API 创建/多实例（当前模型是搭档手工建一个 bot 所有事件进同一 WS 连接——按人建 bot 需要应用市场/ISV 模式或多应用凭证管理，与 F20260918imas 非目标「不做 ISV 上架」可能冲突，届时需搭档重新裁决）。

微信线（扫码必填命名 + 号主私有）不受影响，维持增量三形态。

## 增量五（搭档统一模型，2026-09-20 下午）

### 概念对齐（搭档原话）

> 不管是微信还是飞书，都是一个 im 侧 bot 等于一个海獭系统的助理对话。你老在纠结按人还是按消息，非常奇怪

路由锚 = **bot 本身**，不是「谁在聊」也不是「哪条消息」。我此前两轮（按人开户→共享专线→回退每人）都在错误维度打转，此轮以 bot 锚定一次性收敛：

- **微信**：扫码的号 = bot（号主私有）= 一个对话 ✅（增量三已对，不变）
- **飞书**：connection externalId = `feishu-bot:<掩码appId>`（FeishuClient.botKey，凭证不出进程）；首条 p2p 消息建「飞书助理」对话；**任何人私聊这个 bot 都进同一对话**，消息带 `[发送者姓名]` 前缀（展示维度，非路由维度）
- **出站定向**：bot connection 的 externalId 不再是 chatId——入站随消息刷新 `metadata.lastChatId`（connectionRepo 新增 mergeMetadata），出站（回复/思考中/失败提示）经 `resolveReplyTarget` 从 metadata 解析（普通连接直用 externalId，群聊路径不变）
- 多 bot 将来天然扩展：每个 bot 一个 connection + 一个对话，规则不变

### 验证

- 新增 e2e 级单测 bot-anchored-routing.test.ts（2 用例：双人私聊同 bot → 同对话 + 姓名 prefix；lastChatId 随入站刷新）
- 全量 3679 用例绿；lint 0 error；tsc 0 error
