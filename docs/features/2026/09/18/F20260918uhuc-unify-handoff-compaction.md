---
id: F20260918uhuc
title: 上下文管理统一重构：压缩=交接，一套引擎一条通道一个动作
summary: 将压缩/自重启/手动重启三条上下文管理链路统一为单一交接管线。触发层各守其位（水位/工具信号/HTTP），原料层一个收集器（jsonl 切片+状态快照+前情），算法层一个七段引擎，通道层统一影子通道（对齐 Pi 裸调用模式），写回层统一换 session（parentSession 血缘+域层新行+完整起始档案）。含 F20260917rsta 上线首日锁雪崩 bug 的修复、F20260825hndf P1 红线重审、冻结窗口与忙碌拒绝设计。
change_type: feature
capability_test: "n/a: 方案文档，能力测试随实现 PR 附（V1-V6 用例设计见验证节）"
doc_type: feature
tags: [compaction, handoff, restart, session, architecture, refactor]
modules:
  - src/frameworks/agent/compaction-hook.ts
  - src/frameworks/agent/pi-session-factory.ts
  - src/frameworks/agent/handoff-package-builder.ts
  - src/frameworks/agent/synthesis-prompt-builder.ts
  - src/interface-adapters/agent-runtime/agent-invoker.ts
  - src/usecases/otter/manage-session.ts
  - src/interface-adapters/http/controllers/otter-controller.ts
  - web/src/pages/conversation/Modals.tsx
created_in_conversation: c619e648-e98b-4ea0-9b8d-b2a5cea3865d
created_at: 2026-09-18
causal_links:
  from:
    - F20260825hndf
    - F20260903cmpk
    - F20260912nlb896
    - F20260917rsta
    - F20260916b1ea
---

# 上下文管理统一重构：压缩=交接

## 背景（意图锚，2026-09-18 本对话全天讨论链）

- 起点（bug 排查）：「昨天让你给重启獭生做了可选，置空则走默认的海獭压缩算法，我今天试了下，点击重启獭生毫无反应。打开控制台，发现这个api一直在转」→ 排查结论：F20260917rsta 空摘要合成走 invoke 通道，同步等 LLM + per-otter 锁排队，连点 6 次雪崩（2 次 HTTP 500 / 60s、队列深度 4）。
- 架构追问：「我原本的预期，这三者底层应该都同一套处理逻辑，仅仅只有触发方式不同而已」→ 核实：该预期曾是 8/25 的事实（三层触发×四件套），9/3 与 9/12 两次正当分叉后漂移成两套算法/两条通道，昨日 bug 是漂移账单。
- 通道层：「pi自带的压缩算法中是如何调llm的，走的是agent上下文调用，还是也是额外的独立通道」→ 源码拆解：Pi 走 `completeSimple` 裸调用（无 session、无锁、无工具），影子通道与其同哲学。
- 原料层：「两者并不是冲突的，其实都是 待总结的历史消息/状态/信息 呀。所以其实，我对你决策说要用适配器分两套走，我是不赞同的」→ 收回双适配器，统一为「一个收集器 + 场景参数」。
- 写回层：「我期望 pi压缩用了咱们的算法，也能是一个新的session，即把"压缩"换成"交接"动作……借助咱们海獭的 session chain概念……不会丢上一世的记录。然后，写回层也能统一起来了」
- 红线重审：「那咱们再来看，为什么自重启 又海獭自己写的？这还是条红线？为什么？」→ 三理由拆解，P1 红线内核（退化不可信）的技术形态已消失，建议降级。
- 档案结构：「两者结合在一起呢，独立的llm总结 + 可能有的上一世自总结，然后按照优雅的组织结构作为新session的起始上下文」
- 体验约束：「我认可统一，但这个 几十秒甚至分钟级的用户体验，你需要再给出一个方案来」→ 异步方案两轮迭代后被否：「你这咋把档案当作 新世开始后都跑一段时间了，然后再塞入新世？……这我觉得破坏了 新生的 初始上下文了吧」→ 回归同步原子交接。
- 参数化：「结合你这个首哑重启獭生的行为，我要求这整套的 压缩交接方法 必须有个入参来控制是否"前世总结"，如果不总结，那就直接使用 触发方自总结」
- 冻结窗口：「我觉得当*开始*交接时，所有消息都必须等待，不能再用旧世去处理」
- 忙碌拒绝（急讯 16:31）：「忙碌獭不允许被手动重启，这么定，不要考虑复杂机制」
- 开工指令：「ok，整理好方案，开工吧」
- 合成模型：「海獭新一世是什么模型，那就用什么模型来总结，不要去换别的模型（暂时我的这样子认为的）」

