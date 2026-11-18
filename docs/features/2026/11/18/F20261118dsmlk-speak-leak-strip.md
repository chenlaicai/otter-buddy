---
id: F20261118dsmlk
title: "speak 入口工具调用序列化泄漏剥离：#1916 yield 被拼进 body 的乱码现场"
change_type: fix
created: 2026-11-18
created_in_conversation: a23f0f4a-612c-46e9-8d83-be648ced720e
modules:
  - src/interface-adapters/agent-runtime/tools/tool-helpers.ts
  - src/interface-adapters/agent-runtime/tools/tool-factory.ts
  - tests/interface-adapters/tool-helpers.test.ts
summary: "#1916：大獭 speak 发言 body 末尾混入第二个工具调用（yield）的序列化文本，搭档在聊天界面看到乱码。排查确认：不是解析层切分错误，而是模型（deepseek-v4-pro / openai-completions）在「speak 后紧跟 yield」的连续工具调用时，把第二个调用的序列化写进了第一个调用的 body 参数。应用层无法根治模型/provider 行为，修法走修法决策树①（既有 speak body 校验机制内补缺，narrow-fix）：在 speak 唯一入库口加工具调用序列化泄漏剥离——仅当锚点在 Markdown 代码节点（围栏/行内代码）之外且锚点前紧邻思维闭合标签（泄漏强指纹）时截断，保留正文正常落账；选剥离而非拒绝，避免连续 speak+yield 场景重试死循环。"
tags: [speak, serialization, tool-call, leak, P0]
intent:
  problem: "deepseek-v4-pro 在连续工具调用（speak 后紧跟 yield）时，第二个调用未走结构化 tool_calls 通道，而是把其序列化文本写进 speak.body 参数末尾，直接污染搭档可见的发言流，并可能让下游渲染把序列化标签误当合法标记或泄漏内部实现细节。"
  expected_effect: "speak.body 中出现 DSML 序列化锚点（全角竖线定界 / dsml_ 前缀），且锚点在 Markdown 代码节点（块级围栏/行内代码）之外（顶层）、锚点前紧邻思维闭合标签（仅空白分隔）时，从锚点前截断并把思维闭合标签一并清掉，只把正文落账；其余情况（无锚点、锚点在代码节点内——如完整事故回放示例、锚点前无思维闭合标签——如正文裸写序列化字节后仍续正文）逐字节不变不误剥；剥离发生时记 warn 日志可观测。"
  verify_by:
    type: behavior_check
    note: "tests/interface-adapters/tool-helpers.test.ts 新增 12 用例：全角现场字节、半角下划线锚点 + 思维闭合标签、issue #1916 转写原形态（英文 response 单词 fail-open）、围栏内完整事故回放不误剥、行内代码内完整事故回放不误剥、裸标签不误剥、围栏内 DSML 示例不误剥（全角/半角）、句号后接 DSML 再续正文不误剥、无泄漏不误剥、剥空兜底、正文提 invoke 一词不误剥。修复前旧管线泄漏直落（事故 entry 335 hexdump 机器锚点），修复后 strip 对真实字节回放通过 + 50 passed。"
capability_test: "tests/interface-adapters/tool-helpers.test.ts 新增 12 用例（修复后 50 passed）；npm run check 全绿。改动是 speak 工具实现的防御逻辑，不新增 prompt/工具/协议指令，无 golden gate 场景。"
---

# speak 入口工具调用序列化泄漏剥离（F20261118dsmlk）

> **定位与查重**：2026-11-18 建档前 `grep -rl '序列化泄漏|dsmlk|speak-leak'` 在
> `docs/features/` + `docs/research/` 无同主题命中，新建文档。本改动是 #1916（P0）
> 的防御性修复，不改变既有 speak 校验（F20260804hcob / F20260915hcel）的语义。

## 问题（现场）

2026-11-18 09:26，对话 chen（搭档）与大獭的协作会话。大獭 `speak` 的 body 末尾把第二个
工具调用（yield）的原始序列化文本写进了发言正文，搭档在聊天界面直接看到乱码，随后当场
要求提 P0 issue 记录现场（#1916）。

## 根因（已核实）

**不是解析层切分错误，是模型把第二个调用生成进了第一个调用的参数。**

证据链（`data/durable-sessions/30288072-8ffb-481b-89b3-ae9271327331.sqlite`）：

| entry | 内容 | 说明 |
|---|---|---|
| 333 | `kind=pi.assistant`，`api=openai-completions`，`provider=apig-deepseek-v4-pro`，单 toolCall `speak` | `arguments.body` 末尾即泄漏字节（hexdump 见下） |
| 335 | `kind=pi.tool-result`，`toolName=speak` | `details.body` 同源污染——**落账的就是被污染的 body** |
| 337 | assistant thinking | 模型自述「I accidentally put DSML tags inside the tool call output text」 |
| 339 | `toolName=yield` 正常落账 | 真正的 yield 在 seq 63 正常，乱码是「多出的那一次」序列化 |
| 340 | `kind=pi.user` | 搭档引述乱码并要求提 P0 |

