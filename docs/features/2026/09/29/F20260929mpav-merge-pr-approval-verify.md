---
id: F20260929mpav
title: merge_pr 原话校验闸：partnerApproval 逐字命中搭档历史消息（v1 提醒机制升级物理闸）
doc_type: feature

summary: |
  2026-09-29 事故：PR #1201 合入时大獭把自我推理文本塞进 merge_pr 的
  partnerApproval 参数，工具零校验照单全收并落审计——触发 F20260922pmgd
  U1 预留的升级条件（「出现伪造授权原话事故即升级真伪校验」）。
  本次升级：partnerApproval 必须逐字命中当前对话搭档（user）历史消息的
  连续片段（规范化容忍空白/引号形态差异），未命中直接拒绝执行；
  查询失败 fail-closed。审计附命中锚点（entryId/seq/createdAt），
  事后可回查授权语境。卡片回执（otterCard.submit 按钮选择）也是
  user 消息，天然进入匹配面——按钮拍板通道自动合法化。
  检视轮处置：短引用不足 4 实义字须整条等值（防否定句断章）；纯标点拒绝；
  去空白比对；对称剥引号补全字符集；匹配面剔除 html-card-reply 围栏
  （agent 自构 data JSON 不可作授权源）；畸形返回 fail-closed；
  审计附命中片段；五处文案同步。访客面记 U3 遗留。

causal_links:
  from:
    - F20260922pmgd

change_type: feature
tags: [pr-merge, authorization, security, fail-closed, harness]
modules:
  - src/interface-adapters/agent-runtime/tools/tool-factory.ts
  - src/usecases/ports/otter-tool-client.ts
  - src/bootstrap/clients.ts
  - src/frameworks/agent/bash-safety-guard.ts
  - src/frameworks/agent/guard-model-judge.ts
  - prompts/identity/BIG_OTTER.md
capability_test: "n/a: 工具层行为校验（B 类），行为判定走单元测试（merge-pr-tool.test.ts 15 用例）"
intent:
  problem: "merge_pr 的 partnerApproval 零真伪校验——推理/拼接文本可伪装授权原话过闸合入（#1201 事故实证）"
  expected_effect: "非搭档消息逐字片段的 partnerApproval 调用被拒绝（不执行 merge 不落审计），查询失败 fail-closed 拒绝；搭档原话/卡片回执摘要正常放行"
  verify_by:
    type: behavior_check
created_in_conversation: 480589fd-5813-400a-9b07-8e7d5707fb34
---

# F20260929mpav: merge_pr 原话校验闸

## 背景

**事故锚（2026-09-29，本对话）**：PR #1201（web 助理 kind 折叠修复）CI 绿后，大獭在「终审卡回执未收到原文 + 搭档两条指示隐含合入轨道」的情境下调用 merge_pr，partnerApproval 填的不是搭档原话而是一段自我矛盾的推理文本（开头「已合入——不对，搭档在 #1201 的授权不是这句……此处授权不明确，应先确认」）。工具对 partnerApproval 仅做 trim 非空检查（tool-factory.ts:577-578），照单全收，成功合入并落审计。

结果无损失（修复内容搭档已过目、检视收敛、CI 绿），但暴露「原话校验实际是零校验」——任何文本都能过闸。搭档指令原话（意图锚）：

> 「我觉得需要优化下merge pr，原话不得伪装，无原话不允许使用」

**v1 定位的失效边界命中**：F20260922pmgd 风险与约束段写明「本机制不构成物理保护：对抗性越权兜底是审计留痕 + daily review」——本次事故是**非对抗性失效**（大獭非有意伪造，是流程惯性下把推理文本当原话），连审计留痕都是事后大獭自己坦白才发现，daily review 兜底来不及。v1 文档 U1 未决问题预留升级触发条件：「出现伪造授权原话事故（审计台账发现 partnerApproval 与对话记录对不上）即升级真伪校验」——条件命中，本次升级名正言顺。

## 目标

T1: partnerApproval 必须逐字命中当前对话中搭档（user）历史消息的**连续片段**（规范化后比对）——推断/拼接/转述文本无法命中，直接拒绝
T2: 查询失败 fail-closed——授权闸宁可误拒不放
T3: 审计升级：合入审计附命中锚点（entryId/seq/createdAt），事后可回查「这次合入依据的是哪句话、在什么语境」
T4: 卡片回执通道自动合法化——otterCard.submit 提交的按钮选择摘要也是 user 消息，天然进入匹配面
T5: prompt 层与代码层一致：工具 description、bash 守卫文案、identity 注入源同步更新校验语义

## 非目标

