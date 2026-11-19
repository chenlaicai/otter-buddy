---
id: F20261118nrorc
title: 夜间审视编排（P2b2：scheduled-task 调度 + 夜审獭召唤 + fyi 否决锚）
doc_type: feature
summary: |
  「主动记忆层」P2 的收官刀。夜间审视从「档案与治量结构」落成「每日自动运转的编排」：
  function executor 通道（scheduler 通用机制的首次真实装配）承载全部治量逻辑——幂等取档
  （claim settled 短路）、跨档水位推进（停机补跑从旧水位继续，未清失败区间取较早不丢审）、
  当日 recorded 清单+原文注入、动态召唤 night-reviewer 獭（快照范围写进獭 context，三迁移
  工具 fail-closed 校验 createdAt ∈ [after, through]）、审后全量处置校验（recorded 残留 =
  丢审 → recordFailure 重跑同区间）、变更集 fyi 进时间线 + matter 否决锚（搭档一句话打回）。
  任务 seed 挂 healing 初始化链（幂等，尊重手动 disable），cron 每日 03:00 Asia/Shanghai，
  #814 迟到补跑由 scheduler 对 active cron 任务自动生效。
change_type: feature
intent:
  problem: "P2b1 交付的治量结构（claim/complete/recordFailure + listBeliefsByStatus）没有消费方——夜间审视作为非确定性 LLM 会话，其编排（何时跑、审哪段、跑挂了怎么办、产出如何存档可见）此前不存在；三迁移工具虽对 night-reviewer 白名单可见，但无快照范围约束，獭理论上可波及任意 belief；变更集对搭档不可见、无打回通道。"
  expected_effect: "每日 03:00（Asia/Shanghai）自动核对当日 recorded belief：全量核对非抽样，审后无 recorded 残留才 settle；停机/崩溃不丢不重（幂等键撞键短路 + 水位推进 + 失败区间重跑）；三迁移工具严格限定快照范围（无范围档即拒）；每次夜审的变更集以 system entry 汇总进 healing 主对话时间线并挂 matter 否决锚，搭档回复「打回 M-xxx」即由大獭迁 disputed。"
  verify_by:
    type: behavior_check
    note: "单测钉住：编排 22 项（幂等/水位/失败重跑/连败 skip/空集/成功链路/审计全集/补审计失败治理/召唤生命周期三态/超时常量同源/Shanghai 日界/损坏档案降级，含两轮审视修复场景钉证）+ 工具快照校验与 dispute 13 项 + 白名单矩阵 2 项 + seed 幂等 3 项 + repo listByTaskId 1 项。"
capability_test: "tests/capability/golden/night-review-full-processing.golden.ts"
created_at: 2026-11-18
created_in_conversation: 82f71e1a-a8b0-4e0f-916e-5e219624483c
causal_links:
  from: [F20261118nrcst, F20261118nrwht]
tags: [memory, belief, active-memory, night-review, scheduler, function-executor, idempotency, watermark, veto-anchor]
modules:
  - src/usecases/scheduler/night-review-orchestrator.ts
  - src/usecases/scheduler/night-review-prompt.ts
  - src/usecases/scheduler/ensure-night-review-task.ts
  - src/entities/memory/consolidation-state.ts
  - src/usecases/memory/consolidation-state-repository.ts
  - src/frameworks/db/memory/sqlite-consolidation-state-repository.ts
  - src/interface-adapters/agent-runtime/tools/tool-factory.ts
  - src/bootstrap/platforms.ts
  - src/bootstrap/clients.ts
  - tests/capability/golden/golden.runner.ts
  - tests/capability/golden/night-review-full-processing.golden.ts
---

# 夜间审视编排（F20261118nrorc）

> **定位**：P2「夜间审视」收官刀。P2a（F20261118nrwht）给了夜审獭身份，P2b1（F20261118nrcst）
> 给了治量结构——本刀把它们编排成每日自动运转的流程，消费全部前置接口，v4 §4.2-4.5 落地。

