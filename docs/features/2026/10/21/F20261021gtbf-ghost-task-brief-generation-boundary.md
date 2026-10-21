---
id: F20261021gtbf
title: 幽灵工单根因治理——任务简报世代边界（换世时效核验 + 身份文案时效纪律）
summary: restart 后旧 systemPrompt 任务段照进新世已五次流通（M-1326410e）。机制链三环：otter_config.systemPrompt 召唤时写死无世代边界 + restartSession 只更新 modelAlias 原样沿用 + SMALL_OTTER.md「先把这件事干好」无条件服从句。修法双层防御：机制层（buildMessageWithContext 换世首轮随 sessionSummary 注入「任务简报时效提醒」，首世/非首轮不注入）+ 模板层（SMALL_OTTER.md 加时效纪律）。机制识别检查点全否，narrow-fix。
capability_test: "n/a: 注入面文案与消息拼装逻辑变更无对外行为契约——session-helpers 5 新增用例（放行/拦截/顺序/锚点）+ 消费方 63 例 + capability 重启獭生套件 + 全量 6554 passed 零失败。golden 豁免声明（沿 #1318/#1377 先例，F20261014gvbx 对账口径）：本 PR 不涉 golden_replay 断言面，golden-results.jsonl 无本 PR 记录系按设计不落账而非漏跑，不计缺记录"
change_type: fix
intent:
  problem: "M-1326410e（2026-10-15 立）：restart 后旧 systemPrompt 任务段带进新世，已五次流通（10-08 P0-1/P0-2 工单经三代 restart 照进 10-15/10-19/10-20 各世，每次都被新世 LLM 人工核对拒收才没出重复 PR——拒收靠自发，机制零防线）"
  expected_effect: "换世首轮 user 消息含「任务简报时效提醒」段（buildMessageWithContext 断言 toContain）、首世/非首轮消息不含（断言 not.toContain）；SMALL_OTTER.md 含时效纪律句（文本在案可查）——幽灵工单处置从自发行为变为有机制指令依据，重复 PR 风险在开工前被显式核验环节拦截"
  verify_by:
    type: capability_test
modules:
  - src/frameworks/agent/session-helpers.ts
  - prompts/identity/SMALL_OTTER.md
from: []
created_in_conversation: 7b41e085-5c21-4bd1-adfe-dc3ef051753d
created_by: 守卫修复獭
---

## 问题与机制链（M-1326410e，五次流通实证）

**现象**：restart 后的新世 systemPrompt 仍带前世任务段（如 10-08 派工的「bash 守卫 P0 双链统一 + 熔断降级」），新世照单开工 = 对已合入修复（PR #1360）重开重复 PR。五次流通实证（10-15/10-19/10-20 各世，git log 与记忆条目在案）均靠新世 LLM 手工核对拒收（如 2026-10-20 拒收实证：worktree 不存在 + P0-1/P0-2 已由 F20261008gduc 交付 + 基线数字系 10/08 旧数）。

**机制链三环（逐环 file:line 实证）**：

1. **写死无世代边界**：`create_otter(name, systemPrompt)` 把大獭派工文本写进 `otter_config.systemPrompt`（tool-factory.ts:507 / otter-controller.ts:78）——任务段与职责段混合的自由文本，无 createdAt/世代标记
2. **换世原样沿用**：`restartSession`（manage-session.ts:214）归档旧 session → createSession 新世，只更新 modelAlias（:233-239），**systemPrompt 不动**；`before_agent_start` 钩子每轮把 config.systemPrompt 拼进 systemPrompt（model-runtime-registry.ts:125 / buildBeforeAgentStartResult:283）——旧任务段照进新世
3. **无条件服从模板句**：SMALL_OTTER.md「那是你的本职工作，先把这件事干好」——无时效校验义务，LLM 只能靠自发警觉拒收

**已排除路径**：
- restart 时机械剥离任务段（B）：systemPrompt 是自由文本，任务段/身份段无结构化边界，机械剥离不可靠且会误伤职责段
- 结构化派工单（D，task brief 带 status 数据层治理）：改 create_otter 契约 + 全部召唤方书写方式，工程量与扰动大；且派工是 LLM 自由文本，强结构化收益存疑——留作后续演进方向不入本单
- 只修模板不修机制（单层）：模板句每轮都在但换世场景缺「此刻必须核验」的场景化指令；只修机制不修模板：非换世场景（大獭忘记更新派工）无兜底——两层互补缺一不可