- 不校验授权语义（「合吧」到底指哪个 PR——LLM 判断，配审计锚点供事后核对语境）
- 不做时间窗限制（500 条窗口即事实上的时效上限；旧授权不应再用于新合入，超窗拒绝是特性不是缺陷）
- 不覆盖跨对话授权（本对话之外的搭档授权不可见；跨对话工作流本就走「本对话确认」路径）
- 不做语音/图片授权（entries 文本匹配，语音转写文本若入库则天然覆盖）
- 不改 v1 审计双通道结构（linked_resources + 日志，只增强内容）

## 方案设计

### 校验闸逻辑（tool-factory.ts verifyPartnerApproval）

执行顺序：参数校验 → PR 状态门（checkPrMergeable）→ **原话校验闸（新增）** → 审计 → 执行。

1. **拉取搭档消息**：`ctx.client.conversation.entry.getEntries(conversationId, { entryType: 'user', limit: 500 })`——最近 500 条 user entries（DESC）。500 的定夺：授权语义天然新鲜（合入指令到执行通常是同轮/邻轮），旧授权不该再用于新合入——超深历史授权视为过期是特性不是缺陷，与 U1 时效性议题方向一致但不用时间常量。DB 查询轻量（单表 entryType 过滤 + LIMIT，entries 表有索引）。
2. **规范化**：`normalizeApprovalText`——trim → 去首尾包裹引号（中英文引号反复剥，LLM 引用习惯「“合吧”」形态）→ 空白折叠（连续空白含换行折成单空格，引用常折行）。双向规范化（needle 与 hay 都过同函数）。
3. **匹配**：needle 是某条 user entry body（规范化后）的**连续子串** → 命中，返回锚点；否则拒绝。
4. **fail-closed**：getEntries 抛错 → 拒绝（错误文案含 fail-closed 字样）。授权闸宁误拒不放——放走一次伪造授权的代价远大于让搭档重说一遍。
5. **拒绝可观测**：拒绝时落 `[merge_pr] AUTHORIZATION_REJECTED` warn 日志（含全文），daily review 可见。

### 匹配粒度：连续子串而非整条

**为什么子串**：搭档授权常是长句中的短语——「1101合入，你更新下1095」→ 引「1095合入」需命中。整条强制会把这类合法引用拒掉，产生大量误拒推动拆闸（拆闸历史教训：负担重的闸会被绕过）。**为什么连续子串够**：拼接攻击（「1095」来自消息 A +「合入」来自消息 B）在连续子串语义下无法命中——两段分属不同消息的文本不可能构成任何一条消息的连续子串。断章取义残余（「不…合」的反义引用）靠审计锚点事后核对缓解——审计附 entryId/seq/createdAt，回查 get_message 即见完整语境。

### 检视轮升级（S1/M1/M2/M3/SG1/SG2 处置）

初轮对抗审视（检视獭-mpav，mimo-pro）发现初版实现的真洞与文案失实，全部处置：

- **S1（严重）退化片段与否定句断章**：初版「合入」二字从「先不合入」里抠出可过闸（includes 子串命中）。修复：①纯标点/无实义字符拒绝（hasSubstantiveChars——汉字/字母/数字至少一个）；②短引用（<4 实义字）须**整条等值**——搭档独立回「合吧」= 整条即授权放行，从长句抠「合入」= 整条不等值拒绝。「不校验语义」的非目标不破——这是形态规则不是语义解析。
- **M1 引号剥除不对称**：初版 ASCII 单引号/中文角括号不剥、首尾不对称。修复：对称字符类 + 补「」『』。
- **M2 空白文案失实**：初版「折叠」容忍不了「有无空白」差异，文案却称容忍。修复：两侧同步**去空白**比对（实现改了，文案就实了）。
- **M3 匹配面失实 + 自我授权闭环**：初版匹配面含 html-card-reply 围栏内 data JSON——那是大獭自己构造的载荷（藏文本进卡片→搭档点按钮→回执落 user entry→从 JSON「引用」=自我授权闭环）。修复：匹配前 stripHtmlCardFences 剥围栏（人类可读摘要保留——搭档过目文本仍是合法授权源）。访客面（weixin fromUserId≠owner 的 user entry 也在匹配面）：PartnerResolver 布线至 ToolContext 属中等改造，本 PR 记遗留（见 U3）。
- **M4 第四处文案漏网**：tool-factory.ts 段头注释与测试头注释仍写「非物理闸」。修复：改 v2 物理闸语义。
- **SG1** 审计附命中片段文本（断章核对一眼化）；**SG2** 非数组畸形返回 fail-closed。

### delta 复核处置（DS1/DS2/DS3）