## 目标

- T1: 修复 F20260917rsta 锁雪崩 bug——手动重启空摘要合成不再走 invoke 通道
- T2: 三链统一——压缩/自重启/手动重启共享一套交接管线（原料收集器、七段引擎、影子通道、换 session 写回）
- T3: 压缩语义升级为交接——水位触发时换新 session（parentSession 血缘），前世 jsonl 完整保留
- T4: 新世初始上下文永远完整（叠加式档案：引擎叙事总结【按参数】+ 触发方自总结【如有】+ 机械档案【必有】），无「先缺后补」
- T5: 体验——有反馈的等待（交接态 UI + 防连点）；忙碌獭拒绝手动重启；窗口期消息冻结排队由新世消化
- T6: synthesizePast 入参贯通全链（API/工具/UI），首哑复活场景取 false

## 非目标

- 不做异步档案注入（搭档否决：破坏新世初始上下文完整性）
- 不做独立合成模型旋钮（搭档决策：合成用新世模型；「暂时」保留复议空间）
- 不做水位预合成（85% 预警线，二期再议）
- 不动解散（dissolve）路径——归档摘要必填语义不变
- 不做 overflow 场景的自定义接管——真溢出仍走 Pi 默认原地压缩救急
- 不做消息缓冲新队列——窗口期消息靠既有 entries 持久 + 未读注入 + 锁串行

## 未决问题

- ~~U1: Pi overflow 判定是否独立于 reserveTokens~~ **已验证（V7 完成，2026-09-18）**：独立。overflow 走 isContextOverflow（provider 错误模式匹配 + z.ai 静默溢出 usage.input>contextWindow + MiMo length 形态），参照系是 contextWindow，不碰 reserve；只有 threshold 走 reserve 公式（shouldCompact）。「拉大 reserve 使 threshold 永不触发 + overflow 仍能救急」策略成立。证据：pi-ai/dist/utils/overflow.js isContextOverflow + pi-coding-agent/dist/core/agent-session.js _checkCompaction（case 1/2 vs case 3 分流）
- U2: SDK `prepareCompaction()` 裸用导出的 entries 读取便利性（重启场景从旧 jsonl 算切片）。已有 SessionRestore 读 jsonl 先例，大概率可行，实现时验证。
- U3: 忙碌判定的精确口径（running invoke 存在即拒绝）与 UI 轮询/推送方式，实现时定。

## 方案设计

### 五层统一架构

| 层 | 统一形态 | 现状 → 终态 |
|---|---|---|
| 触发层 | 各守其位：水位（应用层 invoke 轮边界检查）/ restart_otter 工具信号 / HTTP API（UI） | 水位从 Pi session_before_compact 钩子收回应用层 |
| 原料层 | 一个收集器：jsonl 对话切片（SDK prepareCompaction 同一份算法）+ 状态快照（DB+工作区机械收集）+ 前情（场景参数：压缩取 compaction entry previousSummary / 重启取 otter_sessions.summary lineage） | 压缩用 Pi preparation、重启用 DB 视角四件套 → 统一 jsonl 权威源 |
| 算法层 | 一个七段叙事引擎（统一模板 + fail-closed 防线 + 谱系继承 + 自总结叠加） | compaction-hook 七段模板与 synthesis-prompt-builder 七节模板合并 |
| 通道层 | 影子通道一条（inMemory session 直调 LLM，≈Pi completeSimple 哲学） | invoke 通道合成调用清零退役（buildSynthesisFunction 删除） |
| 写回层 | 统一交接：换 session（parentSession 血缘）+ 域层 session 新行（reason 扩 'compaction'）+ 完整起始档案注入 | 压缩从原地写 compaction entry 改为换 session；重启链已具备 |

