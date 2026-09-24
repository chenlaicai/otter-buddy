---
id: F20260924thnk
title: 合成影子通道 thinking 关闭：修复思考型模型烧光 max_tokens 正文零输出
status: draft
change_type: fix
created: 2026-09-24
created_in_conversation: f4982c33-edbf-4156-913d-aaac095ff485
fixes_issue: 
causal_links:
  - F20260924swin
  - F20260923hsyn
modules:
  - src/frameworks/agent/pi-session-factory.ts
  - src/frameworks/agent/context-tokens.ts
  - src/interface-adapters/agent-runtime/agent-invoker.ts
capability_test:
  - tests/frameworks/agent/compaction-synthesis-shadow.test.ts
  - tests/interface-adapters/unified-handoff.test.ts
tags: [handoff, synthesis, thinking, max-tokens, regression]
summary: PR #1163 合入后生产验证仍见机械档案，排查定谳三事件：①上午失败=主进程未重启跑旧代码；②下午真 bug=合成影子通道漏设 thinkingLevel，思考型模型 thinking 烧光显式 maxTokens=4,096 致正文 0 字 stopReason=length（机制推断高置信）——修复=合成 session 显式 setThinkingLevel('off')+applied 检查、观测三件套（resolved 模型/applied thinkingLevel/usage）、进度文案按 trigger+synthesizePast 如实；③「没勾总结仍触发」=文案误报。narrow-fix。
---

# 合成影子通道 thinking 关闭：修复思考型模型烧光 max_tokens 正文零输出

## 背景（意图锚）

搭档 2026-09-24 14:22：「太逗了，我更新代码重启系统，然后再拿你验证重启獭生，发现还是机械档案。你自行再排查」

这是 F20260924swin（PR #1163，同日 14:09 合入）后的第一次生产验证。伙伴要求「最后一次修复」必须过 mimo 异体审视（上午 8:49 原话：「这次你出了方案后，你必须得拉mimo一起来审视下，我期望本次是最后一次修复了。要完整来看整个流程、不要再打补丁还打错位置」）。

## 预注册

- 预期根因方向：合成链路请求参数问题（预算/模型/token 相关）
- 验证标准：日志中出现 `length/stopReason` 或 400 类字段实证参数错配
- 反例方向：若见 Lock acquire timeout 则转向锁问题——未出现，排除

## 问题现象（三个独立事件叠加）

伙伴报告的两类现象，排查定谳为**三个独立事件**，其中只有一个是真 bug：

### 事件①：上午 08:34「交接未能完成，保持当前世代」——不是 bug，主进程未重启

- 旧进程 pid 95447 从 9/23 20:24 起存活：其日志最后一条在 11:53:43（log:1263288），进程存活至 14:13:36 收到 SIGTERM（log:1269168）——11:53 后无日志是无活动所致，非进程退出
- 伙伴「更新代码重启系统」实际只重启了前端 dev server（推断：pid 证据只证明主进程未重启，具体动作无法从日志确认），otter-buddy 主进程未重启
- 上午 08:34:43 的重启獭生在旧代码上执行：`shadow channel starting: kimi-256k, promptLength=227110` → `400 exceeded k3-256k model token limit`（log:1247339-1247349，time=1790210083727）——F20260924swin 修的原始 bug 原样复现，因为**修复代码未被加载**；另 09:52:15 还有一次 233,937 chars 同因 400 失败（log:1253862）
- pid 95447 生命周期内，新代码独有的观测日志 `[handoff] synthesis trim` 零出现（实证运行的是旧代码）
- 另有 11:46/12:33 两次 kimi-256k 周配额 403 失败（log:1262998/1263723）——旧代码时代且属外部配额问题，与本链路无关，仅备案

### 事件②（真 bug）：14:16 机械档案——合成 session thinking 烧光 max_tokens，正文零输出

新进程 pid 52579（14:16 起，伙伴真重启了主进程）执行链路，日志全链路定谳：

```
14:16:08 [handoff] synthesis trim: inputChars=325,127 / measuredFixedChars=1,775 /
         historyBudgetChars=724,777 / droppedCount=0 / promptChars=326,902   ← F20260924swin 修复全部正确工作
         （预算 724,777 = 1M×0.693 ✓；无需裁剪；预检 326,902 < 727,510 放行 ✓）
14:16:08 [compaction-synthesis] shadow channel starting: promptLength=326,902
14:17:05 [compaction-synthesis] shadow channel completed: length: 0, lastStopReason: "length"
         ← 合成跑 57s，正文 0 字，max_tokens 烧光（thinking 吃完全部 4,096）
14:17:05 [handoff] narrative synthesis failed: "LLM synthesis truncated (stopReason=length),
         refusing to persist incomplete summary" → degrading to mechanical archive
         ← F20260903lngth 的 fail-closed 防线正确拦截（空档案未落盘）
```

