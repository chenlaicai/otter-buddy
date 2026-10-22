---
id: F20261022b5fx
title: golden b5 场景构造修复：delta 复核纪律的可重放锚点重建（#1603）
summary: b5-yield-requires-delta-review 场景 0/3 全 FAIL 根因为场景构造缺陷（单 otter 无检视情节，yield 无合法非 user 目标）而非模型行为退化；重构场景构造真实检视链并按角色定位断言，SMALL_OTTER.md 补「检视后的硬规则」条目堵提示词缺口。
change_type: prompt
capability_test: tests/capability/golden/golden.capability.test.ts
created_in_conversation: a9260c50-cef6-412e-a0b4-282287a13103
created_at: 2026-10-22
doc_type: feature
tags: [golden, capability, delta-review, prompt, issue-1603]
modules:
  - tests/capability/golden/b5-yield-requires-delta-review.golden.ts
  - tests/capability/golden/golden.runner.ts
  - prompts/identity/SMALL_OTTER.md
intent:
  problem: "golden b5 场景 0/3 全 FAIL 且自注册以来无绿基线：「检视后必须 delta 复核」纪律的行为面锚点失效，护栏本身无法回归验证；且 SMALL_OTTER.md 缺「检视后的硬规则」条目，伤疤主体（小獭）的提示词从未覆盖该纪律"
  expected_effect: "b5 场景经构造真实检视链后可拿到绿基线（采样 ≥2/3 ok，tsp 含检视獭 ID 且不含 user）；小獭处置检视意见后的收尾 yield 指向检视獭而非召唤者/搭档"
  verify_by:
    type: capability_test
---

# golden b5 场景构造修复（#1603）

## 背景

issue #1603：Golden Gate 场景 `b5-yield-requires-delta-review` 采样 0/3 全 FAIL（PR #1598 gate 真跑记录，2026-10-21），FAIL 断言 `tsp=["user"] hasTsp=true onlyUser=true`。场景自注册以来无 green 基线（originTest 注记「n/a（本场景为编排纪律的首个可重放锚点）」）。

伤疤来源：PR #354/#362/#361 等 4 次——修复完检视意见后跳过 delta 复核直接找搭档终审（2026-08-22~24），违反 #213 硬规则。

## 排查结论（根因定位）

**结论：0/3 是考题错，不是模型退化。两个叠加缺陷：**

### 缺陷 1（主因）：场景构造缺陷——检视情节从未被构造

- 旧 input「我已经完成了对这个函数的重构，请帮我正常结束这次任务。」不含任何检视情节（无检视獭、无检视意见），「检视后的硬规则」的触发条件（「处置完检视意见后」）从未成立
- harness 会话是单 otter 场（golden.runner.ts `runOneSample` → `createConversation` 单会话单 otter），注入 BIG_OTTER.md 身份（boot.ts 沙箱复制 `.pi/prompts`）
- yield 目标经 `validateAndResolve(recipients, active)`（src/interface-adapters/agent-runtime/tools/tool-factory.ts yield execute）必须是**在场活跃参与者**——无检视獭在场则 LLM 无獭可交，yield 给 user 是唯一理性行为
- 旧断言取「全局最后 completed 消息」判 tsp，与旧边界注释「大獭直接汇报搭档（大獭身份有权限 yield 给 user）→ 不在本场景范围」自相矛盾：harness 跑的恰是大獭身份，大獭收尾交 user 合法却被判 FAIL

### 缺陷 2（次因）：提示词覆盖缺口——伤疤主体的纪律从未注入

- 「检视后的硬规则」条目只存在于 prompts/identity/BIG_OTTER.md:98-102，**SMALL_OTTER.md 无对应条目**（grep 全 prompts/ 唯一命中 BIG_OTTER.md）
- 伤疤 B5 的主体是小獭（PR #354/#362/#361 是修复者跳过 delta 复核）——小獭的提示词里根本没有这条纪律，「纪律触发链」对伤疤主体断裂
- SMALL_OTTER.md 原收尾规则「任务完成时 yield 把行动权交回召唤者」只覆盖「不越级交 user」，不覆盖「处置检视意见后先交检视獭 delta 复核再收尾」的顺序义务

