---
id: F20260827c3hr
title: '獭间信号 C3：healing 高危路由 + L2「停下」扫描（+#534 双注册修复）'
summary: F20260826mwrd 第三期实现——high healing 事件路由到大獭下一 turn 的 reminder 注入（不再止步 logger.warn）、用户消息「停下」独立成词的 L2 检测与 reminder 注入（不硬拦，LLM 语境确认）、manage_healing_events 双注册欠账修复（#534）。
change_type: feature
capability_test: n/a（纯代码注入管道，无 prompt 行为变更——capability 面归 C4 收口：tests/capability/magic-words-signal.capability.test.ts 剧本 B/E 在 C4 后转真）
tags: [agent-architecture, signal-protocol, healing-routing, l2-detection, prompt-injection]
modules: [src/usecases/signal/stop-word-scanner.ts, src/usecases/healing/healing-alert-registry.ts, src/interface-adapters/agent-runtime/tools/healing-tools.ts, src/interface-adapters/agent-runtime/agent-invoker.ts, src/usecases/conversation/dispatch-chain-engine.ts, src/bootstrap/platforms.ts, src/frameworks/agent/session-helpers.ts, src/usecases/ports/sdk-invoke-port.ts]
created_in_conversation: 9c9b55ef-a2b7-4ef1-9776-f7032537b51c
from: [F20260826mwrd]
---

# 獭间信号 C3：healing 高危路由 + L2 停下扫描

**父方案**：[F20260826mwrd](../26/F20260826mwrd.md) Part 4（healing 高危路由）+ Part 6（L2「停下」检测保底）。C1 交付 halt 投递管道、C2 交付 signal-parser 与裁决写路径，本期补齐两个消费侧管道：高危事件「谁来当场看」和用户安全词「谁来保底听」。

## 交付内容

| 层 | 文件 | 内容 |
|---|---|---|
| L2 扫描器 | `src/usecases/signal/stop-word-scanner.ts`（新） | 「停下」独立成词检测：形态 1（去首尾标点/空白/组合记号/格式控制后完全相等；**emoji 不在 trim 范围——emoji 属内容字符**，emoji 包裹的消息走形态 2 边界判定）+ 形态 2（片段后侧为硬边界——标点/空白/emoji/组合记号/格式控制/消息尾）；显式字符类（`\p{P}\p{Zs}\s\p{Extended_Pictographic}\p{Mn}\p{Mc}\p{Cf}`，零宽/变体字符——VS16/ZWSP/ZWNJ/组合重音符——归边界类收窄漏报面），不用分词；不硬拦，产出 reminder 文本（语境确认二分支引导 + halt_otter 引导，不对语境做预判断言） |
| L2 接线 | `dispatch-chain-engine.ts` | `executeChainInner` 扫一次原文 → reminder 附在每个 hop 的 `messageWithContext` 末尾（首 hop 附加，链上所有獭可见——防注意力稀释漏判）；扫描异常降级为无 reminder（退化纯 L1，失效方向安全） |
| 高危路由·登记 | `src/usecases/healing/healing-alert-registry.ts`（新） | 进程级单例（同 haltRegistry 模式）：对话粒度队列，`interceptHealingReport` 在 severity:high 落台账同时 `enqueue`（台账照旧 healing_events，队列是「未送达的提醒」内存态，送达即删）；单对话积压上限 20（超限丢最旧，台账有全量）；大獭不在场则滞留到下一轮，不丢 |
| 高危路由·消费 | `agent-invoker.ts` | invoke 前 `queryOtter.getById` 判型，仅 big 獭 `takeAll` → `renderHealingAlerts` → `DynamicContext.healingAlerts`（新字段）→ `buildMessageWithContext` 渲染（位置在 workspacePath 后、用户消息前——环境情报而非任务本体）；small 獭 invoke 不取队列 |
| #534 修复 | `platforms.ts` | `createManageHealingEventsTool` 双注册收敛为 tool-factory 唯一注册点（闭包二次 push 删除，import 清理）；防回归断言见测试 |

## 与方案的对照

| 方案条款 | 实现 | 偏差 |
|---|---|---|
| Part 6 匹配定义「两侧均为标点/空白/emoji/首尾」 | 后侧硬边界（标点/空白/emoji/消息尾），前侧不设硬边界 | **有，见下方「与方案的偏差」①** |
| Part 6「不硬拦：注入 reminder，LLM 语境确认」 | reminder 二分支引导（指令→Magic Words 执行 + halt_otter；讨论/引用→正常对话） | 无 |
| Part 6 接线点「消息入口（agent-invoker 之前的用户消息管道）」 | dispatch-chain-engine（Web/飞书/定时任务统一汇入点） | 无——链引擎正是 invoker 之前的统一管道 |
| Part 4「high 事件写入后，向大獭（若在场）下一 turn 注入 reminder（复用 Part 3 注入管道）」 | healingAlertRegistry + DynamicContext.healingAlerts（注入面与 C1 的 halt 管道同构：都是「下一 invoke 边界注入」） | 无 |
| Part 4「通道不变，加一条分级路由」 | intercept 内 severity 分支，台账通道零改动 | 无 |

