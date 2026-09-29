---
id: F20260929kws1
title: 保留段简化——只保留最近 4 条 speak，单条超阈值截断
summary: 换世保留段从「token 预算估算切片」（chars/4 估算 + 密度告警只喊不拦）改为搭档拍板的极简形态「只保留最近 4 条 speak，单条超阈值截断」。token 弹性初衷不坏但已反复出错（9/28 三倍超预算 #1183、9/29 保留段 12.4 万字符致 kimi-256k 换世爆窗）；turn 切片中间形态经实测否定（turn 体量方差太大，10 turn 截后仍 11 万字符）。
change_type: fix
capability_test: "n/a——换世注入体量由切片层测试断言（fix 类，失败证据链见 Verification）"
created_in_conversation: efcdddae-6817-4153-addc-7c242c5fc953
intent:
  problem: "保留段切片用 chars/4 估算 token 预算，中文密集期低估 4 倍（生产实测 keptChars=124,596 / budget=25,000，ratio 4.98），密度告警只喊不拦——9/29《issue处理》大獭换世到 kimi-256k 首请求 126,965 字符直接 400 爆窗。截断器只拦 user 消息的陈旧回放节，对 speak/assistant 正常消息不设防。同一领域一年内三度返工（hndf→keep→本次）。"
  why_now: "搭档 2026-09-29 原话（两道指令，后者为最终拍板形态）：「这个预算弹性初衷也不错，但现在出错了，反复出错，我很烦，所以，如果你做不好，那就不要设计一大堆复杂的逻辑。按照不会出错的逻辑来做，而且效果也没差。你本次一次性给我做完整做好」「哎，你这保留段我真的是服了，你这样子，只保留最近4条speak、然后如果每一条speak都超过一个大小就截断speak的内容！」"
  expected_effect: "保留段 = 最近 4 条 speak × 单条截断 1500 = 数学硬顶约 6,300 字符（≈5K token，64K 窗口的 8%；speak 剥离 thinking/toolCall 块后的纯 text），任何模型换世不再可能因保留段爆窗；体量与 turn 大小/工具调用密度/文本语言全部解耦。估算器/密度告警/换算层/turn 切片全部退役。"
  verify_by:
    type: static_only
    reason: "切片逻辑纯函数，条数/截断/体量均可静态断言；端到端爆窗复现依赖特定模型+大对话，留 alpha 冒烟。"
causal_links:
  - F20260825hndf  # 保留段出生（四件套件③）
  - F20260928keep  # 密度校准补丁（本次推翻其估算路线）
  - F20260929czi0  # 同日姊妹修复（游标零点），共同构成「注入面瘦身」世界观
supersedes: [F20260928keep]
tags: [context, handoff, session-slicer]
modules: [agent]
created_at: 2026-09-29
---

# 保留段简化：最近 4 条 speak

## 背景

搭档原话（意图锚，2026-09-29 本对话）：

> 「我还是没懂，咱们做压缩/重启，为什么还有这么多个器，又是估算/压缩/截断/切片的，都是在干嘛？……为什么不能是最近两三条消息？然后如果这几条消息太多再来截断下？」
> 「这个预算弹性初衷也不错，但现在出错了，反复出错，我很烦，所以，如果你做不好，那就不要设计一大堆复杂的逻辑。按照不会出错的逻辑来做，而且效果也没差。你本次一次性给我做完整做好」
> 「哎，你这保留段我真的是服了，你这样子，只保留最近4条speak、然后如果每一条speak都超过一个大小就截断speak的内容！」

事故链（全部实测，锚点在本对话 14:43 解剖段与 F20260929czi0 排查段）：

- 9/28 #1183：保留段 3 倍超预算 → 打补丁（预算线性换算 + 密度告警）
- 9/29 14:13：《issue处理》大獭换世 kimi-256k 首请求 126,965 字符 400 爆窗——解剖：真未读仅 265 字符（czi0 修复生效），**保留段 123,835 字符 / 317 块**（日志 `[keeprecent-slice] ratio 4.98`，密度告警 2.11 出界但只喊不拦）

