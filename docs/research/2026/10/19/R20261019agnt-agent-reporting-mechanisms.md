---
id: R20261019agnt
title: 业界 agent 汇报机制调研——Claude / Codex / Dots / Muse 四家的信息披露与完成判定设计
summary: 搭档 10/16 反馈「獭做完 PR 汇报时不说残留后续，合入后收尾才说」——本文调研四家业界主流 agent（Claude Code/Cowork、OpenAI Codex、OpenAI Dots、Meta Muse Code）向用户汇报时的内容要素与呈现原则，收敛出六条共同范式（分层披露/数字不可虚报/行动召唤显著/进度结构化/可追溯/状态分类），并推回本项目的「汇报六要素」规范修订（5 条），支撑 F20261019sixf。
exploration_type: technical
created_in_conversation: 8a076a50-19b5-49fc-91a1-dcdc1cd5d38b
created_at: 2026-10-19
tags: [agent-reporting, briefing, ux, claude-code, codex, dots, muse, industry-research]
---

# 业界 agent 汇报机制调研（R20261019agnt）

## 1. 调研背景与边界

### 1.1 背景

搭档 2026-10-16 反馈（原话，本对话消息）：

> 「我最近遇到一个情况，那就是，你们海獭做完 pr 向我汇报时，没有说 还残留什么后续、把什么东西排在了后续。然后每次都是我合入之后，你收尾时才跟我说 还有啥啥后续。我觉得这一点必须优化下，汇报时就要说清楚 背景/方案/关键决策/当前情况/后续等等这些，快速让我知道这是个什么事情，然后要我干什么，关键信息都要让我快速看懂」

随后要求：

> 「你结合 claude/codex/dots/muse 这些 agent，在这种 agent 向用户汇报时需要提供什么内容、以什么原则/方式来描述。先深入分析这些业界主流产品，然后回头来看咱们的优化方案」

现行案例实锤：PR #864 合入后收尾时才提「衍生的 #867 是 OPEN 待办，保留」——这个尾巴在呈终审时搭档根本不知道（本对话 10/16 消息）。这正是本调研要根治的「信息在收尾时刻才释放」模式。

### 1.2 调研边界（诚实声明）

**搜索引擎全部不可用**（Google/DuckDuckGo/Bing 302 / 百度验证码），本次调研路径为：官方文档直抓 + GitHub API + npm registry + 记忆沉淀。非官方文档来源的部分在正文中逐条标注，不冒充核验过的证据。

各证据源置信度分级：

| 产品 | 证据来源 | 置信度 |
|---|---|---|
| Claude（Claude Code / Claude Cowork） | docs.anthropic.com 官方文档锚点 + 训练知识 | 高（文档锚点）；Plan mode / AskUserQuestion 为训练知识，**未交叉验证** |
| Codex（OpenAI Codex） | 记忆条目 F20260807eval（此前「特性可评估性机制」研究的启发源沉淀）+ 训练知识 | 中高（记忆条目可回溯）；AGENTS.md / completion summary / PR 模板为训练知识，**未交叉验证** |
| Dots（OpenAI Dots） | 官方文档不可达；证据来自开源复刻品 github.com/Anil-matcha/open-dots 的行为面 | 中（复刻品 README 自证谱系，非官方一手来源） |
| Muse（Meta Muse / Muse Code） | meta-models.github.io/muse-code-sdk/1.4 官方开发者文档协议原文 | 高 |

补充说明：open-dots README 自述为「open-source, self-hosted alternative for people exploring paid AI agent products such as OpenAI Dots, Meta Muse, Grok Bot, Instinct, Manus Cue, Claude Cowork, and ChatGPT agent」——该列表同时反向确认了本调研所覆盖的产品谱系（四家全部在列）。

## 2. Claude（Claude Code / Claude Cowork）

### 2.1 机制

证据锚点：docs.anthropic.com/en/docs/claude-code/settings（v2.1.29+）。

- **TL;DR 摘要协议**：长回复末尾、工具调用前、Bash 命令前自动生成 TL;DR 摘要；行为可用 `/output-style` 定制。摘要不是装饰——是协议层约定「长内容必须收敛出一句话读法」。
- **默认折叠细节**：subagent 与工具输出默认从主转录隐藏（减少 context 占用），⌃O 切 verbose 看全程；详略程度可通过 `/output-style` 调节。转录默认态是「摘要可见、细节可展开」。
- **行动召唤推送**：权限请求、prompt 闲置 60s+ 时主动发桌面通知——「要你干什么」这件事有专门的推送通道，不可能被淹没在信息流里。
- **可回溯修订**：rewind + 重发编辑历史消息——汇报是可修订的转录，不是一次性快照。
- Plan mode（训练知识，未交叉验证）：先出计划、ExitPlanMode 请求批准后执行。
- AskUserQuestion（训练知识，未交叉验证）：结构化选项提问，用户从固定选项中选而非自由文本作答。