### 统一交接 API（单一入口）

```
handoff(otterId, {
  trigger: '水位' | '手动' | '自重启' | '熔断' | '首哑复活',
  selfSummary?: string,      // 触发方自总结：獭写的（restart_otter）/ 搭档填的（UI）
  synthesizePast: boolean,   // false = 跳过引擎合成，起始档案 = 自总结(必填) + 机械档案
  modelAlias?: string,       // 新世模型；合成模型跟随新世（modelOverride 传入影子通道）
})
```

场景取值矩阵：

| 场景 | selfSummary | synthesizePast | 说明 |
|---|---|---|---|
| 首哑复活 | 原任务摘要（必带） | false | 前世 jsonl 为空，合成无意义 |
| 手动重启 | 搭档填（可选） | UI 勾选项，默认 true | 「生成前世总结」勾选框 |
| 水位交接 | 无 | true | 自动触发，叙事档案是唯一叙事来源 |
| 熔断 | 无 | true | P1 红线重审后放开（见设计取舍） |
| 自重启 | 獭写 | 工具参数透传，默认 true | 獭最清楚前世价值 |

### 新世起始上下文（叠加式档案，T4 核心）

```
## 前世档案（新世必读）
### ① 交接意图书        ← selfSummary 原话独立保留，不转述（有则显示）
### ② 历史叙事摘要      ← 引擎七段合成（synthesizePast=true 时）
### ③ 交接谱系          ← gen N 跨代链（总在；机械追加）
### ④ 机械供料段        ← 文件轨迹 / 状态盘点 / 近期保留段（总在）
```

- 机械档案 = 近期保留段（对齐 Pi keepRecent 20K token，prepareCompaction 切片序列化）+ 状态盘点 + 文件轨迹 + 谱系——秒级生成，synthesizePast=false 或合成降级时的完整合法形态
- selfSummary 同时作为引擎合成原料（§①/② 段需要意图），输出层仍保留原话
- 合成失败/超时（60s 硬上界）→ 降级机械转储档案——档案形态有叙事/机械之分，无「先缺后补」

### 交接时序（同步原子 + 冻结窗口）

```
T_start: 交接启动
  ① 忙碌检查：running invoke 存在 → 手动场景直接拒绝（409，「忙碌中」）；自动场景（水位/熔断）延后到轮边界自然触发
  ② 获取 per-otter 锁（等当前 turn 结束），持有至交接完成
  ③ 档案切片在此刻锁定——快照一致，无骑缝
窗口内（合成 5-15s 常态 / 60s 上界 + 切换 <1s）:
  - 新消息照常落库（entries 持久）
  - 该獭 invoke 全部锁排队，旧世不接新单（冻结）
T_done:
  - restartSession：池驱逐 → 新 session（parentSession=旧）→ 域层新行
  - 释放锁 → 排队消息逐个处理，新世首 invoke 未读注入消化窗口期消息（带完整档案应答）

- **锁超时对齐约束（对抗审视严重发现 1 采纳）**：交接持锁最坏 60s+turn 尾，但锁 waiter 默认超时 30s（session-helpers.ts timeoutMs 默认值）——不对齐则窗口内排队 invoke 会在 30s 假超时报错（昨日 500 变体）。实现：交接持锁时通知锁管理器进入「交接模式」，后续 waiter 超时延长至 120s（合成上界 60s + turn 尾缓冲）；交接完成/失败恢复正常超时。不采用全局调大 30s 默认值（影响面大）
- **跨獭阻塞已知行为（对抗审视严重发现 2 采纳）**：冻结窗口内其他獭 yield 派工到该獭会在锁上排队（常态 5-15s，最坏 60s），上游獭同步等待。首期接受此行为（交接常态窗口短）；「冻结期间返回 423 Locked 让调用方决策」标注为后续可选优化（涉及獭间协议变更，不进首期）
```