**根因**：`runCompactionSynthesis`（pi-session-factory.ts:435）创建 inMemory session 后**未调 `setThinkingLevel`** → SDK 默认链 DEFAULT_THINKING_LEVEL="medium"（pi-session-factory.ts:968 注释自证）→ 思考型模型（mimo-pro/glm/kimi）在 medium 档先思考后写正文 → **thinking 与正文共享 maxTokens 预算**（F20260924swin 显式钉 4,096）→ 57 秒 thinking 烧光 4,096 tokens、正文 0 字 → stopReason=length → fail-closed 拒绝 → 机械档案。

**这是 F20260924swin 引入的回归（机制推断，高置信，待 usage 定谳）**：显式 maxTokens=4,096 定标时只量了正文（实证 ≤2,415 chars ≈ 1K tokens，留 4 倍余量），未计入 thinking 消耗——修复前 max_tokens 未发送（服务端默认 ~64K 输出），thinking 烧得起；修复后 4,096 全额里 thinking 优先烧光。对话 session 有 thinkingLevel 注入（pi-session-factory.ts:968-980），合成影子通道漏了同款处理。

**归因的机制链与证据边界**（对抗审视后修正）：simple-options.js:38-44 `DEFAULT_THINKING_BUDGETS.medium=8,192`；:59-64 把 thinking 预算 clamp 到 4,096−1,024=3,072（MIN_ANSWER_TOKENS=1,024）；anthropic-messages.js:864-869 budget_tokens 是软预算，烧穿后吃光 max_tokens 天花板 → 正文 0 字 stopReason=length，与 14:16 日志（57s / length:0）吻合。completed 日志无 usage 字段，缺 completion_tokens 级一锤定音证据——归因定为「机制推断（高置信）」，改动点 3 的 usage 观测落地后，下次真实合成自动定谳。

**证据边界（如实声明）**：14:16 是唯一一个显式 maxTokens=4,096 的案例，无对照组。「行为反转」的对照论证不成立（审视后删除）：10:39:31 的 kimi-256k 136,073 chars 成功案例（log:1257484）与 08:34 的 227,110 失败案例同为旧代码（max_tokens 均未显式钉），成败差异是输入是否超窗（F20260924swin 修的旧 bug），不能佐证本归因。

### 事件③：「没勾前世总结还是触发了总结」——文案误报，合成确实没跑

`synthesizePast=false` 时代码真跳过 LLM 合成（agent-invoker.ts:1020 条件 `synthesizePast && !skipSynthesisByCircuitBreaker && ...` 把关，走 `no jsonl content to synthesize` 或直接机械档案分支，日志可证）。但进度文案 `⏳ 的上下文已满…正在封装前世档案…`（agent-invoker.ts:979）**无条件发送**，伙伴看到「封装前世档案」以为在跑总结——实际是文案没区分。

## 修复方案（修法决策树①：既有机制语义内补齐）

三处修复，全部在既有机制/既有代码路径内：

### 改动点 1（核心）：合成 session 显式关闭 thinking

`pi-session-factory.ts` `runCompactionSynthesis`：createAgentSession 后加：

```ts
// 合成任务禁思考：thinking 与正文共享 maxTokens（4,096），思考型模型 medium 档
// 思考可烧光全部预算致正文 0 字 stopReason=length（2026-09-24 14:16 生产实证）。
// 摘要任务 prompt 自带结构化指令，off 不降质。
// 注意：off 是否生效依赖模型 thinkingLevelMap（k3 系 "off":null → clamp 到 low）；
// 当前生产模型均走 fallback 空 map（off 合法），applied 值日志落锚防静默失效。
session.setThinkingLevel('off');
const appliedLevel = session.thinkingLevel;
if (appliedLevel !== 'off') {
  this.logger.warn('[compaction-synthesis] thinking off clamped, synthesis may burn output budget', {
    otterId, requested: 'off', applied: appliedLevel });
}
```

依据：对话 session 的 thinkingLevel 注入是既有机制（pi-session-factory.ts:968-980，F20260909mthl），合成影子通道是同类 session 创建路径漏配。`setThinkingLevel` 是 SDK AgentSession 标准方法；'off' 档位合法性**依赖模型 thinkingLevelMap**（models.js:551-584：map[level]===null → 不支持 → clamp 向高找）——当前生产模型（glm-5.3/mimo-v2.6/k3 均不在 provider dict）走 models-factory.ts:129-139 fallback 注入空 map，off 合法；若未来切 kimi-coding 正主模板（k3 "off":null）会被 clamp 到 low 且 anthropic-messages.js:870 连 disabled 都不发——applied 检查 + warn 日志把静默失效变可见。

### 改动点 2（观测三件套）：shadow channel 日志打真实执行语义

合成链路观测三件套（对抗审视严重3 合并处置）：
1. **starting 日志打实际 resolved 模型**（现打 `this.getModelAliasForLog(otterId)` config 值——14:16 现场显示 mimo-pro 但实际执行模型是 glm（推断：信任上下文大獭=glm + override 优先逻辑三源交叉，重启请求的 modelAlias 记录是直接证据，日志字段落地后可直接验证））+ **applied thinkingLevel**
2. **completed 日志补 usage**（completion_tokens/thinking 级证据——下次真实合成自动定谳归因，也把「日志只能看结果不能诊断」补上）
3. 进度文案（改动点 3）