## 背景

夜间审视是非确定性 LLM 会话（开獭读当日 recorded belief 清单、逐条核对原文并迁移状态），
重跑两次产出必不同。P2b1 已给出判重（幂等键撞键返原结果）与失败治理（区间连败）的**结构**，
但没有任何东西调用它。编排本身必须是确定性代码——治量逻辑（何时跑、审哪段、跑挂了怎么办）
若交给 LLM 自己管理，等于让被审者管理审计流程。

## 方案

### 1. 编排通道：function executor（治量进代码，LLM 只做核对判断）

`scheduled-task` 的 function executor（executorType='function'，F20260920stkx 保留的 scheduler
通用机制，此前零在用者）承载编排：`NightReviewOrchestrator` 注册为
`night-review-orchestrator` 函数，任务 body（JSON params）携带 conversationId。

选择 function 而非 agent executor 的理由：
- claim/complete/recordFailure 是治量动作，必须在代码层原子执行，不能进夜审獭白名单（P2a
  恒 5 工具约束）；
- 成功判据机器可验证（审后状态快照 vs 审前 recorded 清单），不依赖 LLM 文本自述；
- 失败判定明确（invoke 抛错 / 审后残留 recorded → recordFailure），scheduler 的 3 连败熔断
  与 #814 对账自然衔接。

### 2. 编排流程（night-review-orchestrator.ts）

```
claim(review:{上海日}:night-review)
  ├─ settled → 短路返回原结果（幂等，崩溃重触发不重跑）
  ├─ failingRange 且连败≥3 → skip + healing「这段没审视成」（留档待人工介入）
  ├─ failingRange → 重跑原区间 [after, through]（双端原值）
  └─ 无 range → through=now，after=跨档水位
        after = min(最新 settle 档 through, 最早未清失败区间 failedAfter)
        无任何档 → now - 30h（首跑兜底回看窗）
区间全集 = 四状态查询拼接（recorded/verified/disputed/superseded）——变更集审计面
  ├─ 全集空 → complete 空变更集（当天无任何 belief 也是合法 settle）
  ├─ 待审（recorded）非空 → 召唤夜审獭 → 写范围进獭 context → 锚点 entry → invoke（240min race 超时）
  └─ 待审空（重跑补审计/全部即时 supersede）→ 不召唤獭
统一 settle（两条路径同一失败治理）：
  → 审后全量处置校验（待审 recorded 残留 = 丢审 → throw 走失败记账）
  → changeset = 区间全集终态（上轮已迁移 + 本轮迁移 + 即时 supersede 都入审计）
  → fyi（matter 查重幂等 + system entry）先于 complete（report 失败可重跑补发）
失败（任一环节）→ recordFailureOrSkip：连败达阈值当次报 healing 返 skipped（不熔断任务，
  次日新键 + 未清失败区间起点 = 水位覆盖该段，跳过≠丢审）；否则上抛走 failed 记账
finally: 解散夜审獭（动态召唤不入名册，不解散即孤儿；dissolve 失败报 healing）
```

水位语义（「停机错过 → 从旧水位继续」的物理实现）：settle 档的 resultJson 里存 through，
跨天新键 claim 不到昨天档，从 listByTaskId 全档读水位——**min(最新成功水位, 最早未清失败
区间)**，保证停机/失败漏掉的段不丢审、已审过的段不重跑。

### 3. 快照范围校验（工具层 fail-closed）

召唤时编排把 `{after, through}` 写进獭 otter context 的 `night_review_range` key；三迁移工具
（belief_verify/reject/supersede）执行时先读此 key 再校验目标 belief 的 createdAt 落在闭区间：

