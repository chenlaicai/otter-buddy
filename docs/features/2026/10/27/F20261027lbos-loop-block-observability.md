---
id: F20261027lbos
title: 循环硬熔断门拦截观测补强：loop_tool_block 落账 + 体检消费段 + 阈值告警
summary: 搭档反馈「不要依赖人类观察提醒，系统必须自证」（2026-10-27）——#1655 合入后 loopBlockGuard 门拦截与 S1 复犯拉黑零落账，b2 残余误伤面（#1653 D1-1）不可观测。本 PR：门拦截经 ALS store 钩子落 healing（loop_tool_block，errorType 枚举扩展 + 环境类分账），签名级去重防淹漫；体检新增「循环熔断拦截观测段」（计数/误拦判别/阈值告警/处置/全景行），检查清单加第 13 项。
change_type: fix
created_in_conversation: f26fe9d5-6a2f-485d-a079-b70afd5722f7
causal_links:
  - "#1656（本修复的 issue 载体）"
  - "F20261027cbfp（#1655，b2 复犯拉黑的引入——本 PR 补其观测面）"
  - "#1653（D1-1 残余误伤面的发现与显式取舍）"
  - "#1399（签名区分度治本，上游）"
tags: [circuit-breaker, observability, healing, health-check]
modules: [src/frameworks/agent/model-runtime-registry.ts, src/frameworks/agent/pi-session-factory.ts, src/entities/healing/healing-event.ts, prompts/scheduled/daily-health-check.md]
intent:
  problem: 熔断门拦截（loopBlockGuard）与 S1 复犯拉黑零观测——历史 8 天 239 次拦截只活在 session 转录，b2 残余误伤面（D1-1）真实发生率不可知，搭档明确反馈系统必须自证拦截面不依赖人类观察
  solution: 复刻 bashGuardGate→guardOnIntercept→healingRepo 既有模式接入第二数据源：门拦截签名级去重落 healing（loop_tool_block）+ 体检每日消费（计数分布/误拦判别/阈值告警/全景行）
  verify_by:
    type: static_only
created_at: 2026-10-27
---

# F20261027lbos：循环硬熔断门拦截观测补强（#1656）

## 1. 问题

PR #1655（F20261027cbfp）合入后，熔断防线的拦截面分三层观测状态不均：
- terminate（strike 涨满）✅ 落 healing（circuit_break 事件）
- **tool_call 门拦截（loopBlockGuard）❌ 零落账**——纯同步函数返回 block 无任何记录，历史 8 天 239 次拦截只活在 session 转录，体检失明
- **S1 复犯拉黑（repeatOffender 写 Map）❌ 零落账**——恰是 D1-1 残余误伤面（同型不换序列流每签名 2 次拉黑，检视实测 57% 调用被拦）的发生点

搭档明确反馈：不要依赖人类观察提醒——系统必须自证拦截面打得准不准，否则 P2 决策（拉黑上限/TTL）无数据支撑。

## 2. 机制判定（动手前完成）

机制识别清单七项：**新增 errorType 枚举值**（loop_tool_block）命中「新增持久化 schema 值」边缘——但它是既有 healing_events 表既有列的既有语义扩展（errorType 联合类型 +1），无新表无新列无迁移，与 guard_intercept（F20260831aksp）完全同型。按既有语义内修（①）处理：观测通道复刻 bashGuardGate → guardOnIntercept → healingRepo 既有模式，新增的只有数据类型值。清单显式论证：不涉净新增机制，是既有观测框架的第二个数据源接入。

Modification-Class: `narrow-fix`

## 3. 实现

### 门拦截落账链（复刻 guardOnIntercept 模式，三处）

1. **OtterInvokeContext 扩两个字段**（model-runtime-registry.ts）：`loopBlockOnIntercept?: (input: {toolName, signature, reason}) => void`（落账钩子）+ `loopBlockLoggedSignatures?: Set<string>`（签名级去重集，与 loopBlockedTools 同生命周期）
2. **loopBlockGuard 拦截时上报**：命中签名且未落过账 → 懒初始化去重集 → 调钩子（try-catch，落账失败不阻断拦截——fail-open 观测）。**签名级去重**：同签名多次拦截只落首次，防高频拦截淹漫 healing 池（历史峰值单 session 15 次）
3. **pi-session-factory 建 hook**（buildLoopBlockInterceptHook）：healingRepo.create（errorType=loop_tool_block, severity=medium, context 含 toolName/signature 前 120 字符/reason），fire-and-forget；repo 缺失返回 undefined（拦截照常，观测降级）

### 枚举扩展（healing-event.ts）

- HealingErrorType + 'loop_tool_block'，注释写明与 circuit_break 的分界（terminate 杀 invoke vs 门拦工具不杀 invoke——处置方向不同：误拦排查 vs 行为纠正）
- HEALING_ENVIRONMENT_TYPES 收录（#998 二维分账：系统保护动作归环境，同 circuit_break 口径——拦的是工具不是獭能力失败）
- 全枚举覆盖测试 15→16 同步更新