### 2.2 汇报原则

**分层披露（TL;DR → verbose）+ 需要行动必通知 + 方案先行**。

对汇报设计的直接启示：摘要与细节不是「详略」问题而是「协议」问题——摘要位置（末尾/开头复述）、默认态（折叠细节）、行动召唤（独立推送通道）都是机制层约定，不依赖模型自觉。

## 3. Codex（OpenAI Codex）

### 3.1 机制

证据锚点：记忆条目 F20260807eval（此前特性可评估性机制研究的启发源沉淀，可回溯）。

- **goal 模式 Completion Audit**：从目标推导具体需求 → 为每个需求找权威证据 → 检查当前状态的实际来源 → 判定证据质量，五档终态：证明完成 / 矛盾 / 未完成 / 证据不足 / 缺失。
- **不确定的证据 = 未达成**——不声称、只举证。完成不是模型说了算，是证据链说了算。
- **用户不参与验收**：用户只提出问题、拍板决策、合入后使用——验收是 agent 侧用证据自己完成的，不把验收负担转嫁给用户。

补充（训练知识，标注未交叉验证）：AGENTS.md 项目约定固化；completion summary 汇报改了什么文件、跑了什么测试；PR 描述模板化。

### 3.2 汇报原则

**证据驱动的完成判定（不声称、只举证）+ 目标对照**。

对汇报设计的直接启示：汇报里的「完成」必须能回答「凭什么说完成」——这正是本项目 A1 证据锚点纪律的同构设计。「自检完成」和「已验证完成」不是修辞差异，是证据等级差异，汇报时必须分开。

## 4. Dots（OpenAI Dots）

### 4.1 机制

证据锚点：github.com/Anil-matcha/open-dots README（置信度：中——复刻品行为面，非官方文档）。

- **风险动作审批前置**：「Ask for approval before risky actions such as file writes, shell commands, and Git pushes」——permission hook 决策，且不 hang 死，必须给出决定。
- **结果主动推送**：「Schedule recurring prompts and receive run results in Telegram」——定时任务结果直接推到 IM，不要求用户守着终端。
- **任务可续接**：「Continue completed tasks in the same Claude conversation from the web UI」——任务完成后不是断头路，可从任意端续接。
- 沙箱隔离执行（disposable sandboxes）。

### 4.2 汇报原则

**审批前置 + 结果推送 IM + 任务可续接**（置信度：中——复刻品行为面推断官方产品意图，非官方文档实证）。

对汇报设计的直接启示：「要你干什么」要在动作发生前说清（审批前置），任务尾巴（续接、后续）是产品功能而非可选项。

## 5. Muse（Meta Muse / Muse Code）

### 5.1 机制

证据锚点：meta-models.github.io/muse-code-sdk/1.4（MSP = Muse Session Protocol，官方开发者文档）。

- **Item fold model**：汇报 = 事件流折叠。item/started → item/delta → item/updated → item/completed 的流式事件必须收敛到终态对象——官方小节标题原句「Deltas accumulate; the committed object is the truth」（fold-model 页）；客户端按 replace-iff-higher-revision 幂等折叠。流式输出再多，落账的是终态对象。
- **PatchSummary 服务端计算**：「Server-authored edit-family diff summary: files counts the stored patch document's file entries; added and removed are the total +/- prefixed LINE counts summed over the stored patch's hunks across all files — line counts, never hunk or byte counts」——改动数字由服务端统计，口径锁死（行数，永不按 hunk 或字节计），模型不能虚报。
- **recap/request「while you were away」recap**：协议级一等公民方法——用户回场时请求离场期间的会况汇报（one in flight per session，host-enforced 45s timeout）。离场回顾不是客户端花活，是会话协议的一部分。
- **结构化进度**：StatusStep（index/label/total——第几步/共几步）、StatusProgress、StatusHealth / StatusHealthLevel、Goal（set/edit/pause/resume/clear）、TodoItem / TodoListState / TodoStatus（session/todoListChanged 广播）——进度不是散文，是有 schema 的对象。
- **结构化提问**：userInput/question、userInput/clarify（UserInputQuestion / UserInputOption / UserInputSelectionMode）。
- **ItemKind 分类**（11+ 种）：userMessage / agentMessage / reasoning / toolCall / userShell / subagent / workflow / reminderChild / compaction / hookRun / sideChat / webSearch / monitorFeed / skillRead——汇报内容有类型系统，不是自由文本。
- 其他：subagent/readResult（SubagentResult）、turn/foregroundCompleted（前台/后台 turn 区分）、session/contextUsage（用量透明）。

