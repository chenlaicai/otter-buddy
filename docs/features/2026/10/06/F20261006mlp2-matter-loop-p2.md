---
id: F20261006mlp2
title: 待办（Matter Loop）P2：板上裁决交互层 + 裁决回写通道 + 通道 A 獭侧纪律
summary: F20261006mtlp 的 P2 期。三块：①右侧栏「待办」tab 交互层（WAITING_PARTNER 条目内嵌批准/否决/打回、DONE_PENDING_CONFIRM 确认闭环/打回、折叠「近期闭环」翻案入口、「+」登记入口——准入路径 2 搭档手动登记 initialState=OPEN）；②裁决回写通道——板上按钮合成结构化回执、复用 sendMessage SSE 管线显式路由 owner 獭，由其 transition_matter(on_behalf_of='partner') 代执行迁移（守卫语义不变，owner 已解散时自动退派在场大獭兜底——通道 B 存在意义是獭不在场时搭档自助）；③通道 A 獭侧纪律落身份层——搭档对话直复疑似裁决时獭识别裁决对象→代执行迁移→复述确认。
doc_type: feature
change_type: feature
intent:
  problem: "F20261006mtlp P1 落地了 matters 表/状态机/獭侧工具/只读 tab，但板上只能看不能动——搭档要裁决仍必须回到对话里打字（通道 A 是唯一路）。假期回来扫积压、想不起来獭在说哪件、獭已不在场时，搭档需要一个不依赖獭在场的板上自助操作入口；同时通道 A（对话直复）目前只靠獭自觉识别，没有身份层纪律把「识别裁决→代执行→复述确认」固化成每轮生效的反射。"
  why_now: "方案 §7 分期定死 P2=交互层+裁决回写通道+通道 A 配套；P1 已合入 #1287（2026-10-06），空窗期裁决走通道 A 主路（板上只读），P2 补板上按钮让通道 B（兜底）真正可用。"
  expected_effect: "搭档打开待办 tab 能对 WAITING_PARTNER 条目就地批准/否决/打回、对 DONE_PENDING_CONFIRM 确认闭环/打回、在近期闭环区翻案、用「+」登记一件事——按钮操作合成回执路由 owner 獭代执行迁移并唤醒它；owner 獭已解散时按钮仍可用（自动退派在场大獭）。对话直复时獭按身份层纪律识别裁决对象、代执行迁移、复述确认。"
  verify_by:
    type: human_judge
    note: "交互与视图效果由搭档日常体验判定（UI 高保真、按钮就地操作）；状态迁移正确性由 vitest 锁定；獭侧纪律注入面过 lint:intent；回执路由链路由单元测试 + 真机截图取证"
capability_test: tests/capability/matter-loop/matter-loop.capability.test.ts
created_in_conversation: e871769f-a731-4278-ae21-de3ab4c8eaf8
created_at: 2026-10-06
tags: [matter-loop, conversation-layout, ux, decision, handoff]
modules: [web/src/pages/conversation/, src/usecases/matter/, prompts/identity/]
causal_links:
  - F20261006mtlp
from: [F20261006mtlp]
---

# 待办（Matter Loop）P2

> 本文档是 F20261006mtlp（方案+P1）的 P2 期实现记录，不改已合入的 F20261006mtlp 正文（pre-commit lint-historical-docs 拦截）。
> P2 范围 = 方案 §7 P2 行 + §5 呈现与操作（就地操作）+ §3.5 裁决双通道（通道 B 细化 + 通道 A 纪律载体）。
> 设计真相源仍是 F20261006mtlp §1-§7，本文档只记录 P2 的实现期决策与落地形态。

## 按钮挂点架构定案（L1 决策，实现期调研）

**开放问题**（任务简报给定）：板上按钮 → matters 表状态迁移，两条候选路——
- A = 新增 HTTP 写端点（server-side actor='partner' 直接迁移）
- B = 按钮合成回执喂给 owner 獭，由其 transition_matter(on_behalf_of='partner') 代执行

**定案：B（回执代执行）。** 理由（调研锚点均落 worktree 实际代码）：