### 体检消费（daily-health-check.md）

新增「循环熔断拦截观测段」五步：昨日计数与分布（含 0 条也是数据）→ 误拦/真复犯判别（旁证=拉黑后同 invoke 有 speak/yield 求援或换工具正常推进）→ 阈值告警（单日 >20 标红：b2 残余面失控早期信号）→ 处置（误拦同工具 ≥3 天复发开 issue 标 #1399 关联）→ 熔断全景行（门拦截 N｜terminate J 两层防线一眼可见）。检查清单加第 13 项。

## 4. 取舍

1. **去重粒度选签名级而非次次落账**：门拦截的本质是「同一条拉黑标记的重复触发」，次次落账会把 1 次拉黑放大成 N 条事件（历史峰值单 session 15 次拦截），信噪比劣化。去重集与拉黑集同挂每次 execute 的 ALS store，因此 N=「execute × 被拦截签名」的去重事件数，不是昨日拉黑签名总数，也不是拦截次数；跨 execute 再撞同签名会再落一条，已在体检操作段写明。
2. **severity 固定 medium 不做频次升级**（guard_intercept 有近 6h ≥3 次升 high 的机制）：门拦截已在检测器侧有 strike/repeatOffender 两级升级，healing 侧再叠频次升级会与 terminate 事件的 high 重复计数。体检段的「单日 >20 标红」承担告警职责。
3. **落账点在门（tool_call 层）而非检测器**：repeatOffender 写 Map 时也可以落账，但门拦截是「拉黑实际生效」的确证点（Map 写了但獭可能再没调过该签名=零伤害），在门落账能区分「标记了」与「真的拦了」。

## 5. 验证

- 失败证据链：新增用例「拦截时调 loopBlockOnIntercept 钩子」修复前红（类型不存在，TS 编译期即失败）→ 实现后绿；「去重」用例暴露第一版懒初始化缺失 bug（5 次全落账）→ 修正后绿
- 行为断言：拦截→钩子带签名/工具名/理由 ✓；speak/yield 豁免不落账 ✓；未命中不落账 ✓；钩子缺失拦截照常 ✓；同签名去重 ✓
- factory 层 payload：errorType/severity/context、签名 120 截断、repo 缺失降级、repo 拒绝 fail-open 且保留 warn 日志 ✓
- 全量回归（c015e00b，同步 #1659 前基线）：445 文件 7059 passed，tsc 零错误；同步最新 main 后复跑关键验证，结果见 PR Verification
- 既有测试更新 1 处：healing 全枚举覆盖 15→16（枚举 +1 的机械同步，断言语义不变）
- 最简实现检查：复用既有 healingRepo + ALS 生命周期，无新表/新定时任务；factory 钩子仅提出为可测导出函数，不另建抽象层，已过最简检查
- 负面向验收：不关闭拦截、不改变 terminate/逃生口语义；观测写失败仅降级并记 warn，不覆盖原拦截结果

## 6. 影响面与遗留

- **数据面**：上线即开始积累 loop_tool_block 样本；首个 24h 体检将给出 b2 残余面的第一份真实数据（此前只能靠检视獭离线复现）
- **体检既有段**：受 budget_bytes=10750 硬预算约束，新增观测段（~740B）需等量出清。出清两轮（检视 S1 证伪第一轮声明）：
  - 第一轮（commit 461087f9）：压缩 9 段后被检视逐段 diff 证伪「无损」——4 处判定/处置语义被删（:18 hook fallback 失衡计入异常、:87 不成立提 issue/无理由 halt 提 issue、:82 逐条仅限异质、:96 缺声明照判缺记录）+ 7 处轻量删改（检视 A3 清单）。教训：lint:criteria 12/12 只整 12 条登记子串，佐证不了未登记子句的存留。
  - 第二轮（0f7e0087/c015e00b）：恢复 S1 四处 + A3 ①②⑤ + 不变式子句，出清源改为解释性内容与清单去重。
  - 第三轮（同步 #1659 后作者逐项对照）：恢复首轮清单外被带走的操作约束（本系统边界、同模型样本改派、RHI 不处置率公式、checklist 完整计数、dirty 不自动删、守卫复跑命令、golden 应落账类型）；execute 量纲替代含混 turn。只删重复解释换预算，未提高 budget_bytes；budget 0 超预算 + criteria 12/12 + discipline 7/7 复验。
- **不影响**：拦截行为本身（钩子 fail-open）、terminate 落账、guard_intercept 生态、体检段判定语义（已恢复+双闸验证）
- **遗留**：误拦判别目前靠体检獭逐条人工核对 context + 同 invoke 转录对照——样本量大后可自动化，先人工验证判别准则；仓库级灰窗（change_type=fix 无 intent 可静默过 lint）→ 检视建议另行评估，非本 PR 处置项
- **关联**：#1399（签名区分度治本）仍是误拦率根本解，本 PR 只保证「知道有多少误拦」