## 目标

T1: 保留段 = **最近 4 条 speak**（assistant text 消息），单条超 1500 字符截断——体量数学硬顶 ≈6,300 字符
T2: 退役估算链路：`DEFAULT_KEEP_RECENT_TOKENS` / `OTTER_CHARS_PER_TOKEN` / `measureTailDensity` / 密度告警 / findCutPoint 调用 全部删除
T3: 截断复用现有格式（头 750 + 截断标记指向 jsonl 原文、文件名见档案谱系节 + 尾 750）
T4: 导出签名兼容（platforms.ts / agent-invoker.ts 调用方零改动）

## 非目标

- 不改 LLM 叙事合成器与文件轨迹/状态盘点（它们体量健康，实测合计 ~3.5K）
- 不改 SDK（node_modules 不动）——只是不再调用 findCutPoint
- 不改 compaction（session 内压缩）路径
- 不动 jsonl 源文件——截断只发生在序列化注入文本，原文永存可追溯
- 不保留 turn/总量硬顶等兜底概念——条数×单条上限本身已是封闭数学上限（见设计取舍）

## 未决问题

无。

## 方案设计

### 核心算法（替换 sliceSessionEntries 的切片段）

```
常量：KEEP_SPEAK_COUNT = 4        # 最近 4 条 assistant 发言（speak 本体）
      SPEAK_TRUNCATE_CHARS = 1500 # 单条截断阈值（沿用 REPLAY_TRUNCATE_THRESHOLD）
      SPEAK_KEEP_HEAD/TAIL = 750/750  # 截断保留头尾（沿用现有 REPLAY_KEEP_HEAD/TAIL）

1. 从 entries 末尾倒序找「role=assistant 且含非空 text 块」的消息
   （= 獭的 speak 本体，与 entries 表 speak entry 同体），凑满 4 条或耗尽即停
2. 每条消息的多个 text 块拼接后计总长，超 1500 字符 → 头 750 +
   「…（截断 N chars；原文见前世 session jsonl，文件名见档案谱系节）」+ 尾 750
3. **重构造为纯 text 消息再序列化**：剥掉 thinking / toolCall / 其余一切块类型，
   每条消息只保留截断后的 text——serializeConversation 的 assistant 分支会无截断带出
   thinking 全文与 toolCall 参数 JSON（检视 S1 实测：thinking 2,485 + 参数 4,346，
   含单次 write args 2,753，日常形态即破顶），只截 text 不剥块的「硬顶」是假的。
   thinking 是过程、toolCall 参数全文在 jsonl——保留段只要「说了什么」
```

数学硬顶：4 × (1500 + 截断标记约 60) ≈ 6,300 字符 ≈ 5K token——64K 窗口的 8%，
**剥离非 text 块后结构性不可能爆窗**。跨 40 个生产 session 实测（9/25-29）：最近 4 条
speak 的 text 截后体量最大 4,547 字符、典型 <1K（该统计口径为纯 text，与剥离后的
真实注入量同口径）。

### 中间形态留痕：为什么不是「最近 N 个 turn」

本特性第一版方案是 turn 切片——搭档质疑 N=10 太多，拿事故 session（19 turn）实测：

| N | 截断策略 | 截后体量 | 判定 |
|---|---|---|---|
| 10 turn | 全 1500 | 113,576 字符 ≈ 9 万 token | ❌ 罪魁：一个干活 turn 含 81 条 toolResult |
| 5 turn | 同上 | 38,280 字符 | ❌ |
| 3 turn | toolResult 截 300 + 其余 1500 | 3,059 字符 | ✅ 但需分级截断+硬顶两道补丁才安全 |

