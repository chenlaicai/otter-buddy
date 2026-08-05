---
id: F20260805abpp
title: abort-prefill-projection
doc_type: feature

# 记忆索引
summary: |
  修复"系统保护中断"事故的双根因：guard 工具结束后误用滑动超时窗口 + 前端 abort 终态投影丢失。
  guard resume 统一 re-arm 首字节窗口（post-tool 冷 prefill 与 prompt 首发同性质），删除冻结/恢复机制。
  前端常驻 /subscribe 通道补 message.aborted 处理器，续看轮询定点拉取提前于空增量返回、并改自续期循环。

# 因果链路（正向依赖）
causal_links:
  from:
    - F20260804dglp   # degenerate-loop-silence-fix（guard 重构，冻结语义在此引入）
    - F20260724cwgn   # 统一渲染通道 + 轮询续看（refreshMessages 原始设计）

# 元数据
status: development
change_type: fix
tags: [output-guard, timeout, sse, abort, frontend-projection]
modules:
  - src/frameworks/agent/output-guard.ts
  - tests/frameworks/agent/output-guard.test.ts
  - web/src/pages/conversation/index.tsx
  - web/src/lib/message-stream.ts
  - web/src/lib/message-stream.test.ts

# 时间
created_at: 2026-08-05
---

# F20260805abpp: 中断可见性修复——guard 工具后首字节窗口 + 前端 abort 投影

## 事故背景

2026-08-05 上午同一污染 session（大獭，mimo，上下文 67万~96万 token）连发两起"系统保护"中断，
排查中暴露两个独立缺陷：

### 事故 1：《对话列表的状态图标》—— streaming_timeout 误切

用户发"你继续"，大獭工具调用循环后，下一次模型生成 **120 秒零 delta**，
guard 以 `streaming_timeout`  abort（`timeoutMs=119880 totalLength=61`）。
该请求 input=351,906 token——工具结束后的冷 prefill 静默期超过滑动预算 120s。

### 事故 2：《关键资源太长了》—— abort 发生了但用户 6 分钟看不见

guard 于 01:38:03 真实触发 `degenerate_output`（repeat_window 50 次）并广播
`message.aborted`（subscriberCount=2，SSE 已转发）。但用户界面持续显示"生成中"，
直到 01:44:29 用户主动点中断（后端 409：消息已终态），前端重新拉取才显示出
6 分钟前落库的中断文案——用户误以为文案是自己点击的结果。

## 根因分析

### 根因 1（guard）：工具结束 resume 恢复的是滑动剩余预算，post-tool prefill 落入盲区

`OutputGuard.resume("tool")` 按 F20260804dglp 的冻结语义恢复暂停前的滑动剩余
（≤120s）。但工具执行结束后紧跟的是**新请求的冷 prefill**（全量上下文重算），
与 prompt 首发同性质——compaction/auto_retry 的 resume 早已 re-arm 首字节窗口
（300s），唯独 tool 走滑动剩余。大上下文 session 的 prefill 超 120s 即被误切。

### 根因 2（前端）：常驻 SSE 通道缺 message.aborted 处理器

会话页有两套事件处理器：随发送请求建立的流（有 `message.aborted`）和页面常驻
`/subscribe` 通道（**没有**）。混合架构下功能页间 MPA 整页刷新会杀死发送流，
刷新后 abort 终态只能经常驻通道到达，被 `handlers[currentEvent]?.(data)` 静默丢弃。

### 根因 3（前端）：续看轮询双重失效

`refreshMessages` 用本地最后一条消息作 `/after` 游标，而**增量结果严格在游标之后，
游标消息自身的 streaming→aborted 状态迁移永远不在增量里**。当 in-flight 消息恰好是
最新消息时增量恒为空，`newerMsgs.length === 0` 提前 return 使"in-flight 定点拉取"
兜底成为死代码；且空转不改变 state，依赖 effect 重跑排期的 2s 轮询链在首次无变化后
永久停转（日志证实事故中仅轮询一次即停止）。

## 修复方案

### Part 1：guard resume 统一首字节窗口（`output-guard.ts`）