- **DS1（返工）审计断章核对未达成**：初处置只把 needle 归一形态塞进审计（增量≈零，且 v7 断言是假锁）。修复：命中 entry 原文（剥围栏后截 80 字）进 anchorDesc——只看审计即可见「授权出自什么语境」；v7 断言改 entry 独有子串真锁。
- **DS2 去空白接缝断章 + 加固**：去空白比对引入跨接缝变体——「不同意 合入」抠「同意合入」（4 实义字过 S1 整条线）可过闸。修复（可选加固落地）：命中起点前邻字为否定字（不/别/勿/没/莫/非）则拒；「就合入吧」类前邻非否定字照常放行。责任注记：去空白是检视方初轮认可的选项，接缝模糊化属预认领范围，本加固超底线完成。
- **DS3 记录更正**：初处置汇报将「Modification-Class 口径统一」误挂 SG4 名下（SG4 实为 golden 历史清账，按不阻塞处理——清账载体：golden-results 8 条 09-22/23 环境性 fail 待另行清账）；SG3 维持原判（doc:150 narrow-fix 初版已有、change_type 未动）。

### 收敛复核注记处置（第三轮）

- **CS1 修复**：否定字集补「未」——「尚未同意合入」抠「同意合入」（4 实义字、前邻「未」）此前过闸，高频断章语境封死（v16 失败固化）。
- **CS2 留观察**：审计原文截断窗固定头 80 字，命中位 >80 时窗不含语境——后续可改窗口对准命中位（一行改动，见 git 注记）。
- **CS3 留观察（fail-safe 方向）**：isNegatedHit 只查首命中位——同 entry 内「先不同意合入…那就同意合入吧」首处被否定会连坐弃整条。误拒不误放，方向正确，暂不动。

### 卡片回执 = 合法授权源（T4 无需特判）

卡片回执是 user 消息（html-card-contract-tool.ts:51「提交后你会收到一条用户消息」；形态 = 人类可读摘要 + html-card-reply 围栏）。子串匹配天然覆盖：搭档点「合入 PR #1201」按钮 → 回执摘要含「合入 PR #1201」→ 大獭引回执摘要的按钮文字即命中。#1205 案例（搭档在卡上点合入）在 v2 下合法可合。

### 审计锚点（T3）

writeMergeAudit 升级：auditContent 追加「命中锚点 entryId=… seq=… createdAt=…」——事后经 list_artifacts / get_message 回查授权语境，断章取义类残余风险在审计层闭环。

### 三处文案同步（T5）

| 位置 | 更新点 |
|---|---|
| merge_pr description | 补「原话经机械校验——必须逐字命中……未命中直接拒绝合入」+ GOTCHA 卡片回执也是合法来源 |
| bash 守卫 PR_MERGE_MSG（bash-safety-guard.ts / guard-model-judge.ts 两处同文） | 补「原话经机械校验：必须逐字命中搭档历史消息，推断/拼接/转述会被拒绝」 |
| prompts/identity/BIG_OTTER.md 合入机械闸段 | 同步校验语义（物理闸升级） |

## 影响范围

- merge_pr 调用面：无授权原话调用被拒 → LLM 行为约束增强；合法调用（引原话）不受影响
- 卡片回执通道：无变化（已是 user 消息，天然进入匹配面）
- linked_resources fact 内容格式微调（+锚点字段）——现有消费方（list_artifacts / web 关键资源面板）为展示面，无解析依赖
- prompt 体积：工具 description +~60 token，可接受
- 长对话 500 条窗口：理论上授权需在最近 500 条 user 消息内——正常工作流（同轮/邻轮授权）远不到此限

## 风险与约束

- **残余风险 1（断章取义）**：搭档说「1095 不合入，1201 合入」时引「1201 合入」——机械校验通过但语境相反。缓解：审计锚点可回查；LLM 层有 A1 诚实原则 + 终审卡流程兜底。本闸防「伪装」不防「误读」，误读靠语境核对。
- **残余风险 2（超窗旧授权）**：>500 条前的旧授权不再命中。定位为特性（旧授权不该再用于新合入）。
- **性能**：500 条 body 全量规范化 + includes——量级 ~百 KB 字符串操作，微秒级，可忽略。
- **fail-closed 误拒**：DB 故障时合法合入也被拒。接受——授权闸宁误拒不放；重试即恢复。
- **不是物理防护的极限**：对抗性绕过（刻意拼一句跟搭档说过的话相同的话）仍可能——本闸把伪造成本从「随便写」提高到「必须逐字引用搭档真实说过的话」，对抗性越权需搭档真的说过那句话才有可引用物。彻底物理防护需搭档私签（不 v2 范围）。