案发 speak `arguments.body` 末尾字节（hexdump 尾段，关键部分）：

```
…你据此把 P2 的触发写死。 3c2f 7468 696e 6b3e     → 句号 + </think>（思维闭合标签）
0a0a                                              → 两个换行
3c efbd9c 44534d4c efbd9c 746f6f6c5f63616c6c73 3e → 左尖 + 全角竖线 DSML 全角竖线 tool_calls
3c efbd9c 44534d4c efbd9c 696e766f6b65206e616d653d22 7969656c6422 3e → 全角竖线 invoke name="yield"
3c efbd9c 44534d4c efbd9c 706172616d65746572206e616d653d22 726561736f6e22 … → 全角竖线 parameter name="reason"
```

关键指纹：`ef bd 9c` = U+FF5C 全角竖线。泄漏定界符是**全角竖线包裹的大写 DSML 标记**
（`<｜DSML｜tool_calls` 等），不是 issue 转写里的半角下划线 `<dsml_calls>` 形式。
issue #1916 转写有两处出入：把全角竖线写成了半角下划线（修复已覆盖半角小写变体，防不同
模型输出形态）；把思维闭合标签 `</think>` 写成了英文单词 “response”（转写失真，不是可靠
指纹——合法正文句末也会出现英文 response，该形态 fail-open 不剥，权威字节以 entry 333 为准）。

模型在 `openai-completions` 路径下本应走结构化 `tool_calls` delta 输出工具调用，却在
连续调用时把第二个调用「读」回了第一个调用的参数文本。这是模型/provider 生成行为，
应用层无法根治，只能防御净化。

## 方案（修法决策树① narrow-fix）

**修法决策树**：① 在既有机制语义内修（缺啥补啥）——既有 speak body 校验机制
（`validateSpeakBody`，F20260804hcob / F20260915hcel）缺「工具调用序列化泄漏」这一判据，
在唯一入库口补上。不新增机制。

**机制识别检查点**（动手前逐项）：新增配置字段/枚举/开关 ✗、新增状态生命周期 ✗、
新增定时任务/后台进程 ✗、新增信号类型/消息格式 ✗、新增持久化存储 ✗、新增决策分支
（结果被记住并影响后续）✗、新增跨模块调用路径 ✗——**全部未命中**，默认走 ①②③，确认
narrow-fix，无需重对抗门。

实现（两个改动点）：

1. `tool-helpers.ts` 新增 `stripToolCallSerializationLeak(body)`：
   - 锚点正则 `TOOL_CALL_SERIALIZATION_RE` 覆盖两种前缀形态（`i` 不计大小写）——
     - 全角竖线定界（事故现场字节）：`<｜DSML｜tool_calls`、`<｜DSML｜invoke`、`<｜DSML｜parameter`（左尖 + 全角 + 大写 DSML + 全角 + 标签名）
     - 半角下划线（issue 转写）：`<dsml_calls>`、`<dsml_invoke>`、`<dsml_parameter>`（小写）
   - **截断需同时满足两个独立条件**：
     1. **代码节点感知**：锚点必须落在 Markdown 代码节点（块级围栏 code + 行内代码 inlineCode）之外（顶层）。代码节点内的 DSML 是「讨论本 bug 的合法示例回放」（含完整事故字节），一律不剥——「代码节点内示例」与「顶层真实泄漏」的唯一可靠分界：真实泄漏是顶层裸序列化字节，合法示例必然包在代码节点里（检视 delta3 发现围栏、delta4 补行内代码）。
     2. **思维闭合标签指纹**：锚点前必须紧邻思维闭合标签（仅空白分隔）。这是泄漏的强指纹——模型失手时把 thinking 闭合标签也带进了 body（entry 333 实测字节有）。**句末标点不作为判据**：讨论本 bug 时正文会裸写序列化字节再续正文，以句号判据会误剥吞掉后续（检视 delta 发现）。
   - **不收裸 invoke / parameter 标签**：裸标签可能是正文里合法的代码示例（Markdown 代码节点内），收进来会静默截断（检视发现）。
2. `tool-factory.ts` 的 `createSpeakTool.execute`：
   - `rawBody` → strip → `cleanBody`；`leaked` 时 `logger.warn` 留痕。
   - 剥离后若为空，由既有 `validateSpeakBody` 空 body 检查兜底拒绝。

**为什么剥离而非拒绝**：连续 speak+yield 场景下，拒绝会让模型重试并再次踩同一输出形态
（发言正文已完整，问题只在尾部多出序列化）。截断保留正文即可正常落账，不打断流程。

