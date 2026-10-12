---
id: F20261012swsg
title: "安全词扫描来源闸 + reminder 机械证据锚点：非用户触发消息不再被误扫（#1430 假急停）"
summary: "P1 bug 修复：L2 安全词扫描对触发消息全文扫描、不区分来源，scheduler 定时任务 prompt（自带「停下，」字样）与 system 合成消息被当「用户消息」扫描，注入假急停提醒致大獭误急停（10-12 08:29 雷达任务事故；11:57 system 合成消息二次复现）。三修法：A 扫描闸收窄到 user 来源（executeChain 增 triggerSenderType 透传，8 调用点逐一标注）；B reminder 来源措辞如实（user 保持「用户消息」既有措辞零变化，非 user 标注「触发消息（来源：…）」不冒称）；C reminder 带机械证据锚点 [证据: msgId=… seq=… 来源=…]（F20261012acpt T1 插槽，缺字段降级「未提供」不编造）。"
change_type: fix
capability_test: "n/a: 修复为机械闸（来源判定）+ 锚点透传，行为面由单测锁定——tests/usecases/conversation/dispatch-chain-engine.test.ts「L2 安全词扫描接线」describe（#1430 4 用例：案发形态零注入/otter 零注入/来源缺省零注入/user 命中带锚点）+ tests/usecases/signal/stop-word-scanner.test.ts 锚点与来源推导 describe；golden corpus（tests/capability/golden/anchors/）无安全词场景锚点可跑"
created_in_conversation: 3241317b-99d6-4d78-9248-ff208a7461bc
intent:
  problem: "L2 安全词扫描点不区分触发消息来源（dispatch-chain-engine 对首 hop 触发消息全文扫描），scheduler 定时任务 prompt 与 system 合成消息被当「用户消息」扫描——雷达任务 prompt 自带「停下，」字样（自 2026-09-21 起每次触发都命中）注入假「用户消息命中安全词」提醒，2026-10-12 08:29 致大獭对不存在的用户指令误急停；reminder 固定声称「用户消息」误导下游归因，且无证据锚点可供核实。"
  expected_effect: "来源非 user 的触发消息不进安全词扫描，假急停提醒不再产生（案发形态经 system 来源零注入）；user 路径行为面零变化（首行措辞保持「用户消息命中」）并新增机械证据锚点，下游 LLM 可按 msgId/seq/来源机械核实提醒真伪。回归锁：#1430 四用例 + 既有 4 用例（user 命中/命令形态/讨论语境/普通消息）不回归。"
  verify_by:
    type: behavior_check
modules:
  - src/usecases/signal/stop-word-scanner.ts
  - src/usecases/conversation/dispatch-chain-engine.ts
  - src/usecases/conversation/signal-router.ts
  - src/usecases/conversation/agent-dispatch-service.ts
  - src/usecases/conversation/resume-interrupted-service.ts
  - src/usecases/scheduler/scheduler-service.ts
  - src/usecases/recruiting/process-inbound-recruit.ts
  - src/interface-adapters/http/controllers/message-controller.ts
  - src/interface-adapters/http/controllers/invoke-controller.ts
  - tests/usecases/signal/stop-word-scanner.test.ts
  - tests/usecases/conversation/dispatch-chain-engine.test.ts
tags:
  - stop-word
  - magic-words
  - dispatch-chain
  - source-gate
  - evidence-anchor
  - false-emergency-stop
  - "#1430"
causal_links:
  from:
    - F20260826mwrd
    - F20260827c3hr
---

# 安全词扫描来源闸 + reminder 机械证据锚点（#1430 假急停）

## 1. 背景与事故

2026-10-12 08:29，大獭（restart 后干净上下文首轮）在「外部洞察」对话被「每日 AI 雷达」定时任务唤醒后，发言「收到『停下』，按急停执行了」并急停 yield user——**用户从未发过「停下」**（08:59 搭档指认：「这是严重bug……我根本没说过」）。11:57 同款误报二次复现，触发源为 system 合成消息（[首哑告警] 转发，内嵌文案模板自身的「停下」例句）。

影响面（issue #1430 实录）：
- 雷达任务 prompt 自 2026-09-21 起每次触发都注入同款假 reminder——「LLM 每次都正确忽略」不可依赖（干净上下文首轮即误判）；
- 同分钟触发的其它定时任务同暴露面；
- reminder 的「请确认这是安全指令还是讨论/引用」分支在非用户消息场景两个选项都不成立，LLM 被迫二选一必错一半。

## 2. 根因链