## 修法（narrow-fix，机制识别检查点全否）

机制识别检查点逐项：新增配置字段/枚举/开关 ❌（固定文案常量无配置）｜新增状态生命周期 ❌｜新增定时任务/后台进程 ❌｜新增信号类型/消息格式 ❌（消息内追加固定文案段，无新 schema，与 healingAlerts/signalAlerts 同型）｜新增持久化存储 ❌｜新增决策分支 ❌（sessionSummary 既有分支内追加，无新分支）｜新增跨模块调用路径 ❌。→ 修法决策树①（既有机制语义内修）。

**修 1（机制层，主修）**：`src/frameworks/agent/session-helpers.ts` `buildMessageWithContext` 的 sessionSummary 分支追加 `TASK_BRIEF_FRESHNESS_REMINDER`（任务简报时效提醒：对照交接档案中的任务状态/下一步指引与未闭环事项（matters）核实→已交付拒收附证据→仍有效开工）。**段名泛指措辞（检视獭1585 建议 S2 采纳）**：不引用具体段名——七段合成档案的「① 下一步」与机械降级档案（含熔断 synthesizePast=false 路径）的「① 交接意图书」段名不同，泛指「任务状态/下一步指引」两种形态都兜住。注入条件复用「sessionSummary 存在 = 换世」判定：首世无档案不注入（任务简报是新鲜的），换世首轮注入（isFirstTurn 门保证，不逐轮堆积——F20260922ctxi 防堆积口径）。文案系注入面，不含 F/R 编号锚点（lint-prompt-anchors 口径，测试固化）。

**修 2（模板层，辅修）**：`prompts/identity/SMALL_OTTER.md` 时效纪律句——「先把这件事干好」后补「但任务简报有派工时效：若交接档案/对话历史/产物台账显示已交付/被撤/过期（幽灵工单），以现实为准拒收并附证据」。作用面：非换世场景（派工文本过期但没换世）也生效。BIG_OTTER.md 未改（大獭文案无「本职工作」无条件句；机制层对大小獭普适——buildMessageWithContext 系 invoke 统一链路）。

**换世判定的边界（诚实声明）**：「sessionSummary 存在 ⟺ 换世」在极端场景（首哑复活 + 零机械供料档案为空）会漏注入机制层提醒——此时模板层纪律（修 2）兜底。两层防御互补，无单点。

## 影响范围

- 行为变化：换世首轮 user 消息尾部多一段固定文案（约 300 字符）；首世/非首轮消息零变化
- 大小獭普适（invoke 统一链路），scheduler/熔断/水位交接各换世路径均覆盖（都走 buildMessageWithContext）
- 不动数据结构、不动 restart 流程、不动 systemPrompt 存储

## 验证

- **放行侧**（该注入的注入）：带 sessionSummary → 含提醒段 ✓（5 用例之 1/4）
- **拦截侧**（不该注入的不注入）：无 sessionSummary / 无 dynamicContext → 不含提醒段 ✓（用例 2/3）
- **顺序不回归**：会话摘要 → 提醒 → 用户消息殿后 ✓（用例 4）；文案无编号锚点 ✓（用例 5）
- 消费方回归：agent-invoker-mahjong-d2 / cursor-zero-guard / dispatch-chain-engine 63 例全绿
- capability 重启獭生套件（真系统）通过（build 后 3 skipped 系环境门控）
- 全量 vitest 410 files **6554 passed + 6 skipped 零失败**
- tsc/eslint（pre-commit check 链）通过

## 残余记档

- 大獭身份文案（BIG_OTTER.md）未加同款时效纪律句（无对应无条件句，机制层已普适覆盖）——如大獭侧出现幽灵任务实证再补
- 结构化派工单（task brief 带 createdAt/status 的数据层治理）是治本方向，本单不推——派工书写契约涉及全部召唤方，需单独论证
- 五次流通实证的系统性收口还包括派单闭环（M-12b165a7「接单≠落位」），与本单互补（本单管「任务过期被照做」，M-12b165a7 管「任务接了没人做」）