**不变量**：所有 pause 原因（tool / compaction / auto_retry）结束后跟随的都是新请求的
冷 prefill → `resume` 计数归零时一律 `armTimer("first_byte", firstByteTimeoutMs)`。

- 删除冻结/恢复机制（`pausedRemainingMs` / `pausedKind`）：resume 不再有任何
  恢复剩余预算的路径，机制成为死代码；
- `pause` 纯化为停表 + ref-count；pause 期间到达的 delta 只更新 abort 引用；
- auto_retry 特例（生成中 delta 即释放 pause 并 arm 滑动计时器）保持不变——
  该路径 delta 已到达，prefill 确已结束。

### Part 2：前端 abort 投影（`conversation/index.tsx` + `message-stream.ts`）

- 常驻 `/subscribe` handlers 补 `message.aborted`（与发送流处理器对齐：
  upsert 终态消息 + toast + 清理 live 状态）；两条通道订阅同一广播总线，
  toast 用 ref 持有的 `Set<messageId>` 同步去重（第三轮检视 S-1：updater 闭包
  标志依赖 React 调度时序，存在零 toast 竞态）；
- 所有终态事件 handler（complete/failed/aborted × 两通道）统一走
  `upsertTerminalMessage`：与已有投影合并保留 events/seq/ts/ctx/turnId，
  避免整体替换降级 DTO 快照（第四轮检视 S4-1）；
- `refreshMessages`：in-flight 定点拉取移到空增量 early-return 之前（改为不提前返回），
  提取纯函数 `findStaleInFlight`（message-stream.ts）固化"/after 不含游标消息自身
  状态迁移"这一不变量；定点拉取结果无变化时跳过 setState，避免引用抖动；
- 续看轮询 effect 改自续期循环：`refreshMessages` 完成后无条件排下一轮，
  直到 allMessages 变化触发 effect 重跑时由入口条件（仍有 in-flight）决定去留——
  空转不再断链。

## 验证

- `tests/frameworks/agent/output-guard.test.ts`：
  - 工具结束 resume re-arm 首字节窗口，prefill 静默超滑动预算不误切（事故 1 回归）；
  - 并行工具 ref-count + 末个 resume 首字节窗口；pause 期间 delta 后 resume 仍首字节窗口；
  - resume 后首个 delta 到达即切回滑动窗口（300s 暴露面只覆盖首 delta 之前）；
  - 混合 pause 双向释放顺序；isCompacting 兜底覆盖 first_byte kind；工具路径埋点基准刷新；
  - attach 层 tool_execution_start/end 全链路（首字节窗口断言）。
- `web/src/lib/message-stream.test.ts`：`findStaleInFlight`
  （in-flight 为最新消息必被挑出；终态/tmp/err/已在增量中的排除；speaking 状态覆盖；
  user 消息不算 in-flight）。
- 根仓 `npm run check` 全绿；web `vitest run` + `tsc --noEmit` 全绿。

## 对抗审视记录（五轮：架构师 / 代码质量 / 端到端时序 / 修复面与乱序矩阵 / 最终状态复核）

### 架构师检视（针对 Part 1，对照 SDK 源码逐条验证）

- 【严重 S1，记录不修】**terminate 工具路径上"resume 后必有新请求"不成立**：speak 工具
  terminate 批次结束后 SDK 直接 agent_end，没有新模型请求，但 resume 仍 arm 300s 首字节
  计时器。当前不炸依赖 invoke finally 的 destroy() 及时跟进（同步微任务链）；慢扩展钩子
  （>300s 的 agent_end/turn_end 钩子）出现时虚空计时器会 fire 并把成功 run 误报为
  first_byte_timeout。默认部署（无扩展）不可达。处置：已知例外写入 resume() 注释，
  未来引入慢钩子时需在 terminate 批次结束显式抑制 arm。
- 【建议 I1，记录】pause 期间 delta 的防御（旧：冻结剩余重置为全额滑动预算）已删除，
  乱序 delta 场景下中途挂死检出窗口从 120s 放宽到 300s（收到下一个 delta 即自愈）。
  方向与事故修复相反但影响有限，如实记录。