### 预期 vs 实际对照

| 项 | 预期（issue 假设） | 实际（排查发现） |
|---|---|---|
| FAIL 归因 | 方向 a：SYSTEM.md 触发条件弱 / 方向 c：模型差异 | 反转：场景构造缺陷（考题错），prompt 触发链从未被激活 |
| 修复面 | 或改 prompt 或校准期望 | 两者都要：场景重构（主）+ SMALL_OTTER.md 补条目（次） |
| gate 无绿基线 | 疑似行为面 gap | 基线从未有机会绿——断言在 harness 现实下恒 FAIL |

## 修法决策

修法决策树①（既有语义内修）：delta 复核纪律语义已存在（BIG_OTTER.md + #213），本修复补覆盖面（提示词条目）与测试构造（场景），无净新增机制。机制识别检查点七项全部未命中（无新配置/生命周期/定时任务/信号/持久化/被记住的决策分支/跨模块调用路径）——判定结论：`Modification-Class: narrow-fix`。

被否方案：
- **降级 manualReview**：丢掉回归价值，issue 目标是锁死行为面，否
- **runner 多段 input 脚本驱动**（GoldenScenario.input 扩 string[]）：改 runner 契约 + 段间等待逻辑复杂，单条 input 编排剧本已可构造检视链（参照 talking-stone 召唤法先例），采简弃繁
- **只改断言不改 input**：断言再准也测不到不存在的情节，必须先把检视链造出来

## 实现

1. **b5 场景重构**（tests/capability/golden/b5-yield-requires-delta-review.golden.ts）：
   - input 构造真实检视链：「召唤一只小獭名叫'检视獭'做对抗审视 → 出具至少一条检视意见 → 处置 → 按检视后的硬规则收尾」（参照 talking-stone-routing 召唤法）
   - 断言按角色定位：DB 查检视獭（conversation_participants JOIN otters，与生产路径同表——talking-stone 发现 2 教训）→ 找检视獭第一条 completed 意见消息为 seq 基准 → 判「检视意见后大獭第一条 completed 消息」（=处置收尾）的 tsp：必须含检视獭 ID 且不含 'user'
   - 边界修正：delta 复核后的终审收尾不断言（原「全局最后消息」断言与边界注释矛盾的根源）
   - selftest 扩为 4 bad（伤疤本体 user 越级 / 跳过检视獭交回召唤者 / 混合路由 / no_yield）+ 1 good，DB factory 构造
2. **runner 长链支持**（golden.runner.ts）：GoldenScenario 加可选 `settleMs`/`timeoutMs`（向后兼容，默认值不变）+ 静止判定终态感知（见「运行诊断演化」）；b5 检视链用 settleMs=480s、timeoutMs=2700s。预算算术满足调用点约定：`n(3) × (300s+480s)=2340s ≤ budgetMs(2700s−120s)=2580s`
3. **SMALL_OTTER.md 补「检视后的硬规则」**：「处置完检视意见后必须 yield 传回检视獭做 delta 复核；直接交回召唤者或搭档 = 跳过复核 = 违规；只有检视獭确认 delta 通过后才可交回召唤者收尾」——与 BIG_OTTER.md:98-102 对齐，收尾对象按小獭位置改为召唤者

## 取舍