turn 体量方差太大（摸鱼 turn 2 条 entry vs 干活 turn 163 条），条数本身不是安全刻度，复杂度又回来了。搭档随后给出更简形态「只留 4 条 speak」——speak 是獭的产出面，天然不含 toolResult 碎屑与注入包，条数即安全刻度。此中间形态全程留痕，供未来检索「为什么不按 turn 切」。

### 退役清单（删除即正义）

| 退役物 | 位置 | 替代 |
|---|---|---|
| DEFAULT_KEEP_RECENT_TOKENS=20000 | session-slicer.ts:29 | KEEP_SPEAK_COUNT=4 |
| OTTER_CHARS_PER_TOKEN=1.25 + 预算换算 | session-slicer.ts:41-46, 92-95 | 无（不估算） |
| measureTailDensity + recordDensityObservation + 密度告警 | session-slicer.ts:210-250 区域 | 无（密度不再影响行为） |
| findCutPoint / findValidCutPoints 调用（SDK） | session-slicer.ts:95 | 自实现约 10 行「倒序找 4 条 assistant text」 |
| applyReplayTruncation 的 user+节头双重限定 | session-slicer.ts:311-330 | 单条 speak 截断（截断格式复用） |

保留不动：`sliceSessionEntries` / `serializeKeptWindow` 导出签名兼容；jsonl 原文永存；档案四件套其余三件。

### JsonlSlice 契约定义（检视 S2：新算法消灭 cutPoint 概念后四字段语义必须显式）

新算法「倒序找 4 条」不再产生预算切点，JsonlSlice 七字段语义重新定义：

| 字段 | 新语义 | 理由 |
|---|---|---|
| keptEntries | 最近 4 条 speak 消息（重构造后） | 本特性主产物 |
| messagesToSummarize | **第 4 条 speak 之前的全部消息** | 叙事合成原料——切点从「预算点」变为「第 4 条 speak」，原料反而更完整；保证 synthesizePast=true 时 LLM 叙事合成照常触发（agent-invoker.ts:1030 触发条件依赖此字段非空），与「非目标：不改叙事合成器」自洽 |
| turnPrefixMessages | 恒空数组 | cutPoint 概念退役，无「切点所在 turn 的前缀」 |
| isSplitTurn | 恒 false | 同上，不切 turn 就不存在切半轮 |
| tokensBefore | 保留观测用途（序列化前全量估算） | 调用方日志/观测沿用 |
| previousSummary / boundaryStart | 语义不变 | 谱系继承种子，与本特性无关 |

影响范围同步声明：**叙事合成原料切点从预算点变为第 4 条 speak**——合成质量预期持平或更好（原料更多），属有意行为变化。

## 影响范围