- 交接在锁视角 = 一个超长 turn：持锁、排队、结束消化——与既有消息行为同构，零新增排队机制
- 自动触发（水位）在 invoke 轮边界检查（外层已持锁，无锁竞争）：ctxTokens > contextWindow − compactionReserveTokens（沿用 config 水位域唯一真相源）

### Pi SDK 兜底配置

- 保留 SDK compaction enabled，`compactionReserveTokens`（SDK 侧 settings.reserveTokens）拉大到窗口−50K 量级：平时 SDK threshold 永不触发（应用层先交接），真 overflow 时 Pi 默认原地压缩救急
- session_before_compact 钩子退役（七段合成迁入统一引擎后，钩子无存在必要）——U1 验证后定稿

### 退役清单（删除 = 方案的一部分）

- `buildSynthesisFunction`（invoke 通道合成，bug 病灶）
- compaction-hook 的独立七段模板（并入统一引擎）
- `restartWithAutoHandoffIfBlank` 的 if(summary) 直透分支（统一 API 取代）
- F20260903cmpk 的钩子接线（platforms.ts setCompactionSynthesis）——随钩子退役

### 影响模块

- 触发器：agent-invoker.ts（轮边界水位检查 + 统一 handoff 入口 + 冻结语义）
- 引擎：新文件 frameworks/agent/narrative-synthesis-engine.ts（七段模板合并 + fail-closed + 谱系）
- 原料：handoff-package-builder.ts 改造（jsonl 切片接入，SDK prepareCompaction 复用）
- 通道：pi-session-factory.ts runCompactionSynthesis 泛化（modelOverride 入参）
- 域层：manage-session.ts（reason 枚举 + 'compaction'；restartSession 语义不变）
- API：otter-controller.ts（synthesizePast 透传 + 忙碌 409）
- 工具：tool-factory.ts restart_otter（synthesizePast 参数透传）
- UI：Modals.tsx RestartModal（勾选项 + 交接态反馈 + 防连点）+ OtterProfileCard（忙碌置灰）
- 测试：现有 compaction-hook 测试迁移改造；新增统一管线能力测试

## 影响范围

- 所有 otter 的上下文生命周期：压缩行为从原地变为换世（外部可见变化：session 列表多行、jsonl 按代分文件）
- 首哑复活路径：restart_otter(otterId, modelAlias, summary) 行为不变，底层走统一管线 synthesizePast=false
- invoke 轮次延迟：水位交接的那一轮獭响应慢 5-15s（常态）
- DB：otter_sessions 行为 'compaction' reason 的行增加；无新表
- messages.context_tokens 观测语义不变

## 风险与约束

- R1: 水位检查从 Pi 每轮 LLM 调用边界降到 invoke 轮边界——轮内工具循环暴涨可能漏检；补偿 = Pi overflow 兜底（U1 验证）+ 可选二期轮内流事件计数
- R2: 换世型压缩使 session 文件数量增长（每代一个 jsonl）——与手动重启同量级，磁盘成本可忽略，审计性反升
- R3: 引擎合并是行为变更密集区（两套模板的细微差异需逐段核对合并）——对抗审视重点 + 分场景 golden 对比
- R4: 交接持锁窗口最长 60s+turn 尾——同獭消息排队延迟增加，跨獭不受影响（锁粒度 per-otter）
- R5: 熔断场景走合成（红线重审）——若合成被污染历史带偏，机械转储兜底 + fail-closed 防线；检视獭专项盯防
- R6: F20260916b1ea resume_pending_resumes 与换世型压缩的交互——crash 场景语义（对抗审视发现 5 采纳，已明确）：恢复队列只认 running invoke；若服务在交接合成阶段崩溃（T_start 后、restartSession 前），此时无 running invoke（旧 turn 已结束）、旧 session 行仍 active——恢复队列不动它，状态自洽回退到「旧世存活」，用户重试重启即可；若崩溃在 restartSession 事务内，DB 事务原子性保证要么旧世 active 要么新世就绪，无中间态

## 不兼容更新