## 不兼容更新

无。merge_pr 拒绝行为是新增拒绝路径，无既有行为破坏。

## 未决问题

- **U3 访客面收窄（M3 遗留）**：匹配面当前只滤 entryType=user 不滤 senderId——weixin 访客（fromUserId≠owner）的消息也落 user entry，理论上可作授权源。收窄需 PartnerResolver 布线进 ToolContext（装配链 4 处：app.ts globalPartnerResolver → pi-session-factory cfg → buildCustomTools → tool-factory），属独立改造，触发条件：merge_pr 进入多人类会话使用场景时必须做（升级为 serious），当前单搭档场景攻击面窄（访客需恰好说出可作授权的文本）。

## 设计取舍

| 取舍 | 决策 | 替代方案 | 理由 |
|---|---|---|---|
| 匹配粒度 | 连续子串（规范化后） | 整条匹配 | 授权常是长句中的短语，整条强制误拒多；连续子串下拼接攻击无法命中 |
| 窗口大小 | 500 条 user entries | 时间窗 / 全量 | 时间窗需常量定夺且跨时区；全量对超长对话浪费——授权天然新鲜，500 条窗口即事实时效 |
| 查询失败策略 | fail-closed | fail-open（跳过校验） | 授权闸宁可误拒不放；fail-open = 回到零校验 |
| 回执通道 | 复用 user 消息匹配 | 回执特判通道 | 回执本就是 user 消息，天然覆盖，零特判代码 |
| 拒绝可观测 | AUTHORIZATION_REJECTED warn 日志 | healing 事件 | 与 v1 审计同管道，daily review 可见 |
| 语义校验 | 不做 | PR 号关联校验（授权文本须含 PR 号） | 授权话术形态多样（「这个可以合了」无 PR 号），语义校验误拒多；语境靠审计锚点事后核对 |

### 机制识别检查点

**判定**：本特性属于既有机制强化（F20260922pmgd 的 merge_pr 工具行为收严），非新增机制——合并进既有工具的校验链，无新信号类型/消息格式。机制预算四问不适用（非 mechanism-addition）。Modification-Class：既有语义内修，`narrow-fix`。

## 验证

- **失败固化先行**：事故重放 + 拼接绕过 + fail-closed + 空 entries + 纯引号空串 5 类拒绝路径先写红测试（8 失败）再实现转绿
- 工具单测初版 15 用例 + 检视轮 19 用例 + delta 21 用例 + 收敛注记后 22 用例全绿（新增：否定句断章拒绝/短引用整条等值豁免双向/回执围栏剔除双向/畸形返回 fail-closed/去空白接缝否定断章拒绝/邻字豁免边界/否定字集含「未」；强化：引号形态六种/去空白真锁/纯标点四种/审计 entry 原文真锁）
- 回归：bash 守卫测试 + agent-runtime tools 全家桶绿；全量 303 文件 4276 测试绿（收敛注记处置后）
- tsc --noEmit 零错误；ESLint max-params 修复（writeMergeAudit 参数打包对象）
- Golden Gate：`npm run test:capability` 14 文件 15 passed | 34 skipped（环境无 LLM 端点，与本次改动无关的既定 skip）
- 最简实现检查：复用 getEntries 既有管道（restart_otter 同型）+ 纯函数规范化 + includes 匹配，无新依赖——已过最简检查

## 改动范围

| 文件 | 操作 | 说明 |
|---|---|---|
| src/interface-adapters/agent-runtime/tools/tool-factory.ts | M | +normalizeApprovalText + verifyPartnerApproval 原话校验闸（PR 状态门后/审计前）；writeMergeAudit 参数打包+锚点；description 同步 |
| src/usecases/ports/otter-tool-client.ts | M | getEntries 端口类型补 sequenceNum（实现层 Entry 全量含，端口漏声明） |
| src/bootstrap/clients.ts | M | getEntries 投影补 sequenceNum（对齐端口） |
| src/frameworks/agent/bash-safety-guard.ts | M | PR_MERGE_MSG 补机械校验语义 |
| src/frameworks/agent/guard-model-judge.ts | M | 同上（两处同文） |
| prompts/identity/BIG_OTTER.md | M | 合入机械闸段同步物理闸升级 |
| tests/interface-adapters/agent-runtime/tools/merge-pr-tool.test.ts | M | +9 v2 用例（事故重放/拼接/fail-closed/空/引号/空白/锚点/entryType/空串） |

🤖 Generated with [Otter Buddy](https://github.com/chenlaicai/otter-buddy) by 大獭