- 无 key / 档案损坏 / createdAt 缺失 / 超区间 → 拒（fail-closed——非编排召唤的獭无从获得迁移权）；
- 夜审獭白名单恒 5 工具（speak/yield + 三迁移），**不含 set_context**——LLM 无法篡改范围；
- `buildMemoryClient.getById` 补回填 createdAt（快照校验消费）。

### 4. fyi 否决锚（v4 §4.5）

夜审成功后编排层做两件事：
- `RegisterMatter`：state=WAITING_PARTNER，title=「夜间审视 {date}：N 条 belief 迁移待过目」，
  payload=完整变更集 JSON（打回时大獭按 id 迁 disputed 的数据源）；
- system entry 汇总进 healing 主对话时间线：每条标注 [已核实]/[存疑]/[已过期] + matter 短锚
  （M-xxx）+ 打回指引。

搭档回复「打回 M-xxx」→ 大獭走 transition_matter 闭环 matter + **belief_dispute 工具**把
对应 belief 迁 disputed（首轮审视发现 2 补全的执行体——设计原文「不需要额外机制」指 matter
流程，belief 迁移通道当时是疏漏：dispute 单向 recorded/verified→disputed，big 可见/
small 不可见/night-reviewer 不含，不给核实权）。空变更集不挂锚（无事可否决）。

### 5. 任务 seed（ensure-night-review-task.ts）

挂 healing 初始化链尾（`gates.selfHealing` on ⟹ healing 对话存在 ⟹ seed）：幂等查重按
任务名，**存在即返回（含 disabled）**——手动停用是搭档操作，seed 不复活也不重建同名双任务。
任务形态：cron `0 3 * * *` Asia/Shanghai（凌晨 3 点，避开 7:30-11:00 时间轴；夜间审视字面
意义放凌晨，LLM 长会话不与晨间任务抢链）、timeoutMinutes=240、executorRole='night-reviewer'
（function 任务不解析 executor，仅语义标注）。#814 迟到补跑对账由 scheduler 对 active cron
任务自动生效（停机错过 → 重启补触发 → 编排从旧水位继续），无需新机制。

## 设计取舍

1. **治量进代码 vs 獭自律**：编排（幂等/水位/失败治理）全部在 function executor 纯代码层，
   夜审獭只做「核对原文 + 三选一迁移」。LLM 判断錯了有搭档打回（fyi 锚），LLM 没跑完有
   recordFailure 重跑，LLM 跑偏了有快照范围硬约束——三层防线都不依赖提示词自律。
2. **动态召唤 vs 持久夜审獭**：每次夜审 CreateOtter(type='night-reviewer') → 审完 Dissolve。
   持久獭会占对话名册（干扰大獭 get_active_participants 派工判断）且需要 restartBeforeInvoke
   管理 session；动态召唤上下文天然干净（每天新獭新 session），代价是每晚一次建/散开销（可忽略）。
3. **审后全量处置校验（严格）**：三工具覆盖全部处置空间（吻合→verify、不吻合→reject、
   过期→supersede），不存在「保持原状」的合法选项——审后仍有 recorded 即 LLM 未完成核对，
   记失败重跑而非带病 settle。防的是「该核实的没核实」静默漏审（P2b1 设计文档点名的丢审形态）。
4. **水位跨档计算 vs 只看当日档**：claim 键按天分档，跨天新键看不到昨天的失败区间——若只看
   当日档，停机两天后 D3 的 claim 是空白档，会从兜底窗（30h）起审，中间漏掉的段超过 30h 即
   丢审。listByTaskId 全档读水位 + min(成功水位, 最早未清失败) 把「从旧水位继续」做成物理保证。

### 设计取舍（mechanism-addition 四问）

1. **谁需要它？** 主动记忆层的 belief 数据完整性——recorded 不经核实永远以 [未核实] 面目
   出现，verified 的独立审视信任模型需要这个每日通道兑现。