`pi-session-factory.ts:468-471`（starting）与 completed 两处日志改打 resolution 后真实值。

### 改动点 3（文案）：进度消息按 trigger + synthesizePast 区分

`agent-invoker.ts:979` 进度文案现状：`⏳ …的上下文已满（${trigger}触发），正在封装前世档案…`——两个误报：手动触发时「上下文已满」写死不实（手动重启未必满）；synthesizePast=false 时「封装」暗示在跑总结。改为按两变量分支：
- 手动：`⏳ 正在重启獭生（${synthesizePast ? '前世总结中' : '机械转储，已跳过前世总结'}）…`
- 水位/其他：`⏳ 上下文已满（${trigger}触发），正在封装前世档案${synthesizePast ? '' : '（机械转储，已跳过前世总结）'}…`

## 机制识别检查点

- □ 新增配置字段/枚举/开关：否（硬编码 'off'，同对话路径 thinkingLevel 注入语义）
- □ 新增状态生命周期：否
- □ 新增定时任务/后台进程：否
- □ 新增信号类型/消息格式：否
- □ 新增持久化存储：否
- □ 新增决策分支（结果被记住影响后续）：否（运行时行为修正）
- □ 新增跨模块调用路径：否

全部未命中 → 走修法决策树①（既有机制内补齐），Modification-Class: `narrow-fix`。

论证：命中清单零项——setThinkingLevel 是 SDK 既有方法，对话路径已有同款注入先例（:968-980）；本次是把既有注入补到漏配的姊妹路径，非新增机制。

## 验证

- 单测：合成 session 创建后断言 thinkingLevel==='off'（mock sessionManager 捕获 setThinkingLevel 调用）+ applied ≠ off 时 warn 日志断言；maxTokens 仍为 SYNTHESIS_EXPLICIT_MAX_TOKENS（回归钉）
- NaN 边界：单测钉注入层有限数（maxTokens 恒=4,096）；SDK 内部 NaN（off 档 budgets['off']=undefined）靠 off 常态先例（compaction.js:442 特判 + session-manager.js:147）间接排除，真实请求验证留生产观测
- 回归钉：stopReason='length' fail-closed 防线行为不变（F20260903lngth 语义保持）
- 全量测试 + tsc + CI

## 验收锚（失败可诊断版）

- 成功：shadow channel completed 日志 `length>0 且 lastStopReason=stop`，且 starting 日志 `thinkingLevel:off` + resolved 模型正确；伙伴重启獭生（勾前世总结）产出「完整叙事档案」
- 失败时日志可判别失败模式：off 被 clamp（warn 日志）/ 端点忽略 disabled（usage 里 thinking tokens>0）/ max_tokens 链路异常（usage completion+thinking 总额）/ 截断（stopReason=length + usage）

## 影响范围

| 触发路径 | 影响 |
|---|---|
| 手动重启獭生（synthesizePast=true） | 合成不再被 thinking 掐死，叙事档案恢复 |
| 水位交接 / 熔断交接 | 同上（同走 runShadowSynthesis） |
| Pi 自压缩钩子 | 同走 runCompactionSynthesis，同受益 |
| synthesizePast=false | 无合成行为变化，仅进度文案如实 |

## 风险与取舍

- off 思考对合成质量的潜在影响：prompt 为结构化七段式指令 + 固定段供料，非推理任务，预期无感（kimi k3 2026-09-24 10:39:31 成功案例 length=2,158 档位未知但输出合格，log:1257484）。若上线后合成质量下降，可改低档（low）而非 off——留一行注释说明。
- 伙伴验收锚：修复后手动重启獭生（勾选前世总结）应产出「完整叙事档案」；shadow channel completed 日志 length>0 且 lastStopReason=stop。

## 实现记录（2026-09-24，审视通过后）

三改动点全部落地（commit 82a15657，PR #1166；delta 处置后 amend，初版 302ec8f0 已被替换）：① disableSynthesisThinking（off + applied 检查 warn，抽方法）；② 观测三件套——resolveSynthesisModel/logSynthesisStarting/logSynthesisCompleted 抽方法 + context-tokens.ts 新增 getLastUsage；③ 进度文案 trigger+synthesizePast 分支。全量 281 文件 3,966 测试通过（+4 新用例）、tsc/eslint 0 error、CI 三绿（run 35968755594 初版 + 35969767067 amend 后，均三绿）。

## delta 处置记录（检视獭-thnk 对抗审视，2026-09-24）

**初轮**（3 严重 + 4 建议）→ 全部采纳：严重1（对照实证失实/日期错一天/时间线修正，归因降为「机制推断高置信+待 usage 定谳」）、严重2（off 合法性依赖 thinkingLevelMap 改口+applied 检查 warn 日志）、严重3（观测三件套：resolved 模型+applied thinkingLevel+usage；验收锚失败可诊断版）；建议1（dev server 推断标注+补 233,937 案例）、建议2（trigger 分支文案）、建议3（补 summary）、建议4（glm 执行模型标推断+观测落地后可验）。