- 【建议 I2，记录】`firstByteLatencyMs` 统计总体变化：含工具的回合现在上报最后一个
  post-tool prefill 耗时（恰是事故 1 想观测的总体），与历史数据的 prompt TTFT 不再是
  同一总体，调参时注意。已补工具路径埋点测试。
- 【建议 I3，已修】补四条测试：resume→delta 切回滑动窗口、混合 pause 反向释放、
  first_byte kind 的 isCompacting 兜底、工具路径埋点基准刷新。
- 验证通过：SDK 工具只在 assistant 流式结束后执行（不存在流式中途 tool 暂停）；
  工具事件 start/end 配对完备（abort/异常路径均有 end）；auto_retry 特例交互无洞。

### 代码检视（全量 diff）

- 【必须修，已修】web 侧 5 处注释文档 ID 误写 `F20260805abpl`（实际 abpp）——断链。
- 【建议 S1，已修】双通道投递双 toast：两条通道共享广播总线，页面停留期间 abort 会
  双份投递。处置：toast 以 in-flight→终态迁移为条件，后到的 handler 不重复提示
  （发送流与常驻通道两侧同步修改）。
- 【建议 S3，已修】常驻 handler 身份解析改为事件优先（与发送流对齐），补 allOtters
  fill-only 兜底与 maybeScrollToBottom。
- 【可选 O1，已修】定点拉取结果无变化时跳过 setState（消除引用抖动导致的轮询空转重排）。
- 【可选 O3，已修】findStaleInFlight 测试原 tmp/err 用例是空转（被 isInFlight 先行排除），
  改为 otter+streaming 形态真正覆盖前缀过滤；补 speaking 状态用例。
- 【可选 O4，已修】output-guard 两处滞后注释（ref-count 措辞、armTimer 枚举）。
- 【可选 O2，记录】轮询自续期循环竞态检查结论：cleanup cancelled 标志覆盖完备，
  不会双倍轮询；活跃流式期间轮询被饿死但 SSE 活着，无害。

### 第三轮检视（端到端时序回放 / React 调度语义 / commit 交互）

- 【严重 S-1，已修】**toast 去重标志放在 functional updater 闭包里同步读取，存在零 toast
  竞态**：React 19 只在无 pending update 时同步执行 updater（eager state 优化），流式期间
  delta 的 setState 常使 updater 延迟到 render 阶段——`transitioned` 同步读取恒为 false，
  toast 被静默跳过，恰好覆盖本 PR 主打的事故场景。处置：改用 ref 持有的
  `Set<messageId>` 同步去重（abortNotifiedRef），绕开 React 调度时序。
- 【建议 S-2，已修】MPA 新页面（liveMeta/liveEvents 为空）经常驻通道收到 message.aborted
  时，整体替换会降级已有 DTO 投影：events（工具调用链）被抹、ts 被改写为到达时刻、
  seq/ctx/turnId 丢失。处置：两个 abort handler 的 upsert 均改为与已有消息字段合并
  （events/seq/ts/ctx/ctxMax/turnId 回退保留），与定点拉取的保留模式对齐。
- 【建议 S-3，记录不修】定点拉取永久失败（如消息 404）时自续期轮询无界。当前代码库无
  消息删除路径，属假设场景；如未来出现，可加连续失败计数上限。
- 【可选 O-1，记录】SSE abort 先于整页快照 commit 到达时，快照可能把气泡从"已中断"闪回
  "生成中"，≤2s 后由定点拉取收敛——窗口窄、无害。
- 【可选 O-2，复核阴性】自续期轮询与"无变化不 setState"的两种交错均安全，不会双循环、
  不会多发请求。
- 【可选 O-3，复核阴性】first_byte_timeout 与 streaming_timeout 的归因/重试路径无差异
  （仅文案分支）；两个 commit 无矛盾；mapMessageDTO/getMessage/广播通道核查均无第三通道竞争。
  附带存量发现：常驻通道 error handler 的 toast 无同款去重（单槽 Toast 下视觉良性）。