机制层（issue #1430 勘定，本 PR 修复）：
1. **扫描点不区分来源**：`dispatch-chain-engine.ts` 对首 hop 触发消息全文 `scanStopWords`，无 senderType 判定——注释自述「用户原始消息」，但参数实际可能是 scheduler system entry；
2. **定时链路把 scheduler prompt 当触发消息传入**：`scheduler-service.ts`（直连链）与 `signal-router.ts`（invokeTarget）均以 system entry body 为 `userMessageContent` 调 `executeChain`；
3. **reminder 措辞固定声称「用户消息」**：与事实不符，误导下游 LLM 归因（08:29 事故直接推手）；
4. **无证据锚点**：下游无法机械核实「提醒声称的命中」对应哪条真实消息。

行为层（大獭自认，issue 留痕，prompt 层无法机械修复）：注入文本 ≠ 用户原话，`search_messages` 返回空已是决定性反证仍照做——A1 违例。

## 3. 方案设计（issue 修复方向 A/B/C 的取舍）

| 方向 | 处置 | 理由 |
|---|---|---|
| **A 扫描闸收窄到 user 来源（主修）** | ✅ 实施 | 最小修复且治本：用户根本没说话时，用户安全词闸就不该被触碰。`executeChain` 增 `triggerSenderType?: SenderType`，仅 `=== "user"` 才扫描 |
| **B reminder 措辞带真实来源** | ✅ 实施 | A 之后 reminder 只会来自 user，但措辞如实是防未来复用/扩展时重蹈归因陷阱；user 路径保持「用户消息命中」既有措辞（行为面零变化） |
| **C 定时任务 prompt 规避字样** | ❌ 不做 | issue 已论证治标：限制 prompt 表达自由，防不住新任务 |
| **T1 机械证据锚点（F20261012acpt 跨线协调）** | ✅ 随带 | 本 PR 恰好动 reminder 模板生成器，顺手把锚点插槽做出来（协调要求原文：「别在模板层把锚点插槽堵死」）。`[证据: msgId=… seq=… 来源=…]` 机械拼接，缺字段降级「未提供」 |

**fail-closed 方向**：来源缺省（调用方漏传）→ 不扫描 = 漏报方向——与 scanner 既定失效方向一致（漏报退化纯 L1 prompt 检测，无新增风险）；假 reminder（误报）方向已被事故证明是有害的，必须零容忍。

**来源枚举**：T1 基线要求三态（user|scheduler|system），实现取 superset 四态 + 未知——`resolveTriggerSource` 机械推导：user/otter 直映射；system 按 senderId/senderName `scheduler:` 前缀细分 scheduler；信息缺失「未知」不猜。otter 是机械诚实补全（来源信息存在时不归并造假）。

## 4. 设计取舍（机制识别检查点判定，修法决策树）

逐项打勾（清单见 troubleshooting 修法决策树节）：
- 新增配置字段/枚举/开关：**边缘命中**——来源标注枚举为内存推导标签（`resolveTriggerSource` 返回值），非配置/持久化枚举；`triggerSenderType` 是既有 `SenderType`（entities 已有）透传参数
- 新增状态生命周期：否
- 新增定时任务/后台进程：否
- 新增信号类型/消息格式：**边缘命中**——reminder 模板新增证据锚点行（对既有注入文本的增补注记）
- 新增持久化存储：否
- 新增决策分支（结果被记住并在后续影响行为）：否（扫描闸是纯运行时分支，不落库）
- 新增跨模块调用路径：否（既有 `executeChain` 参数透传，8 个调用点都是既有路径）

**为何命中清单边缘项但不涉净新增机制**：两项命中均为「既有机制的注记/透传增强」——锚点行是既有 reminder 模板的机械注记（无新存储/状态/信号类型/路由），来源标签从既有 senderType 推导（无新枚举入库、无新配置面）。修法决策树取 **② 收窄问题机制的管辖边界**（安全词扫描器管辖面从「一切触发消息」收窄到「user 触发消息」）+ **① 既有语义内修**（补齐来源透传——scanner 文档本来就说「扫描用户消息」，实现第一次真正兑现这个声明）。

**Modification-Class: scope-reduction**（轻对抗：commit 声明 + 检视獭核对声明与 diff 一致性，无机制添加故免重对抗门）。

**最简实现检查**：仓库已有 `scanStopWords`（F20260826mwrd）+ `SenderType` 枚举 + `triggerMessageId` 透传先例——本修复只加一个透传参数 + 一个闸判断 + 模板注记行，零新文件、零新依赖。已过最简检查。