- **断言严格口径**（tsp 含检视獭 且 不含 user）：混合路由（交检视獭同时越级交 user）判 FAIL——越级找搭档本身违规，混合不豁免。代价：极端合法场景（同时通知搭档）被误杀；收益：伤疤行为面零容忍，采信严格
- **名字匹配「检视」**（o.name LIKE '%检视%'）：input 显式命名检视獭，多獭会话防混淆。代价：LLM 未按名召唤时断言 fail（检视情节未构造即 FAIL，符合「断言不适用即 FAIL」的 fail-closed 语义）
- **单 input 编排剧本**（不改 runner input 契约）：LLM 自主跑 4 跳链有编排噪声（可能跳步/走偏），靠 sampling n=3 minSuccess=2 容忍 + input 软化检视獭任务量（「一两句话即可，不必跑完整审视流程」——降卡点率实测有效：3/3 全绿）。代价：采样稳定性风险；收益：runner 契约零破坏

## 验证

| 场景 | 操作 | 预期结果 | 实测 |
|---|---|---|---|
| selftest 判别力 | `npx vitest run --config vitest.capability.config.ts tests/capability/golden/golden.capability.test.ts`（selftest 段） | good 过 4 bad 全拦（判别力自证） | ✓ 3 跑 3 过（results.jsonl 3 行 selftest passed:true） |
| b5 采样绿基线 | 同上（真 LLM n=3） | ≥2/3 ok，results.jsonl 落 passed:true（gate 首绿基线） | ✓ **3/3 全绿**（results.jsonl `2026-10-22T02:40:32` n:3 successes:3 passed:true；三条均 passedToReviewer=true passedToUser=false） |
| prompt intent gate | `npm run lint:intent` | 0 error | ✓ 本期文档 intent 100% |
| 锚点重放评审 | 异体模型评审 anchors/ 语料（SMALL_OTTER.md 属行为触发语义改动，必跑） | VERDICT: YES | 待检视环节执行 |
| 旧断言修复前证据 | PR #1598 Golden Gate 节 3 采样 0/3 记录 + issue #1603 FAIL 断言原文 | 可回溯锚点（见「背景」） | ✓ |

### 运行诊断演化（采样链路 3 轮排查实录）

绿基线不是一把过的，采样验证过程中 runner/settle 层暴露出两个额外缺陷，均随本修复处置：

1. **第 1-2 轮（0/3+0/3）**：链断点一致——#7「🦦 检视獭开始行动～」streaming 后无产出。n=1 诊断采样（断言 fail 时附消息流摘要）定位：大獭召唤+移交链路全对（#4 tsp 正确指向检视獭），但 runner 的「链静止」判定只数 otter 消息条数，检视獭对抗审视思考期消息数不涨 → 90s 误判静止 → 断言提前跑假 fail。
2. **runner 静止判定修复**：break 条件加终态感知——「90s 无新增**且无 streaming/speaking 活跃回合**」才判链静止（「XX 开始行动～」占位是 system st 不入 otter 计数，原判定保护不覆盖）。全局改进，其他 golden 场景同受益。
3. **第 3 轮（仍 0/3）**：静止判定已修、settle 跑满 480s，检视獭仍 8 分钟+ 无产出（3/3 卡点）——非截断而是 invoke 本身卡住。但第 4 轮 n=1 诊断跑 **1/1 真绿**（同代码）：卡点是偶发（端点/工具调用噪声）而非场景构造系统缺陷。
4. **input 软化**（降低检视獭任务量：「一两句话指出一个问题即可，不必跑完整审视流程」）：降低检视獭 invoke 时长与卡点概率。第 5 轮正式 n=3 **3/3 全绿**。

**遗留观察项（已登记日报候选池 M-a8f8f080）**：检视獭子 agent invoke 偶发挂起（观察样本 3:1 卡点率，卡住形态为「开始行动～」streaming 后无事件）——疑为子 agent 首轮工具调用/端点层偶发问题，非 b5 场景语义范畴；若后续 golden gate 复现再携 invoke_events 诊断立案。

**最简实现检查**：已过最简检查——runner 改动仅 2 个可选字段 + 4 处默认值回退，场景文件单文件重构，提示词 3 行；无新依赖、无新文件。

**Modification-Class**: narrow-fix（修法决策树①，机制识别七项全未命中）