- **换世档案保留段**：体量从「0~12.4 万字符不可预测」变为「≤6.3K 字符数学硬顶」
- **行为变化**：保留内容从「最近若干 turn 的全部消息（含注入包/toolResult/assistant 碎片）」收窄为「最近 4 条 speak 的纯 text」——搭档消息/系统提示/toolResult/**thinking/toolCall 参数**均不进保留段（后两者由检视 S1 实证为日常破顶源）。「## 对话历史」回放节截断随之整体退役：回放节只出现在 user 注入包里，新算法不切 user 消息，**嵌套回放膨胀路径从根上消失**
- **兜底不受影响**：搭档指令原话由档案四件套的「搭档指令原话」节独立承载（agent-invoker.ts 注入）；更早上下文由叙事摘要 + search_messages 兜底
- **观测变化**：`[keeprecent-slice]` 日志字段改为 keptSpeaks/keptChars；密度告警消失（机制退役）
- **档案谱系节**：补旧世 session 文件名（截断标记「原文见前世 session jsonl」的路径锚，检视 A1——新世獭 read/bash 可直接定位原文）
- **叙事合成原料**：切点从预算点变为第 4 条 speak，原料更完整，合成照常触发（契约定义见方案设计节）

## 风险与约束

- **风险：剥离 thinking 丢失「最后那条没说完的思考」**——thinking 是过程不是产出，结论在 speak 的 text 里；jsonl 原文永存可考
- **风险：剥离 toolCall 参数丢失「刚才写了什么文件的内容」**——speak 的 text 会陈述动作（「已写入 X」），参数全文检索可补；保留段语义本就是「提示有这回事」而非「完整证据」
- **风险：看不到「搭档最后那句原话」的情绪/语气**——指令内容由「搭档指令原话」节承载，语气损失接受
- **风险：最后一轮全是工具调用没发言时，4 条 speak 跨度拉长**——可接受：speak 是「有话说的时刻」，稀疏期跨度拉长恰符合「保留有意义的原文」语义
- **约束**：不引入新配置项——两个常量硬编码在 session-slicer.ts 顶部，注释写明「要改先改文档」

## 不兼容更新

无对外不兼容（注入面内部行为）。保留段体量变小是可预期的修复效果。

## 设计取舍

| 取舍 | 决策 | 替代方案 | 理由 |
|---|---|---|---|
| 保留对象 | 最近 4 条 speak 的纯 text（剥离 thinking/toolCall） | ①token 预算切片（现状）②最近 N 个 turn ③保留 thinking/toolCall 块 | ①三度出错，估算不可信是结构性问题；②实测否定（turn 方差太大，见中间形态表）；③检视 S1 实证日常形态即破顶（thinking 2,485+参数 4,346），保留它们则硬顶为假——speak 语义 =「说了什么」，过程与参数归 jsonl |
| 单条截断阈值 | 1500 字符，头/尾 750/750（沿用 REPLAY_TRUNCATE_THRESHOLD/HEAD/TAIL 现有三常量） | 分级截断 / 新格式 800/400 | 只有一种东西要截，就只需要一套数；沿用现有常量零迁移成本（检视 A6 纠偏：初版写「头 800 尾 400」与现状 750/750 矛盾） |
| 多 text 块计长 | 拼接后计总长 | 逐块分别截 | 逐块截会放过「每块 1400×5 块」的累积形态（与 S1 同构的边界） |
| 总量硬顶 | 不要 | 保留 10K 字符硬顶兜底 | 4×1560 已是封闭数学上限（剥离非 text 块后成立），硬顶是冗余复杂度——「不要设计一大堆复杂的逻辑」 |
| 密度告警 | 退役删除 | 改为出界缩预算 | 「缩预算」还是估算思路；告警没有消费者就该死 |
| 机制识别检查点 | **净退役机制**（密度告警/估算换算/turn 切片三机制死亡，零新增——四问逐项：无新配置、无新状态、无新生命周期、无新调用路径；切片器内部算法替换不构成机制） | — | 净退役豁免重对抗，判定留痕供检视核对 |

## 验证

fix 类失败证据链：

1. **修复前失败证据**（已采集，本对话 14:43 解剖段）：14:13 爆窗 jsonl 解剖表（保留段 123,835/317 块）；日志 ratio 4.98；400 报错原文
2. **修复后用例**：
   - 切片：构造含 10 条 assistant text 的 entries → 只保留最近 4 条；不足 4 条 / 无 assistant text 场景不报错
   - 截断：单条 speak 5000 字符 → 截为 750+标记+750；1500 以下不动；**多 text 块拼接计长**（3 块 × 600 = 1800 → 截）
   - **混合块形态（S1 回归用例）**：4 条消息各含 text 1000 + thinking 3000 + toolCall args 5000 → 序列化结果不含 thinking/toolCall 内容，总量 ≤6,500 字符
   - 契约：messagesToSummarize = 第 4 条之前的全部消息（非空时叙事合成触发条件成立）；turnPrefixMessages 恒空；isSplitTurn 恒 false
   - 回归：含 toolResult/user 注入包的 entries 不进保留段；导出签名调用方编译通过
3. **端到端（alpha 冒烟）**：重启一只 kimi-256k 獭，新世首请求注入文本中保留段 ≤6.5K 字符
4. **PR Verification 节备好**：「Golden Gate: n/a（verify_by=static_only，无场景可跑）」（检视 A4）

## 改动范围

| 文件 | 操作 | 说明 |
|---|---|---|
| src/frameworks/agent/session-slicer.ts | M | 切片算法改为「最近 4 条 speak 纯 text + 单条截断」；退役估算/密度告警/findCutPoint/回放节截断；JsonlSlice 七字段新语义落地 |
| src/interface-adapters/agent-runtime/agent-invoker.ts | M | sliceSessionEntries 调用点签名适配（keepRecentTokens 参数退役）；档案谱系节补旧世 session 文件名（A1） |
| src/bootstrap/platforms.ts | M | 装配侧同步 |
| tests/frameworks/agent/session-slicer*.test.ts | M/A | 上述验证节用例（旧估算类断言重写） |
| tests/**/unified-handoff-engine.test.ts | M | import/断言 DEFAULT_KEEP_RECENT_TOKENS=20000——常量退役后必须同步（检视 A5，glob 外文件） |