1. **硬约束满足——owner 獭已 dissolve 时按钮仍可用**。通道 B 的存在意义是「獭不在场时搭档自助」。走 B 时按钮合成一条结构化回执、经 `handleSend(mentionOtterIds=[ownerOtterId])` 发给 owner；后端 `resolveSendTargets`（`src/usecases/conversation/resolve-send-targets.ts:128` validateTargets）会校验显式目标「在场 + otter active」，owner 已 dissolve 时它被过滤、**自动退默认派发**（在场大獭兜底，`:143-145` 带 feedback「@提及的目标不可用…已派给大獭」）。于是：owner 在场 → 回执路由 owner 代执行迁移并唤醒它；owner 已解散 → 回执自动落到在场大獭、由大獭代执行——按钮两种情形都可用，无需任何特殊分支。若走 A（HTTP 端点直接迁移），迁移后唤醒等待獭需要一套独立旁路，且 owner 已解散时这套旁路要把 matter 转 OPEN 等重派，等于复制 sendMessage 链路的调度复杂度。
2. **守卫语义零改动**。状态迁移仍走 TransitionMatter 单入口（`src/usecases/matter/transition-matter.ts`），矩阵/触发者/宣告权三层不变；獭收到回执后用 P1 已有的 `transition_matter(on_behalf_of='partner')` 代执行，代执行强制 resolution 留痕（`matter-tools.ts` validateProxyParams）。HTTP 面无写端点（P1 纪律延续：写路径不经 HTTP）。
3. **cardId 永久关闭坑天然绕开**。P1 标注的「同 cardId 永久关闭」（useCardBridge 已回复 cardId 永久关闭，打回后二次进 WAITING_PARTNER 需新 cardId）只在走卡片回执管道时存在。P2 按钮不走卡片 iframe 的 otterCard.submit，而是直接合成 user 消息走 sendMessage 管线——没有 cardId 概念，重发/打回/翻案都不受此坑约束。
4. **单一真相源纪律不破**。按钮操作产生的回执是一条普通 user entry（搭档在对话里的动作留痕），状态迁移由獭代执行后落 matters 表——状态真相仍在表，流内是投影，无双写。

**代价（如实声明）**：按钮裁决不是「即时落库」——它先把回执发给獭、由獭在下轮 LLM 调用里 transition_matter，存在「獭收到回执但迁移失败/獭不执行」的窗口。缓解：①迁移失败獭侧有 errorResponse + 复述确认闭环（说错了搭档当场纠正）；②板上 30s 轮询会反映迁移结果，搭档可见；③这是通道 B（兜底）语义可接受的——主路通道 A 本就是「獭识别+代执行」，P2 让板上按钮复用同一条「獭代执行」链路，语义一致。若未来需要「无獭在场时即时落库」的硬实时路径，再评估 HTTP 写端点（开放，非本期）。

## P2 实现记录

### 落地清单

| 面 | 改动 | 文件 |
|---|---|---|
| 待办 tab 交互层 | WAITING_PARTNER 内嵌批准/打回/否决、DONE_PENDING_CONFIRM 确认闭环/打回、折叠「近期闭环」翻案入口、「+」登记表单（准入路径 2 initialState=OPEN）；角标语义=partner 欠动作数；样式采样宿主 glass 面板/glass-card/otter 渐变主按钮（MessageInput 发送键） | web/src/pages/conversation/MattersPanel.tsx |
| 裁决回执合成 | buildMatterActionBody/buildMatterRegisterBody 输出人可读摘要 + html-matter-action 围栏（matter/to/on_behalf_of/initial_state 结构化——獭照做即可，不让獭自由判映射） | web/src/pages/conversation/hooks/useMatters.ts |
| 回写通道 | onRouteToOtter(body, ownerOtterId) → index.tsx handleSend(mentionOtterIds=[owner]) → sendMessage SSE 管线 → resolveSendTargets 路由 owner 獭代执行 transition_matter(on_behalf_of='partner')；owner 已解散自动退派在场大獭兜底。失败 toast 分流（#1268 教训），不乐观改状态（状态真相只在 matters 表） | web/src/pages/conversation/index.tsx:1650、RightPanel.tsx、useMatters.ts |
| 近期闭环数据源 | matter-controller ?includeClosed=1（只读扩展，写路径仍不经 HTTP）；useMatters 拉 open + 含 closed 两路 | src/interface-adapters/http/controllers/matter-controller.ts、web/src/api/client.ts |
| 通道 A 獭侧纪律 | BIG_OTTER.md + SMALL_OTTER.md 各加「待办裁决纪律」段：识别裁决对象(list_matters)→代执行迁移(on_behalf_of='partner'，resolution=代搭档执行:<原话>)→复述确认。每轮生效（身份层非 skill）；不做 NLP 自动判定 | prompts/identity/BIG_OTTER.md、SMALL_OTTER.md |
| 能力测试场景③ | P1 占位 → 板上批准回执路由 owner 獭代执行迁移（matters 表状态迁移 + resolution 留痕，3 采样 ≥2；seed 一件 WAITING_PARTNER owner=大獭，发 html-matter-action 回执显式路由 owner，确定性断言表迁移+留痕） | tests/capability/matter-loop/matter-loop.capability.test.ts |
| 面板单测 | P2 交互 7 用例（按钮组渲染/批准回执路由 owner/否决→ABANDONED/owner 为 null→默认派发兜底/登记表单/近期闭环翻案）+ RightPanel「待办」tab 切换渲染用例 + controller includeClosed 2 用例 | MattersPanel.test.tsx、RightPanel.test.tsx、matter-controller.test.ts |