- [Incompatible] Pi 钩子退役：依赖 session_before_compact 七段替换的外部行为（无）——内部机制，无外部契约
- [Incompatible] restart API body 增 synthesizePast（可选字段，旧客户端不传 = 默认 true，向后兼容）；忙碌 409 为新错误码（前端同步更新）

## 设计取舍

| 取舍 | 决策 | 替代方案 | 理由 |
|---|---|---|---|
| 触发时机收回应用层 | 是（轮边界水位） | 维持 Pi 钩子 | 写回语义变交接后，钩子内换 session 是竞态地狱（#896 同构）；检查密度损失由 overflow 兜底补 |
| 写回统一换 session | 是 | 压缩保持原地 | 搭档拍板：session chain 血缘 + 前世完整保留 + 写回层统一；审计性提升 |
| 同步原子交接 | 是 | 异步档案注入 | 异步破坏新世初始上下文完整性（搭档否决）；等待体验用交接态反馈解决 |
| 合成模型=新世模型 | 是 | 快模型旋钮 | 搭档决策（暂时）；语义自洽：谁的档案谁的语言 |
| 忙碌拒绝手动重启 | 是（409+置灰） | 排队等待 | 搭档急讯拍板「不要考虑复杂机制」；重启是干净动作 |
| synthesizePast=false 仍给机械档案 | 是 | 纯自总结 | 质量底线：机械段秒级生成零成本，事实密度不可少 |
| 冻结窗口（旧世不接单） | 是 | 旧世继续应答 | 搭档拍板；消除骑缝：T_start 后一切属于新世 |
| 交接期锁 waiter 超时延长至 120s | 是（交接模式动态延长） | 全局调大默认 30s | 只影响交接窗口（常态 5-15s），不动全局锁语义；不对齐 = 窗口内假超时 500 |

### 机制识别检查点与预算四问（作者当场作答）

逐项过：新增配置字段（reason 枚举值、synthesizePast API 字段）☑；新增决策分支（synthesizePast 被持久化进 session 行 summary 吗——不持久，运行时参数，但 reason='compaction' 行是持久新状态）☑；跨模块调用路径（统一引擎新入口）☑；新表/新定时任务/新信号类型 ✗。

**判定：涉及净新增机制（轻量）**——本质是机制的合并与复活（70% 水位链路复活、四件套升级统一、两模板合一），净新增仅 reason='compaction' 枚举值与 synthesizePast 参数。四问：

- ① **谁需要它**：所有长对话 otter（水位交接需求方）、搭档（重启体验与可控性）、运维审计（世代链可追溯）
- ② **失败后果**：交接失败 → 降级机械档案重启（D9 不变量保持）；最坏 = 新世从机械档案起步，无数据丢失（旧 jsonl 永在）
- ③ **后续机制**：reason='compaction' 行可能被误读为「重启」——UI/统计需区分 reason；水位误触发会频繁换世——reserve 配置校验 + 单日内换世上限护栏（实现时评估）
- ④ **退役条件**：若 Pi SDK 原生支持 hook 内换 session（或 context fork API），应用层水位触发器可退役回归 SDK 时机

**零基重推（大版本重构必答）**：假如从零设计，还会加——① per-otter session 锁（保：串行模型是消息一致性的根基）② 四件套机械供料（保：枚举事实机械供料原则已验证）③ 未读游标注入（保：窗口期消息消化的载体）④ restart_pending_resumes 恢复队列（保：crash-resilience 独立价值）⑤ compaction-hook 七段钩子（**汰**：时机权回收后无存在必要，并入引擎）⑥ invoke 通道合成（**汰**：#896 与昨日 bug 双重证伪）⑦ 70% 固定百分比（**汰**：水位域统一为 reserve 公式）。

### 红线重审（F20260825hndf 审视 P1，专项）

P1 原文：「手动/熔断路径绝不走 LLM 合成」，理由 = 熔断场景已陷复读，优雅交接可能复读出垃圾摘要。重审结论：**降级为默认偏好 + 降级链，不再是无条件红线**。论据：