2. **失败后果？** 编排炸了走 function executor failed 记账（scheduler 3 连败熔断 + healing
   可见）；连败达阈值跳过并报 healing「这段没审视成」——belief 系统退回「全部未核实」状态，
   检索降权标注仍在，无数据损坏。
3. **后续机制？** 无——本刀是 P2 收官。观察项：top-k belief 挤占（P1b 遗留验收）与夜审獭
   审核质量（生产首夜观察 reject 率）。
4. **退役条件？** 夜间审视下线时：删 seed 链 + functionRegistry 注册 + 编排文件 + 工具快照
   校验段（回退 P2a 形态）；consolidation_state 表与三迁移工具按 P2b1/P2a 各自退役条件处理。

## 首轮审视修复（审-1946，10 严重 + 1 建议全处置）

1. **快照校验语义损坏绕过**：合法 JSON 但 after/through 缺失/非法/倒挂时 Date.parse=NaN
   使比较恒 false 放行任意条目——`parseSnapshotRangeRaw` 纯函数 fail-closed 补全（含倒挂）。
2. **fyi 打回无执行体**：设计原文「不需要额外机制」漏了 belief 迁移工具层的通道——新增
   `belief_dispute` 工具（recorded/verified→disputed 单向，big 可见/small 不可见/
   night-reviewer 不含；不给核实权，信任模型不变），大獭按搭档「打回 M-xxx」裁决调用。
3. **失败重跑变更集丢审计**：变更集审计面从「当前仍 recorded」改为「区间全集（四状态
   拼接）」——上轮已迁移条目不丢审计、不丢 fyi 否决锚；全部迁移后崩溃的重跑正确补发。
4. **complete 先于 fyi 的吞错**：settle 顺序改为 fyi 先于 complete（report 失败可
   recordFailure 重跑补发）；matter 按 title 查重防重跑重复登记。
5. **召唤在 try 外**：CreateOtter/context 写入失败也走 recordFailure + finally 解散；
   dissolve 失败补 healing（孤儿受限写者可见）。
6. **timeoutMinutes 对 function executor 不生效**：编排内 `invokeWithTimeout`
   （240 分钟 race，超时放弃挂死会话）——scheduler 层的 function 通用超时留作后续机制。
7. **scheduler 三连败熔断先于 skip 分支**：recordFailure 返回 shouldSkip 时当次报
   healing 返回 skipped 不上抛——任务不熔断保持 active，次日新键新区间自然重试，
   未清失败区间起点保证水位覆盖（跳过≠丢审）。
8. **Golden Gate**：PR body 补豁免声明（prompt 为 usecase 层构造函数非 prompts/ 树；
   行为由单测钉住，端到端留生产首夜观察）。
9. **PR body 补特性编号**（B4 标识闭合）；11. **补署名尾行**。
10. **CI 闭环**：审视通过后补 review-closure 覆盖评论重跑（流程收尾）。

## delta 复审修复（审-1946 第二轮，4 严重 + 2 建议）

12. **补审计路径失败治理缺口**：pending=0 的 settle 原在 try 之外（补发再失败直上抛
    熔断任务）——统一进 try/catch（recordFailureOrSkip 治理覆盖两条路径）+ 用例钉证。
13. **Golden Gate**：搭档裁决（2026-11-19）——不豁免，本 PR 直接扩展 golden 框架支持
    受限档案獭测试：runner 新增 `restricted` 场景通道（按指定 otterType/systemPrompt
    建獭 + setup 钩子注入场景数据 + 直接 invoke 该獭，而非只测对话大獭）；新增首场景
    `night-review-full-processing`（直写 2 条 recorded belief + 快照范围写 context，
    断言每条必处置 + 不越受限工具面——判据经四/五轮演进为 DB 反查清单精确比对，
    见下节）；selftest 判别力通过（good ok / 四 bad 拒），真 LLM 采样 3/3 通过
    （glm-flash 端点；mimo 测试端点当日配额耗尽），记录已落
    data/metrics/golden-results.jsonl。