**负面向验收条目**（本次变更破坏了什么旧契约 / 绕过了什么既有保护）：
- **旧契约变更（有意）**：`executeChain` 调用方不传 `triggerSenderType` 就不会触发安全词扫描——未来新增调用点漏传会静默失去 L2 网。缓解：8 个既有调用点已全部显式标注 + 测试锁「来源缺省不扫描」的语义（防回退成默认扫描）；L1（SYSTEM.md Magic Words prompt 检测）恒在兜底
- **来源误标风险**：若用户消息来源被误标 system，急停网失效——但失效方向 = 漏报 = 既定安全方向，且 L1 兜底
- **绕过既有保护：无**——不绕过任何既有保护；本修复恰是修复「扫描器管辖边界被绕过」本身
- reminder 新增锚点行对下游是信息附加，指令语义零变化（user 路径首行措辞逐字保持）

## 5. 变更清单

| 文件 | 变更 |
|---|---|
| `src/usecases/signal/stop-word-scanner.ts` | `resolveTriggerSource` 来源机械推导 + `StopWordScanEvidence` + `buildEvidenceAnchor`（缺字段降级「未提供」）；`buildReminder` 来源措辞如实 + 锚点行；`scanStopWords(message, evidence?)` |
| `src/usecases/conversation/dispatch-chain-engine.ts` | `executeChain`/`executeChainInner` 增 `triggerSenderType`/`triggerSequenceNum`；扫描闸 `triggerSenderType === "user"` 才扫描，evidence 机械透传 |
| 8 个调用点 | `triggerSenderType` 显式标注：user——message-controller（dispatchTurnLoop，另透传 `userMessage.sequenceNum`）、agent-dispatch-service（legacy 链 + IM 直连链）；system——scheduler-service（定时 prompt）、invoke-controller（重试续跑合成指令）、process-inbound-recruit（bridge 合成批次）、resume-interrupted-service（重启续跑合成指令）；透传——signal-router（`signal.senderType`，user 信号可扫，system 合成消息/首哑告警转发不扫） |

## 6. 验证

**bugfix 失败证据链（红 → 绿）**：
- **修复前（红，11 failed）**：新增 #1430 用例失败方向即 bug 机械复现——`#1430 system 合成消息（案发形态：雷达 prompt 自带「停下，」）不扫描不注入` 失败于 `expected ... not to contain '[L2 安全词检测]'`（假 reminder 今天确实会被注入）；锚点用例失败于 reminder 无锚点。完整输出存档 `data/workspaces/3241317b-99d6-4d78-9248-ff208a7461bc/red-1430.txt`
- **修复后（绿，70 passed）**：`tests/usecases/signal/stop-word-scanner.test.ts + tests/usecases/conversation/dispatch-chain-engine.test.ts` 全绿（59 既有 + 11 新增），存档 `green-1430.txt`
- **全量**：355 test files / 5367 tests 全绿；`npm run build` 0、`npm run lint` 0
- pre-existing 声明：无（全量零失败，无需基线对照）

**Golden Gate**：n/a（verify_by=behavior_check 但 golden corpus 无安全词场景锚点可跑，行为面由单测机械断言锁定——比 LLM 重放更强的回归保证）。
**锚点重放评审**：适用性判断 = 不触发，理由：①改动主体是机械闸（代码逻辑）与透传参数，非 prompt/skill/tool description 的行为触发语义变更；②reminder 模板指令语义（急停引导/讨论引用分支）逐字未动，仅 user 首行措辞保持 + 新增信息性锚点行；③corpus（B5 为误命中，主题是 delta 复核跳步）无安全词场景锚点，重放无可对应场景。若检视獭认为触达行为语义边界可挑战，补跑重放。

## 7. T1 跨线协调（F20261012acpt，PR #1441 审视中）

issue #1430 评论区协调要求的落实情况：
1. ✅ reminder 模板携带机械锚点 `[证据: msgId=<uuid> seq=<n> 来源=<...>]`——锚点由消息系统机械拼接（`buildEvidenceAnchor`），不经 LLM 书写
2. ✅ 来源枚举三态达成且 superset（user|scheduler|system|otter|未知）——11:57 复现的 system 合成消息来源可表示，二值枚举不漏
3. ✅ 无锚点时降级标注由模板生成器机械拼接（逐字段「未提供」/「未知」），不走 prompt 层
4. **seq 透传面如实说明**：message-controller 主入口透传 `userMessage.sequenceNum`；signal-router/scheduler 等路径的触发 entry seq 未在既有参数面暴露，seq 位降级「未提供」（不为锚点强行扩 SignalView/scheduler 参数面——增量 PR 可按 T1 落地节奏补）