## 实现记录（F20260929kws1，2026-09-29 实现獭-kws1 追加——只追加，不改已审定章节）

### 实现落点与方案偏差说明

| 方案条目 | 实现落点 | 偏差 |
|---|---|---|
| 切片算法「倒序找 4 条 assistant text」 | session-slicer.ts `sliceSessionEntries`（签名：`keepRecentTokens` 参数删除，`options` 进第二参） | 无偏差 |
| 重构造纯 text 消息 | `speakIndexes.map` 内 `{ ...entry, message: { ...message, content: [{type:'text', text}] } }`——entry 骨架（id/timestamp）保留 | 无偏差 |
| 单条截断 1500/750/750 | `truncateSpeakText`，格式复用旧回放节截断（头 750 + 「…（截断 N chars；原文见前世 session jsonl，文件路径附于保留段末尾）」 + 尾 750） | 标记文案比方案原文多了「文件路径附于保留段末尾」后半句——A1 路径锚的落点指示，语义增强非偏离 |
| JsonlSlice 七字段契约 | turnPrefixMessages 恒 `[]`、isSplitTurn 恒 `false`、messagesToSummarize=第 4 条 speak 前全部、tokensBefore 保留观测 | 无偏差 |
| 谱系节补旧世 session 文件名 | **落点修正**：不落在谱系节——`agent-invoker.ts` 在保留段序列化后追加一行 `（前世 session 文件：<绝对路径>）`，经 `recencyWindow` 参数进入叙事/机械两种档案 | 方案「档案谱系节补文件名」按字面无法落地：①机械档案（buildMechanicalArchive）没有谱系节，谱系信息在 `assembleHandoffArchive` §③ 且仅机械形态才渲染，注入点不收敛；②叙事档案谱系由 LLM 生成、genN 靠谱系行数推导，代码外挂文件名会破坏行数推导。**保留段末尾行**是两形态唯一必经渲染点。数据源：新增可选端口 `SdkInvokePort.getCurrentSessionFile`（PiSessionFactory 实现：池内 live session 取 `getSessionFile()`；池外查 agent_sessions 账本——交接收集期调用，此刻仍指向旧世文件，与 readCurrentSessionEntries 同一生命数据源）。why 注释见 agent-invoker.ts `appendSessionFileAnchor` |
| 观测日志 | `[keeprecent-slice] cut` 字段简化为 `total/keptSpeaks/keptChars/scopeKey`；密度告警整体删除 | 无偏差（scopeKey 字段名沿用旧名，语义为按獭归因） |
| 装配同步 | platforms.ts setSliceLogger 接线简化（warn 分支删除）；narrative-synthesis-engine.ts 保留段节标题「对齐 Pi keepRecent 20K」→「前世最近 4 条 speak，单条超长已截断」 | 无偏差 |

