---
id: F20261111synth
title: 叙事合成 thinking 能力解析与兜底（修 kimi 端点合成 100% 降级）
summary: "#1850：合成通道固定 thinkingLevel:'off'，pi-ai openai-responses 对无能力表的自定义模型把 off 翻译成 reasoning.effort:none，api.kimi.com 拒收（实测 none/minimal/off 400、low/medium/high 200）→ kimi 系换世合成 6/6 全败机械档案（11-11 全天 12 换世 9 机械；glm/apig 3/3 成）。四层治本：F1 合成模型按 (host+id) 继承 SDK kimi-coding 目录能力表+显式选最低可表达档（durable 无 clamp、端点无参数默认开思考，均不可依赖）；F2 max_tokens 4096→8192；F3 传输失败兑底（缺省 glm）重试；F4 机械档案携带失败原因。聊天路径零改动。"
change_type: bugfix
capability_test: "tests/frameworks/agent/synthesis-thinking-capability.test.ts 7 例：能力表继承/未知 host 不猜/选档矩阵/预算 8192/兜底重试/非传输不重试/档案错误摘要；unified-handoff.test.ts 34 例含 F4 管道新测"
created_in_conversation: a23f0f4a-612c-46e9-8d83-be648ced720e
causal_links:
  from: [F20260924thnk, F20260924swin, F20261110dursl, F20261110synid]
  supersedes: []
tags: [session, handoff, narrative-synthesis, llm, thinking]
modules:
  - src/frameworks/agent/synthesis-thinking-capability.ts
  - src/frameworks/agent/pi-session-factory.ts
  - src/frameworks/agent/narrative-synthesis-engine.ts
  - src/interface-adapters/agent-runtime/agent-invoker.ts
  - src/usecases/ports/sdk-invoke-port.ts
---

# 叙事合成 thinking 能力解析与兜底（F20261111synth）

## 问题（#1850，2026-11-11 换世档案大量机械归档）

全天统一交接换世 12 次，9 次机械档案。两类原因：

1. **6 次 = 本 bug**：叙事合成执行失败。模式完全按模型协议分布——kimi/kimi-lty
   （provider: openai 无 apiFormat → pi-ai openai-responses 协议）6/6 全败；
   glm（anthropic）/ apig-*（apiFormat: chat → completions）3/3 全成。
2. 3 次 = 显式跳过合成（synthesizePast=false）：两次獭应急选择（恢复交棒链自重启、
   429 换模型）+ 一次 UI 勾选框被取消（前端默认勾、条件挂载每次重置，无 bug）。

### 根因链（实测定谳）

1. 合成影子通道固定 `thinkingLevel:'off'`（F20260924thnk，防思考烧光输出预算——
   动机正确）。
2. kimi 系别名 `provider: openai` 且无 `apiFormat` → models-factory 默认
   openai-responses 协议；modelId（k3.1-pro）不在 openai 目录 → 自定义模型
   thinkingLevelMap 置空。
3. pi-ai responses 构造器对「off」下发 `reasoning:{effort: map?.off ?? "none"}`
   （1.4.0 与 1.5.0 同款，非 #1783 升级回归）。
4. api.kimi.com 拒收 none（也拒 minimal/off；收 low/medium/high）→ 400 → 降级。

正常对话不受影响：config 为 kimi/kimi-lty 配了 `thinkingLevel:"max"` 走 effort=max。
**为何 11-11 爆发**：#1814（durable 切片读取）+ #1820（合成 invokeId）昨天才把换世
合成链路修到真正可跑，当天是修复后首个全天，kimi 系合成首次实际执行即撞墙。

### 关键实测（2026-11-11，配置内 key 直打端点）

| 请求形态 | 结果 |
|---|---|
| responses + `reasoning.effort=none`（合成路径现状） | 400 `reasoning.effort value "none" is not supported`（与日志逐字节一致） |
| responses + `effort=minimal` / `effort=off` | 400 同款 |
| responses + `effort=low` / `medium` / `high` | 200 正常输出 |
| responses 无 reasoning 参数 | 200 但默认开思考（"hi" 烧 48 reasoning tokens，档位不可控） |

pi-ai 自带 kimi-coding 目录对 k3 全系声明真值：
`{off:null, minimal:null, low:"low", medium:null, high:"high", xhigh:null, max:"max"}`
（off:null = 端点无法关思考；medium:null 与 responses 实测的矛盾见 known issue）。

## 方案（四层）

### F1 能力层：合成模型副本挂真实能力表 + 显式选档

`resolveSynthesisThinkingLevelMap(model)`：模型已有非空能力表 → 不覆盖；
按 `baseUrl host` 匹配能力目录注册表（`api.kimi.com` → SDK kimi-coding 目录），
同 modelId 命中 → 返回目录能力表副本；未知 host/目录无此 id → undefined（不猜能力）。

`pickSynthesisThinkingLevel(map)`：off 可表达（字符串）或空表 → `off`（原语义）；
off:null → 全序（off/minimal/low/medium/high/xhigh/max）第一个字符串档
（kimi 真值 → `low`）。