1. P1 定罪对象是「退化獭自己现场跑 LLM 合成」（invoke 通道）；新方案合成者是干净的影子引擎（读序列化 jsonl、无历史会话状态、fail-closed 防线），不是那只退化的獭
2. Pi 默认压缩本身就是反例：从不检查上下文质量，退化循环照样压，防线是 length-stop fail-closed 而非「不压」
3. 残余风险（jsonl 含循环记录污染合成）由机械供料（状态/谱系来自 DB 非 jsonl）+ 60s 超时降级机械转储兜住
4. 收益：熔断/空摘要自重启的新世不再裸奔（现状 gap：空摘要自重启 = 无摘要从零开始）

**GIGO 残余透明说明（对抗审视发现 4 采纳）**：熔断场景 jsonl 含退化循环记录的概率高于其他场景，合成被 fail-closed 拒绝（空/截断）的概率也相应更高，降级到纯机械档案的概率更大——即熔断场景的叙事合成命中率预期低于水位/手动场景。这不改变推翻结论（机械档案仍远优于从零开始），但读者不应预期各场景合成命中率相同。

**处置**：本重审由实现方（大獭）提出，按异体执行原则，进入对抗审视时检视獭**专项盯防此条**（要求检视獭独立检索 F20260825hndf 原始上下文后给出「确认推翻/维持红线/信息不足」三选一结论），未经检视确认前不视为已推翻。

## 验证

- V1（bug 修复锚）：昨日锁雪崩场景重放——空摘要手动重启，合成不触锁（日志无 session lock acquire for synthesis）、单请求 <1s 返回（忙碌时 409）
- V2（统一管线能力测试）：五场景各一条 golden——首哑 false / 手动 true+自总结 / 水位 / 熔断（红线重审路径）/ 自重启透传；断言档案结构四段完整、谱系追加、fail-closed（空/截断拒入库）
- V3（冻结窗口）：交接窗口内注入消息，断言新世首 invoke 消化且应答含档案引用；旧世无新 invoke 产生
- V4（血缘）：交接后 session 行链完整（parentSession 指向、reason 正确、旧 jsonl 在磁盘）
- V5（回归）：现有 3195 测试套件全绿；restart/dissolve/首哑复活行为回归
- V6（兜底）：模拟合成超时 → 机械档案 + 正常换世；U1 验证记录（overflow 判定与 reserve 的关系实测）
- V7（U1 阻塞验证，实现第一步）：实测 Pi SDK overflow 判定是否独立于 reserveTokens——构造 reserve 极大 + 真实溢出场景，观察 SDK 是否触发 overflow 压缩。若 overflow 也走 reserve 公式（拉大 reserve = overflow 永不触发），则兜底失效，启用替代方案（轮内流事件计数器降级触发）并回方案重审

## 改动范围

| 文件 | 操作 | 说明 |
|---|---|---|
| src/frameworks/agent/narrative-synthesis-engine.ts | 新增 | 统一七段引擎（模板合并+fail-closed+谱系+自总结叠加） |
| src/frameworks/agent/handoff-package-builder.ts | 改造 | 原料统一：jsonl 切片接入、四件套升级为统一收集器 |
| src/frameworks/agent/compaction-hook.ts | 删除 | 钩子退役（时机权回收；七段并入引擎） |
| src/frameworks/agent/pi-session-factory.ts | 修改 | runCompactionSynthesis 泛化（modelOverride）；reset 复用 |
| src/interface-adapters/agent-runtime/agent-invoker.ts | 修改 | 轮边界水位触发器；统一 handoff 入口；buildSynthesisFunction 删除；冻结语义 |
| src/usecases/otter/manage-session.ts | 修改 | reason 枚举 + 'compaction' |
| src/interface-adapters/http/controllers/otter-controller.ts | 修改 | synthesizePast 透传；忙碌 409 |
| src/interface-adapters/agent-runtime/tools/tool-factory.ts | 修改 | restart_otter synthesizePast 参数 |
| web/src/pages/conversation/Modals.tsx | 修改 | RestartModal 勾选项+交接态+防连点；忙碌置灰 |
| tests/**（compaction/handoff/restart 相关） | 迁移+新增 | V1-V6 用例 |