## 与方案的偏差

| 偏差 | 理由 |
|---|---|
| ① 形态 2 前侧不设硬边界（母方案例句校准） | 母方案自身例句「快停下」「都停下」命中——前侧「快」「都」是文字不是标点。中文命令形态「快/都/给我+停下」前侧恒为副词文字，前侧硬边界 = 把母方案的正例全部拒掉。后侧硬边界已排除「停下手头工作」（动词短语粘连）。前侧放宽的误报面（如「这个词叫停下」）由不硬拦设计兜底：reminder 引导 LLM 语境确认，讨论语境不急停——这正是母方案「检测+reminder 注入，LLM 确认」取舍的本意。失效方向安全（R3） |
| ② healing 高危路由不落 signal_events（内存队列而非台账） | 母方案 Part 4 未要求落 signal_events；healing_events 主台账已是持久化真相源（每日健康检查消费），内存队列是「未送达的提醒」不是审计数据。进程重启丢队列 = 大獭错过一次即时提醒，台账数据完整、每日批处理兜底——与 haltRegistry 同款取舍 |

## 审视处置记录（检视獭-535，kimi 异模型）

首轮 1 严重 / 4 建议，全部本 PR 处置：

| 发现 | 级别 | 处置 |
|---|---|---|
| 形态 1 trim 行为文档未声明 emoji 语义 | 严重 | 交付内容表 L2 扫描器行补「emoji 不在 trim 范围——emoji 属内容字符，emoji 包裹的消息走形态 2 边界判定」+ 形态 2 兑底测试钉死 |
| reminder 首句「非讨论/引用形态」过度断言 | 建议 | 首句改为「形态：后侧为硬边界」——扫描器只断形态断不了语境，语境判定完全交给第二句（前侧放开的兑底前提） |
| 零宽/变体字符后侧全 MISS | 建议 | 边界字符类扩 `\p{Mn}\p{Mc}\p{Cf}`（trim 同步），4 断言钉死 VS16/ZWSP/ZWNJ/组合重音符 |
| registry 注释「5 秒内到大獭」实时性错觉 | 建议 | 注释改为「下一个 invoke 边界送达，大獭 invoke 中途 enqueue 的事件顺延到下下轮」 |
| #534 行为等价性 | 无发现 | — |

## 测试

| 面 | 文件 | 覆盖 |
|---|---|---|
| L2 扫描器 | `tests/usecases/signal/stop-word-scanner.test.ts` | 形态枚举 18 例：完全相等（纯词/尾标点/首尾混合/中文标点）、片段独立（快停下/居中标点/emoji 边界/中英混排/零宽变体后侧/emoji 前缀形态 2 兑底）、负例（停下手头工作/两侧文字/不含完整词/空消息）、reminder 语义（引导文本/零开销） |
| L2 接线 | `tests/usecases/conversation/dispatch-chain-engine.test.ts`（+4 例） | 独立成词注入 reminder + 原文保留；命令形态注入；讨论语境零注入；普通消息零注入 |
| 高危路由 | `tests/usecases/healing/healing-alert-registry.test.ts` | registry 纯逻辑 4 例（送达即删/对话隔离/滞留补提醒/上限丢最旧）+ intercept 集成 3 例（high 登记且台账照落/low 不路由/多条逐条登记）+ render 2 例（引导文本/截断） |
| #534 防回归 | `tests/interface-adapters/agent-runtime/tools/tool-dedup-registration.test.ts` | 工具名零重复断言（任何注册路径回归即红）+ healingRepo 缺省不注册 |

全量 1887/1887 绿（实现者首报 1865 为笔误，检视者独立实测 1885；本 PR 新增 27 用例：初始 25 + 审视处置追加 2——零宽/变体字符 4 断言合并 1 例、trim 不剥 emoji 形态 2 兑底 1 例），tsc/eslint 零错。

## 后续动作

- C4：SYSTEM.md/SMALL_OTTER.md 信号义务 prompt + UI 徽章 + 每日对账 + capability 收口（grep it.todo 零命中）——追踪 issue #533
- C4 后全链路手测剧本 A-E（母方案 L210-214），其中剧本 B（用户词合流）依赖本期的 L2 扫描、剧本 E（healing 高危路由）依赖本期的路由管道