14. **文档主方案与代码同步**：主流程节改四状态全集 + fyi 先于 complete + 统一失败
    治理 + dispute 执行体；verify_by note 与验证计数同步。
15. **CI up-to-date 闸**：rebase 最新 main 重跑（流程收尾）。
16. **commit author 署名**：按 signature-convention 真相源改 `大獭 <noreply>`。
17. **matter 查重窗口**：repo 默认 50 条截断 → 调用侧显式 limit=1000（超出窗口的重复
    登记代价=搭档多闭环一条，非数据损坏）+ 用例钉证（60 条噪声后查重仍命中）。

## 四~六轮审视修复（审-1946：发现 18/19 与 CI 复发，golden 扩展落地后）

18. **证据数字与声明同步**（三轮首次闭环、五/六轮随断言演进复发后终闭环）：PR body
    与本文档的判据描述、selftest 形态、采样细节、回归计数随 head 演进同步——回归
    582（当轮实测）→ rebase main 9a8a2e07 后 586；capability 声明由「n/a 无断言面」
    改为指向真实 capability 场景文件（front-matter capability_test →
    tests/capability/golden/night-review-full-processing.golden.ts）。
19. **golden 断言判别力演进**（四轮发现、五轮对抗补全、六轮签收）：
    - 初版「迁移调用 ≥ 清单数」被同条重复处置骗过（四轮对抗实测假阳性）→ 改
      entry_id 去重 + speak 进判据；
    - 去重仍可被清单外幻觉 id 骗过（次数与去重达标但清单内全漏审）→ 终版改 DB
      反查本轮清单精确比对：scenarioIds 全覆盖（covered=清单数）+ 无清单外处置
      （offList 空）+ speak 收尾；
    - selftest 改 factory 形态：good（清单内 2 条各处置 + speak）+ 四 bad（漏处置 /
      同条重复+无 speak / 清单外 ghost-id / 越工具面 search_memory）全判 !ok；
    - 修正后真采样重跑 3/3 通过（#1 全 reject、#2 全 verify、#3 混合；每条 covered=2/2、
      offList 空、speak 收尾），golden-results.jsonl:770 留痕（:769 为 selftest）。
15'. **CI up-to-date 复发**（五轮发现、六轮 rebase 修复确认）：main 前移致闸再失败——
    rebase 至 9a8a2e07，586 回归复跑全绿（审-1946 六轮独立复核同值），CI 重跑闭环
    （review-closure 待审视覆盖评论后收尾）。

## 验证

- 单测 41 项全绿（编排 22 + 工具快照校验/dispute 13 + 白名单矩阵 2 + seed 3 + repo 1，含
  各轮审视修复场景的钉证用例），在 worktree 内跑。
- golden（restricted 通道首场景 night-review-full-processing）：selftest 判别力通过
  （good + 四 bad 全判别，golden-results.jsonl:769）；真 LLM 采样 3/3 通过（glm-flash；
  :770 留痕）。
- `npx tsc --noEmit`、`npx eslint`（改动文件）零错误；tests/usecases/scheduler +
  tests/interface-adapters/belief-migration-range-guard + tests/frameworks/agent/coding-tools +
  tests/frameworks/db/memory + tests/usecases/memory 全量 586 项通过（无回归；rebase
  main 9a8a2e07 后复跑，审-1946 六轮独立复核同值）。
- 端到端（真实 LLM 夜审会话）留生产首夜观察：首夜 03:00 触发后核对 healing 主对话的 fyi
  entry 与 matter 锚、consolidation_state settle 档、獭解散无残留。

## 部署注意

- 任务由启动 seed 自动创建（healing 门 on 的环境）；生产库 selfHealing=on（存量 healing 对话
  实证），重启即生效。
- 手动触发验证：scheduler 触发面或直接调 orchestrator（对话内不暴露工具——编排不是 agent
  动作面）。