**为什么漏剥优于误剥（fail-open）**：漏剥只是泄漏继续出现（回到现状，可再修）；误剥会
静默删除正常发言的正文。在模型输出形态未知漂移的情况下，宁可少剥不可错剥。

### 与历史脉络的关系（背景探索）

历史上有过同类「body 末尾乱码」链（#1800/#1828/#1851 → F20261113hlprm）：healing 标签原先被
设计成 LLM 在 body 里手写结构化数据，chen 拍板「设计本身错误，直接改独立参数，不保留 body
内嵌兜底」。本改动**不重蹈该覆辙**，也不与它冲突：

- 历史案例是「设计引导 LLM 手写结构化数据」——根因在设计，解法是改独立参数；
- 本案例是「yield 本来就是独立工具，模型在连续调用时却把它的序列化文本写进了另一个工具的参数」——根因在模型生成错误，不是设计引导；没有「独立参数」可改（yield 已是独立工具），speak 入口防御剥离是唯一可行的应用层收敛点。

## Verification

### 失败用例证据（bugfix）

- **修复前现象（旧行为真实现场，机器锚点）**：事故现场 entry 335 落账 `details.body` 尾
  部 hexdump 含 `ef bd 9c`（U+FF5C 全角竖线）定界的 DSML 序列化——旧管线 `cleanBody = rawBody`
  原样直落，泄漏标签进入搭档消息流（这正是 #1916 要修的 bug，不是「函数不存在」的 import 错误）。
- **修复后对照（真实字节回放）**：从 entry 333 提取完整 1214 字节 body 喂给修复后的
  `stripToolCallSerializationLeak`，node 回放输出：`matched at 1065, matched text=<｜DSML｜tool_calls`，
  `stripped` 尾部 = `…你定个倾向，我据此把 P2 的触发写死。`，无序列化标记残留。
- **永久回归单测**：新增用例「全角变体（真实事故字节）」用与 entry 333 相同的字节形态
  断言剥离后只剩正文；「半角下划线锚点 + 思维闭合标签」用例覆盖半角分隔变体；另加
  「围栏内完整事故回放（含思维闭合标签 + DSML）不误剥」「行内代码内完整事故回放不误剥」
  「issue #1916 转写原形态（英文 response 单词）fail-open」「裸 invoke 不误剥」「围栏内
  DSML 示例不误剥（全角/半角）」「句号后接 DSML 再续正文不误剥」反例防合法正文被截断。
  修复后 50 passed。

### 验收断言

| 场景 | 操作 | 预期结果 |
|---|---|---|
| 全角竖线定界泄漏（事故现场字节，思维闭合标签前缀，顶层） | strip | leaked=true，body=正文，无思维闭合标签残留 |
| 半角下划线锚点 + 思维闭合标签（半角分隔变体，顶层） | strip | leaked=true，body=正文 |
| 围栏内完整事故回放（含思维闭合标签 + DSML） | strip | leaked=false，不误剥（闭合围栏与后续正文保留） |
| 行内代码内完整事故回放（含思维闭合标签 + DSML） | strip | leaked=false，不误剥（闭合反引号与后续正文保留） |
| issue #1916 转写原形态（句号 + 英文 response 单词 + 半角 dsml_） | strip | leaked=false，fail-open（转写失真非可靠指纹） |
| 无泄漏正文 | strip（正常发言） | leaked=false，逐字节不变 |
| 整段都是泄漏（思维闭合标签 + DSML，无正文，顶层） | strip | body 为空串，由 validateSpeakBody 空检兜底拒绝 |
| 裸 invoke/parameter 标签（无 DSML 前缀） | strip | leaked=false，不误剥（合法代码示例防截断） |
| 代码节点内 DSML 序列化示例（围栏/行内，全角/半角，无思维闭合标签） | strip | leaked=false，不误剥（示例后正文保留） |
| 句号后接 DSML 示例再续正文 | strip | leaked=false，不误剥（后续正文保留） |
| 正文提及 invoke 一词（无标签语法） | strip | leaked=false，不误剥 |

### 自检

- `npx tsc --noEmit` 通过；`npx eslint`（改动三文件）通过；`npx vitest run
  tests/interface-adapters/tool-helpers.test.ts` 50 passed。
- 最简实现检查：已过——复用既有 `validateSpeakBody` 所在的 tool-helpers 模块，新增一个
  纯函数 + 一个调用点，无新依赖、无新文件（测试除外）。
- 影响面：只动 speak 入库前处理，yield / 其他工具不变；正常发言（无锚点或锚点前无思维
  闭合标签）行为零变化。

## Notes

- 检视獭-1925 提醒：open PR #1830（F20261110grdls 能力护栏）同触 `tool-factory.ts`。本
  PR 只改 `createSpeakTool.execute` 的 body 预处理两行 + import 一行，改动面小；与 #1830
  合入时若冲突，按时间序先合入者为准，后合者 rebase 解决（通道不一致时升级搭档裁决）。