### 5.2 汇报原则

**事实对象化（数字服务端算）+ 离场回顾（recap）+ 流式收敛终态 + 目标显式**。

对汇报设计的直接启示：这是四家中对汇报协议化最彻底的一家——汇报内容的每个部件（进度、健康度、目标、todo、diff 数字）都有独立 schema，离场回顾有协议级方法与超时预算。本项目「当前情况数字带来源」「离场回顾三段式」直接受其启发。

## 6. 共同范式（跨四家收敛）

四家产品形态各异（CLI 编码助手 / 目标驱动 agent / 自托管 agent 平台 / 会话协议），但向用户汇报这件事收敛出六条共同范式：

| # | 范式 | 证据分布 |
|---|---|---|
| 1 | **分层披露**：摘要在前、细节按需展开 | Claude TL;DR / verbose 折叠；Muse item fold（流式收敛终态） |
| 2 | **数字与事实不可虚报**：关键数字由系统生成或核对 | Muse PatchSummary 服务端统计；Codex 证据分级（不确定的证据 = 未达成） |
| 3 | **「要你干什么」必须显著**：审批/权限请求主动推送 | Dots approval（risky actions 前置审批）；Claude notification（权限请求桌面通知） |
| 4 | **进度结构化**：todo / steps / goal 显式可见 | 四家全有：Claude Plan mode（训练知识）、Codex goal 模式、Dots 续接、Muse StatusStep/Goal/TodoItem |
| 5 | **可追溯**：一切从日志/转录折叠 | Muse「The log is the session」+「Deltas accumulate; the committed object is the truth」（fold-model 页两条小节标题）；Claude rewind 可回溯修订 |
| 6 | **状态分类清晰**：汇报内容有类型系统 | Muse ItemKind（11+ 种）+ StatusHealthLevel；Codex 证据质量五档终态 |

值得强调的一条观察：四家没有一家把「汇报」当成模型的自由作文——汇报的内容要素、数字口径、推送时机、离场补课，全部是**机制层约定**。这为本项目的方向（把六要素写进 prompt 规范 + 模板自检清单）提供了业界佐证：光靠「说清楚点」的嘱咐不解决结构问题，要在协议层定形。

## 7. 对汇报规范设计的启示（推回本项目）

从六条共同范式推回，形成 5 条修订点（已落地为 F20261019sixf 的规范改动）：

| # | 修订点 | 业界依据 |
|---|---|---|
| 1 | **数字必须带来源**：「当前情况」里的 CI/测试数/文件数/发现数一律来自工具返回 | Muse PatchSummary（服务端算，模型不能虚报）；与本项目 A1 证据锚点纪律同构 |
| 2 | **后续事项分流**：「需要你介入的」vs「不需要你介入的（獭排期自盯）」分开列；「要你干什么」单独成行 | Dots approval / Claude notification（行动召唤必须显著，不被信息流淹没） |
| 3 | **补「离场回顾」场景**：长任务/定时任务/小獭回报按「while you were away」三段式 | Muse recap/request（协议级离场回顾，45s 超时预算） |
| 4 | **完成状态分级**：已验证完成（附锚点）/ 自检完成 / 未验证 | Codex Completion Audit（不确定的证据 = 未达成，不许把没验证写成完成） |
| 5 | **长汇报末尾复述结论**：≥500 字汇报在结尾复述 3 秒层要点 | Claude TL;DR 协议（摘要放长回复末尾——扫首尾即得全貌） |

### 遗留说明

- 本调研的 Dots 部分基于开源复刻品行为面（置信度：中），若后续官方文档可达，建议补一手核验。
- Claude 的 Plan mode / AskUserQuestion、Codex 的 AGENTS.md / completion summary 为训练知识（未交叉验证），仅作背景理解，不作为修订点的独立支撑证据——5 条修订点的每一条都另有高/中高置信度来源支撑（见上表「业界依据」列）。
- 本文档由 glm 模型（文档獭）执笔，业界机制的取舍判断受训练分布影响；事实性内容全部锚定在上述标注来源，锚点之外的判断按 R6 标注置信度。