### 负面向验收条目（必答）：本次变更破坏了什么旧契约 / 绕过了什么既有保护

1. **密度告警退役**：OTTER_CHARS_PER_TOKEN 漂移从此无观测——不再有任何机制提示「保留段体量估算失真」。保护性：本特性直接消灭了估算行为本身，告警的保护对象已不存在。
2. **回放节截断（applyReplayTruncation）整体删除**：user 注入包内嵌套「## 对话历史」回放节从此无截断防线。防线成立的根因同步消失：回放节只出现在 user 消息里，而新算法的保留段根本不收 user 消息——嵌套回放膨胀路径从根上没了（方案「影响范围」节声明）。
3. **token 预算弹性废除**：保留段不再按目标模型窗口自适应缩放——64K 小窗模型与 1M 大窗模型拿到同样的 ≤6.3K 保留段。这是「不会出错的逻辑」与「聪明的逻辑」之间的显式取舍（搭档拍板），弹性空间（大窗模型本可保留更多）被有意放弃。
4. **保留段信息面收窄**：user 消息（搭档原话）、toolResult、thinking、toolCall 参数不再出现在保留段。兜底链：搭档指令原话由档案「搭档指令原话」节独立承载；更早上下文由叙事摘要 + search_messages 承担（方案「影响范围」节已声明，此处为提交级留痕）。
5. **SDK findCutPoint 调用退役**：与 SDK 压缩切片的行为对齐关系断裂——SDK 升级改动 findCutPoint 语义不再影响本切片器（解耦收益）；反向地，SDK 未来若提供更好的保留段算法也不会自动获得（显式弃用）。

### 最简实现检查（必答）

已过最简检查：核心算法约 15 行（倒序扫描 + 拼接截断 + 重构造），净删除约 220 行（估算器/密度告警/回放节截断），新增约 60 行（含端口方法与注释）。无新依赖、无新配置项、无新状态；常量复用现有 750/750 阈值套件；序列化复用 SDK serializeConversation。仓库内无「更少代码达成同等效果」的路径——唯一可再省的是 A1 路径锚（约 25 行），但它是检视 A1 的修正项（新世獭可定位截断原文），砍掉即退化。

### 验证记录（2026-09-29，worktree fix/kept-window-simplify）

- **单测**：`npx vitest run tests/frameworks/agent/session-slicer.test.ts tests/frameworks/agent/unified-handoff-engine.test.ts` → 19/19 通过（含 S1 混合块回归：4 条 text 1000 + thinking 3000 + toolCall args 5000 → 序列化不含 thinking/toolCall 内容、总量 ≤6,500）
- **全量**：`npx vitest run` → 305 files / 4,313 tests 全绿（ensure-hooks「当前目录不在 git 仓库内」提示为 worktree 内运行既有现象，非本次引入）
- **tsc**：`npx tsc --noEmit` → 0 error
- **eslint**：改动文件 8 个全过（含 complexity 修复：assistantTextOf 拆出 joinedTextBlocks/isNonEmptyTextBlock）
- **Golden Gate**: n/a（verify_by=static_only，无场景可跑）——切片逻辑纯函数，条数/截断/体量均静态断言
- **端到端 alpha 冒烟（验证节第 3 条）**：留给大獭推送后安排（kimi-256k 獭重启冒烟属生产操作，实现獭不在主环境执行）
- **pre-existing 声明**：无——全量测试零失败，无需要声明 pre-existing 的项

### 机制判定核对

净退役判定已在方案期完成并留痕于「设计取舍」节（密度告警/估算换算/turn 切片三机制死亡、零新增机制），本步骤核对：设计取舍段含判定结论 ✓；diff 实况与判定一致（删除 > 新增，无新配置/状态/生命周期/调用路径）✓。