### 第四轮检视（第三轮修复面 + abort 生命周期乱序 + 后端归因竞态）

- 【建议 S4-1，已修】**S-2 的合并保留只修了 abort 路径，complete/failed 四个终态 handler
  是同一缺陷模式的未修实例**——触发条件更常见（任何"生成中整页刷新 → 完成事件经常驻通道
  到达"的正常流程都会抹掉工具调用链、改写时间戳、丢 seq 锚点）。处置：提取纯函数
  `upsertTerminalMessage`（message-stream.ts），六个终态 handler（complete/failed/aborted ×
  两通道）统一走合并保留路径，补三条单测。
- 【建议 S4-2，已修】文档"修复方案"节 toast 去重描述停留在 commit 1/2 的废弃机制
  （in-flight→终态迁移条件），与最终实现的 ref Set 同步去重不一致——已更正。
- 【可选 O4-1，记录】stopStream 乐观中断后 finally 的 getMessage 可能把气泡闪回"生成中"
  （服务端 abort 尚未 unwind），秒级窗口，存量行为。
- 【可选 O4-2，记录】abortNotifiedRef 无清理：MPA 切换对话必整页刷新重建组件，id 唯一、
  数量极小；未来若改 SPA 内切对话需重估。
- 【可选 O4-3，记录】中断按钮 409 无用户可见反馈（catch 仅 console.error，finally 的
  getMessage 会收敛状态）。本 PR 后 409 路径已降级为兜底揭示，重要性大幅下降。
- 【可选 O4-4，记录】后端 sendMessage.abort() 失败被吞但 message.aborted 照发，DB 与前端
  可能永久发散——需 DB 写失败才可达，存量、极窄。
- 【可选 O4-5，记录】常驻通道缺 system.message 处理器（发送流有），MPA 刷新后系统消息
  在下次整页加载前不显示——存量缺口，与本 PR 正交。
- 复核阴性：ref Set 去重无 React 调度依赖（S-1 修复正确）；双通道 aborted upsert 经
  existing 合并幂等；aborted→complete 双终态事件后端互斥不可达；后端归因竞态（用户 abort
  vs guard abort）无双丢窗口，用户归因优先是注释写明的设计。

### 第五轮检视（upsertTerminalMessage 字段矩阵 / commit 4 行为差异 / CI 盲区 / 最终一致性）

- 结论：**通过，可以合并**。字段优先级矩阵（`??`/`||` 选择、spread 顺序、六个调用点的
  ts 哨兵约定）逐项验证无洞；commit 4 对 M6 tmp 补戳、滚动位置无行为差异；文档与 5 个
  commit 最终一致；根仓 983 测试 + web 77 测试实跑全绿。
- 【建议，存量后续跟进】两个通道的 error handler 仍用裸 upsertMessage：携带真实
  messageId 的 error 事件会整体替换 in-flight 占位、抹掉 events/seq/ts（S4-1 同类），
  且若后续 message.failed 到达，existing 已被抹过、不可恢复。main 上即如此，本 PR 未触碰。
- 【建议，流程缺口后续跟进】CI 从不执行 web 测试（ci.yml 无 `npm --prefix web test`
  步骤）——本 PR 的全部前端回归测试在 CI 零覆盖。
- 【可选，记录】dur 不在合并保留清单：事件缺 duration 时会抹掉 existing.dur，
  需"已有 dur 的终态消息 + 重复 complete 事件"才可达（subscribe 不重放历史），几乎不可达。

## 影响面

- **agent 行为**：工具调用后的首次模型响应窗口从滑动剩余（≤120s）变为首字节预算
  （默认 300s）。正常流式下首个 delta 到达即切回滑动窗口，无感知；大上下文 prefill
  不再被误切，真正挂死的请求仍会被 first_byte_timeout 兜底（文案"模型响应超时"）。
  已知例外见"对抗审视记录"S1。
- **API/持久化**：无变化。
- **前端**：abort 终态在 MPA 刷新后可靠投影；in-flight 消息的轮询收敛不再断链。