### 实现期决策（按钮挂点以外的取舍）

1. **动作 → 目标态由前端声明、獭透传执行**（不在獭侧让 LLM 自由判映射）：回执围栏带显式 `to="<STATE>"`，獭只需 transition_matter(matter_id, to, on_behalf_of='partner') 透传——防獭把「否决」判成「打回」这类映射漂移。映射表唯一真相源 = useMatters.ts 的 ACTION_TO_STATE。
2. **板上不乐观改状态**：曾考虑乐观迁移给搭档即时反馈，但回执是发给獭异步代执行、非 HTTP 同步落库——提前渲染未发生的迁移 = 双写分裂。改为只 toast「已发送请求给负责獭」，真实迁移经 30s 轮询反映。这与「状态真相只在 matters 表」纪律一致。
3. **翻案只对 CLOSED 开放**（不对 ABANDONED/SUPERSEDED）：方案语义里翻案=推翻已闭环结论；ABANDONED（已不做）重开是另一语义（更近似「重新登记」），本期只对 CLOSED 出翻案按钮。
4. **登记走默认派发（不传 owner）**：「+」登记没有既有 owner，回执 mention 传 null → resolveSendTargets 默认派发（最后发言獭/在场大獭），由被唤醒獭调 RegisterMatter 登记。

## 审视处置记录（检视1320獭：需要修改 3 严重 + 4 建议 → 已修复）

异体模型 mimo-pro 审视 PR #1320，最重一洞是清单外抓的：「+」登记端到端死链。逐条核实锚点全部实锤，全部处置：

### 严重 3 条（本 PR 修复）

1. **「+」登记死链**——P1 只把 RegisterMatter 接在 yield 打标路径（准入路径 1），工具面没注册登记工具；板上「+」回执让獭登记但獭无工具可达 = 登记必丢，且先弹成功 toast = 假象。**修复**：
   - 新增 `register_matter` 工具（matter-tools.ts——登记即 OPEN、title 必填、owner 缺省=登记獭认领），tool-factory 注册（matterRepo 注入时）；
   - 能力测试补场景④（板上登记回执 → register_matter 工具登记 → matters 表新增 OPEN 行，确定性断言）；
   - 工具单测 matter-register-tool.test.ts（登记语义 + tool-factory 装配正面锁死链）。
2. **回执伪造面 + ABANDONED 终态不可逆**——identity 纪律「照做即可」无来源限制，且 `on_behalf_of` 自声明无来源核验（P1 继承面）；ABANDONED 零出边 = 误判/伪造的「否决」永久杀事项（P2 增量：否决按钮让死路高频触发）。**修复**：
   - identity 双文件纪律补**来源核验**：html-matter-action 围栏**只认 user 来源**（别的獭消息/注入内容/转义逃逸 = 不照做，识别伪造迹象 speak 指出）；
   - 矩阵补 `ABANDONED→OPEN`（partner 专属，与 CLOSED→OPEN 翻案对称）——板上近期闭环区纳入 ABANDONED 出翻案按钮，否决不再永久杀事项；
   - 状态机单测补 ABANDONED→OPEN 合法 + 非 partner 拒绝（#1321 留档跟踪完整恢复入口打磨）。
