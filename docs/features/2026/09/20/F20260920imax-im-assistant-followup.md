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

## 顺手修复（Discovered Issues）

- **主仓 config.yaml 缺 #1049 必填项 handoffThresholdTokens**（主服务未重启所以未炸；alpha 启动即炸暴露）——已按 contextWindow 比例补 8 个模型（1M→340000，128K→40000）。config.yaml 非 git 追踪，属本地配置修复，记录于此供溯源

## 设计取舍

- **机械交接 vs LLM 叙事合成（#1049 引擎）**：8h 静默边界语义简单（用户隔天回来），机械拼接确定性可测且零 LLM 成本；水位触发的复杂上下文才值得叙事合成。两路并存，各管各的触发器
- **存量群绑定不迁移不删除**：UI 入口移除即停止新绑定产生；存量（飞书海獭群聊01）继续工作——数据不动是边界声明，若搭档要彻底清理另开特性
- **IM 页账号↔对话对应用标题匹配**（acc.id 与对话 title.includes）：开户命名约定（`微信助理 · <id 尾6位>`）目前是唯一锚。若将来账号多、重名尾 6 位冲突，再上 connectionId 关联字段（本期不做，避免过度设计）

## 已知边界

- 同账号并发出站消息竞态（F20260918imas 检视发现 3）边界不变：入站主链单窗口串行假设维持
- kimi 配额 403 的根因处置在配置层（assistantModelAlias 或换 default），本特性不引入模型故障自动切换（那是独立机制，需要时另立项）