**为什么必须显式选档，两个「想当然」都被实测否决**：
- 依赖 SDK clamp？clamp（clampThinkingLevel）在 pi-coding-agent 的 AgentSession，
  pi-durable 运行时不存在——durable 对 off 的翻译是「不发 reasoning 参数」
  （harness/generation.js: `thinkingLevel === "off" ? {} : {reasoning}`）。
- 依赖省略参数？端点默认行为是开思考且档位不可控（实测 "hi" 烧 48 reasoning
  tokens）——等于把预算交给服务端默认。

**为什么只挂合成路径**：能力表是目录为 completions 协议写的；实测端点 responses
收 medium 而目录 medium:null——全量挂聊天路径会把 kimi-highspeed（无显式档位，
默认 medium，实测可用）静默抬到 high（计费档翻倍）。聊天路径零改动是刻意的。

### F2 预算层：SYNTHESIS_EXPLICIT_MAX_TOKENS 4096→8192

off 不可表达时合成以 low 档执行，思考与正文共享 max_tokens（reasoning 是 output
子集）。9-24 事故是 medium 烧光 4096 致 0 字输出（57s/length:0）；low 更省，双倍
余量吸收思考税。输入容量代价 4k tokens，对 262K/1M 窗口可忽略。

### F3 韧性层：传输类失败兜底重试一次

`isSynthesisTransportError`（API 4xx/5xx/ECONN/ETIMEDOUT/fetch failed）→ 关闭失败
session、用兜底模型（`synthesisFallbackAlias ?? 'glm'`，池校验缺失则跳过）重试一次，
`fallbackUsed` 入日志与 SynthesisRunResult。非传输错误（逻辑错误/超时）不重试。
有界（+1 次尝试），D9「永不阻塞换世」语义不变。未来任何「目录不认识的新端点」
传输不兼容由这层接住，不再裸降级。

### F4 观测层：档案自证

机械档案说明段携带失败原因原文（截 200 chars）：`buildMechanicalArchive` 新增
`degradeErrorDetail`，agent-invoker catch 块把 err.message 贯通进档案。动机：
11-11 09:32 那份机械档案因进程日志轮换只能按同签名推断归因——档案必须自证。

## 已排除路径

- **全局调大固定预算/调小档位**：不解决「端点词表不含 none」的结构性问题。
- **kimi 系别名改 apiFormat:"chat"**：正常对话面全换协议（effort 映射/缓存语义
  都要重新验证），影响面远超合成路径——记为后续独立验证项，不在本 PR。
- **全量挂能力表到聊天路径**：kimi-highspeed 静默抬档翻倍计费（见 F1）。
- **off→low 写死**：选档必须按能力表全序推导（未来端点可能没有 low 只有 high）。

## 影响范围

- 行为变更（有意）：kimi 系模型换世合成从 100% 机械档案恢复为叙事合成（low 档
  思考 + 8192 输出预算）；合成显式 max_tokens 4096→8192（两处旧断言随预算更新）；
  传输类合成失败先兜底重试再降级；机械档案说明段可能多一行「失败原因：」。
- 零改动：聊天路径模型请求形态；user-off/circuit-open/empty-session 等降级语义；
  熔断计数口径；档案组装结构。
- 爆炸半径归档（如实填写）：单 worktree、6 源文件 + 3 测试文件、git 可回滚、
  合成路径单实例可隔离（聊天路径不受影响）。

## 验证

- 红测先行（cbfb8d85）：4 红（能力表/预算/兜底/档案自证）+ 2 反例绿（未知 host
  不猜、非传输不重试）；F1 机制修正（ff9d0396）后 T1 断言 low + 选档矩阵 7 例。
- 全量 5897/5897、tsc、lint 通过。
- 真端点实测矩阵见上表（none/minimal/off 400；low/medium/high 200；无参数默认
  开思考）——合成链路的最终端到端验证待合入后首次真实换世（观测锚：
  `[compaction-synthesis] capability map attached` 日志 + 档案形态）。

## Known Issues（不在本 PR 处理）

1. **kimi-highspeed 默认 medium 与目录 medium:null 的矛盾**：端点 responses 实测
   收 medium，目录（completions 词表）说不可用。若未来全量挂表需先解决该矛盾；
   当前建议在 config 为 kimi-highspeed 显式声明 thinkingLevel（搭档决策，涉及计费档）。
2. **kimi-256k / kimi-highspeed 合成**：同端点同机制，本修复自动覆盖（能力表按
   host+id 解析，k3-256k 在目录内）。
3. **兜底模型缺省 'glm' 未进 config schema**：今天正确；需要换兜底模型时升格为
   `llm.synthesisFallbackAlias` 配置键（3 行装配，见 platforms.ts 注入点）。

## 谱系

F20260924thnk（合成禁思考）→ 本修复：意图保留（省思考预算），表达方式从「盲传
off」升级为「按端点能力显式选档」。F20260924swin（显式 max_tokens）→ 预算随
思考税上调。F20261110dursl/F20261110synid（合成链路修复）→ 本事故的暴露前提。