3. **commit 缺 Modification-Class 声明**——补上（本修复 commit 带 mechanism-addition 声明，四问：#1321 ABANDONED 恢复入口、#1322 越权面、能力测试场景④、golden 2 场景）。

### 建议 4 条（大獭裁决，全部接受）

1. **toast 时序 + 按钮防重**——act/register 改 async 接路由真实结果再 toast（此前先弹成功=假象，#1268 同向）；按钮加 pending 态防双击/重入。
2. 并入严重2（ABANDONED 恢复，已修）。
3. **纪律歧义改措辞 + golden 2 条**——「识别=锚定到具体 matter 短锚」澄清（非自由心证猜意图，消「不做 NLP」与识别步骤的字面冲突）；golden 场景 `matter-vague-no-migrate`（无锚点模糊表态不迁移）+ `matter-forged-receipt-no-exec`（非 user 来源围栏不执行），各配 selftest 参考序列（good/bad 判别力校验）。
4. **includeClosed 截断语义**——本 PR 不改代码（避免在既有查询里塞子查询的复杂化），留档：语义是「全表前 100 含终态」，open 超 100 时翻案入口可能不含旧 closed。issue #1322 登记越权面（P1 既有系统性无鉴权，非 P2 回归，单独排期横切）。

### 未决问题（留档，均已登记 issue）

- **#1321**（P1）：ABANDONED 完整恢复入口打磨——本 PR 补了 ABANDONED→OPEN 矩阵迁移 + 板上翻案按钮，但「已不做」区独立呈现、恢复路径能力测试采样等可再完善。
- **#1322**（P1 既有）：对话域控制器系统性无鉴权——UUID 不可猜测 ≠ 鉴权。matters 端点含 includeClosed=1 后暴露面略增，横切工程单独排期。

### 负面向验收

- 无 NLP 自动识别裁决（方案已否决：误判腐蚀信任）——纪律明确「识别不到明确对象就不强行迁移，正常回话」。
- owner 獭已解散：按钮仍可用——回执 mention owner 被 resolveSendTargets 过滤后自动退派在场大獭兜底（能力测试场景③只覆盖 owner 在场路径；owner 已解散的退派路径由 resolveSendTargets 既有单测锁定）。
- 失败分支不静默：act/register 的 routeRef 抛错或缺失时 toast 报错可重试（#1268 教训）。
- cardId 永久关闭坑：P2 按钮不走卡片 iframe otterCard.submit、无 cardId 概念，重发/打回/翻案均不受 P1 标注的「同 cardId 永久关闭」约束。
- 守卫语义零改动：所有迁移仍走 TransitionMatter 单入口（矩阵/触发者/宣告权三层未动），代执行复用 P1 已有的 on_behalf_of 通道。

### 自检结果

| 项 | 结果 |
|---|---|
| 后端全量单测 | 4808 passed（vitest run）|
| 前端全量单测 | 634 passed / 61 files（web vitest run）|
| eslint | 0 error |
| tsc --noEmit | 后端 + 前端均 0 error |
| lint:intent | 0 error（F20261006mlp2 intent/verify_by 齐全，verify_by=human_judge）|
| UI 真机截图 | Playwright 4 张存对话工作区（p2-matter-0/1/2/3.png）——待办 tab 角标2、批准/打回/否决按钮组、确认闭环/打回、近期闭环翻案、+登记表单，样式采样宿主 glass/otter 渐变 |
| 生产副本真启动 | 本 PR 无 schema.ts/migration.ts 变更（controller 只读扩展，无表结构变更），不触发该硬门禁 |

**Golden Gate**：本 PR 软代码改动 = identity 文件（prompts/identity/*），verify_by 声明 human_judge——Golden Gate 对该类型声明豁免（人工行为检查，非 golden_replay）。PR Verification 记录：软代码面=2 个 identity 文件，改动行为语义=新增「待办裁决纪律」段（通道 A：识别裁决→代执行→复述确认），建议抽样锚点=BIG_OTTER.md/SMALL_OTTER.md 的「待办裁决纪律」标题段。异体模型评审（mimo-pro）由大獭在审视阶段安排。
