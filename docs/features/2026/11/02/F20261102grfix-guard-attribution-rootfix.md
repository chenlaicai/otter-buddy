---
id: F20261102grfix
title: 守卫观测修根：拦截点直标 ruleId（B 治本）+ guard_bounce_flow 口径拆分（A）+ 历史归因封存（C）
summary: |
  月度剪枝 G1/G2 两项搭档拍板治本做完整。三病灶修根：①B 拦截点直标——GuardBlock
  把 ruleId 与文案绑定在拦截判定源头（7 常量对象化对齐 v4 指纹表），落账直标
  assurance=direct，classify 文案反查降级为存量兜底，根治「文案一改指纹脱节」；
  ②A guard_bounce_flow 口径拆分——bounce 流程观测（865 条混入拦截口径虚增计数）
  独立类型，escalation 计数不再被流程记录污染；③C 历史归因封存——ACTIVE_RULE_IDS
  活跃清单显性化，v3 退役 ruleId 历史账单列不进剪枝候选（数据零改动）。全量 5605 测试过。
created_in_conversation: 98bd9fdd-8e28-4de8-b782-b59f46e733dd
date: 2026-11-02
tags: [guard, healing, attribution, observability, monthly-prune]
intent:
  problem: "守卫拦截归因靠文案特征片段反查（文案一改指纹表脱节，10-19/10-30 两次人工重对齐实证）；guard bounce 流程记录混入 guard_intercept 口径（865 条占无指纹 62%，虚增 escalation 拦截计数）；v3 退役规则的历史归因反复进月度剪枝候选"
  expected_effect: "新拦截事件 ruleId 由拦截块直标（context.assurance=direct），文案演进不再牵连归因；guard_bounce_flow 独立口径后 guard_intercept 归因纯净、escalation 计数不再被流程记录虚增；月度剪枝按活跃/历史分层，v3 退役规则历史归因单列封存、不再反复呈报"
  verify_by:
    type: behavior_check
---

# 守卫观测修根（F20261102grfix）

## 背景与来源

月度剪枝审视（2026-11 首轮）的 G1/G2 两项候选原拟「归口合并/核销」。搭档裁决（原话）：

> 「issue 这个你先别管，有专门 Issue 处理海獭在干活了；G1/G2 这两点，你不要只清理，你先深入排查下，从第一性原理出发，看看问题到底是什么，然后再来看如何解决」
> 「我要求治本做完整；历史账要原样保留、但一定是处理过，不要下次这几条又跳出来。我大概看懂，但咱们还是坚持第一性原理，解决方案也要做好做完整，不能凑合着过」

排查结论（三病灶，详见对话 2026-11-02 排查汇报）：

1. **口径混装**：「无指纹 1404 条」中 865 条是 guard bounce 流程记录（orchestrator.ts:801/1127），天然无 ruleId，被记成 guard_intercept 制造「观测盲区」假象——根因是流程动作与规则拦截共用一个 error_type
2. **归因键错位**：ruleId 靠 guard-intercept-classify 按文案特征片段事后反查——文案面向人（改写/动态前缀/多出口分裂）而归因键需机器稳定。实证链：09-30 PR 审视实测「文案不在表落 unknown」；10-19 文案抽取须人肉保锚片段；10-30 v4 重写后整表脱节重对齐（21→8 条）
3. **历史归因当噪音**：self_kill 4 变体 = 2 活（nonliteral/byname，v4 复用）+ 2 退役（indirect/script_stop，v3 历史）——历史按当时 ruleId 落库是正确设计（F20261030gcfbx 明确「无台账重分类路径」），合并即破坏归因；「尾部噪音」既视感来自消费侧未分活跃/历史

**预注册对照**（防事后编故事）：预期①「G1=指纹键不稳定」偏离——4 变体是 4 条真实独立规则的细分，变体是设计不是病；预期②「G2=出口漏接」部分反转——大头 865 条根本不是拦截，真拦截失配主因是机制前历史+文案漂移；预期③放弃条件未触发（10 月仍在失配，机制脆弱活着，但 open 账面为 0 无挂账）。

## 机制识别检查点判定（步骤 3，动手前完成）

清单命中 3 项边界项：①新增枚举值（error_type=guard_bounce_flow、ACTIVE_RULE_IDS 常量）④新增信号分类（bounce 独立类型）⑥新增决策分支（直标优先/classify 兜底，结果入 context）。

**论证（命中清单但不涉净新增机制，走①②③轻对抗路径）**：命中项均为既有机制的数据记录方式修正——守卫拦截行为本身（何时拦/拦什么/拦后语义）零变化，不产生新拦截决策、无新状态生命周期、无新持久化表/字段（context JSON 既有 key）；新枚举/常量只是给既有数据打更准的标签（ruleId 直标替代文案反查、bounce 与拦截分账），不新增任何「被记住并影响后续行为」的决策分支（escalation/bounce 判定逻辑零改动）。修法归属：B=①（缺源头标识补源头标识）、A=②（guard_intercept 口径收窄为纯规则拦截）、C=①（既有规则表补活跃/历史分层口径）。

## 设计面拍板（模块切分/关键接口/核心数据结构，大獭 L1 拍板）

### B · 拦截点直标（治本核心）

- **核心数据结构**：`GuardBlock { text: string; ruleId: string; layer: GuardRuleLayer }`（bash-safety-guard.ts）——文案与归因键同一常量绑定，文案可随意润色、ruleId 永不改，「改文案需同步 classifier」的病态耦合根除
- **关键接口**：
  - `checkBashCommandSafety(): GuardBlock | null`（原 string | null）——7 个拦截文案常量对象化（self_kill_main / self_kill_nonliteral / self_kill_byname / self_kill_process_group / cred_dir_access / network_exfil / download_exec，与 v4 指纹表 8 条逐一对齐）
  - `guardOnIntercept({ command, reason, ruleId?, ruleLayer? })`——拦截块直标传入
  - `buildGuardInterceptContext(..., directRule?)`——直标优先，classify 反查兜底（存量回溯/旧路径）；`assurance: "direct"` 标记归因来源（与 file-tool-guard 的 `assurance: "structured"` 先例同构）
- **模块切分**：guard 本体（判定+文案+ruleId 绑定）→ 落账 context（直标消费）→ classify（降级兜底）——各层单向依赖不变

### A · guard_bounce_flow 口径拆分

- bounce 三处落账（orchestrator 回发计数 :801 / 二拦终态 :1121 / 疑似误拦降级 :884）error_type 独立为 `guard_bounce_flow`（HealingErrorType 联合类型扩展）；severity 语义不变（medium/high 升级链保留）
- 消费侧：`countRecentGuardBounces` 双时代兼容计数（新口径 guard_bounce_flow + 历史 guard_intercept+context.bounce:true 合并——历史按当时口径落库，不重分类）；`recentGuardBounceEvents`（降级通道数据源）不用改——它按 context.ruleId 存在性过滤，bounce 事件本来就被排除
- **副产物**：escalation 的拦截计数（findRecentByOtter("guard_intercept")）不再被 bounce 记录虚增（此前 bounce 混入会误升 high）

### C · 历史归因封存（消费口径层）

- 数据零改动（历史按当时 ruleId 落库的既有设计保留）；消费口径分层：`ACTIVE_RULE_IDS`（FINGERPRINTS 表内 + file-tool-guard 前缀族）+ `isHistoricalAttribution(ruleId)`——表外 ruleId（v3 退役的 self_kill_indirect/script_stop/main_write/script_file_exec 等）为封存账
- monthly-prune-review.md 守卫层段补「活跃/历史分层口径」：封存账保留原样但单列展示、不进活跃候选、不再作为待归口/清理对象反复呈报
- self-healing-analysis.md 不改（该任务处置 open 事件，历史归因均 resolved、无候选面）——取舍留痕于本档

## 变更清单

| 文件 | 变更 |
|---|---|
| src/frameworks/agent/bash-safety-guard.ts | GuardBlock 类型 + 7 文案常量对象化 + 判定链返回值升级 |
| src/frameworks/agent/model-runtime-registry.ts | 拦截门消费直标（guardOnIntercept 带 ruleId/layer） |
| src/frameworks/agent/pi-session-factory.ts | hook 签名扩展 + buildGuardInterceptContext 直标优先/classify 兜底 |
| src/frameworks/agent/guard-intercept-classify.ts | ACTIVE_RULE_IDS + isHistoricalAttribution + 维护契约注释（降级为兜底） |
| src/usecases/conversation/agent-turn-orchestrator/orchestrator.ts | 3 处 bounce 落账 error_type → guard_bounce_flow |
| src/usecases/conversation/agent-turn-orchestrator/types.ts | HealingEventInput.errorType 联合扩展 |
| src/entities/healing/healing-event.ts | HealingErrorType 联合扩展 + 口径注释 |
| src/interface-adapters/agent-runtime/circuit-break-support.ts | countRecentGuardBounces 双时代兼容计数 |
| prompts/scheduled/monthly-prune-review.md | 守卫层「活跃/历史分层」口径 |
| src/frameworks/agent/kill-block-messages.ts | 删除（deletion）：v4 重写后生产代码零引用的死文案源，两处同名常量不同文案是拷贝漂移温床。⚠️ 提交粒度留痕：该删除因 git rm 的 staged 状态随 commit 1 一并提交，其 Modification-Class 为 deletion（与主声明 narrow-fix 异类）——PR 描述同步声明，不重拆历史的依据：拆分收益 < 重跑 3 轮 pre-commit 门禁（全栈 check）的时间成本 |
| tests/（4 个测试文件） | GuardBlock 断言适配 + 直标/反查双轨一致性断言 + bounce 新口径断言 |

## 验收标准（断言化）

| 场景 | 操作 | 预期结果 |
|---|---|---|
| 直标归因 | `npx vitest run tests/frameworks/agent/guard-intercept-classify.test.ts` | 全过；expectClass 双轨断言（block.ruleId === classify(text).ruleId）全绿 |
| 回放无回归 | `npx vitest run tests/guard/replay/replay.test.ts` | 全过（误拦实录全放行 + must-block 全拦） |
| bounce 口径 | `npx vitest run tests/interface-adapters/agent-invoker-guard-bounce.test.ts tests/interface-adapters/agent-invoker-circuit-retry.test.ts` | 全过；bounce 落账断言 guard_bounce_flow |
| 全量无破坏 | `npx vitest run` | 424 文件 / 5605 测试全过 |
| 新事件直标率 | 生产运行后 `SELECT json_extract(context,'$.assurance') FROM healing_events WHERE error_type='guard_intercept'` | 新事件 assurance=direct 占比 100% |
| 剪枝口径生效 | 下轮 monthly-prune-review 执行 | 候选不含 v3 退役 ruleId（封存账单列） |

## 最简实现检查

已过阶梯（仓库已有实现优先）：直标复用 file-tool-guard 的 assurance 标记先例（未新造标记体系）；C 零数据迁移（复用「历史按当时口径落库」既有设计，只加消费口径）；A 双时代兼容用既有 context.bounce 标记（未加迁移脚本/新字段）。无新依赖、无新表/字段。**未采用的更简形态**：「只改 classify 表补条目」（治标——文案再改再脱节，搭档明确否决凑合）；「GuardRuleClass 加 status 枚举」（比 ACTIVE_RULE_IDS 集合复杂且语义差——retired 是表外自然状态非表内枚举）。结论：已最简。

## 负面向验收（本次破坏了什么旧契约/绕过了什么既有保护）

- **破坏的旧契约**：①`checkBashCommandSafety` 返回 string 的签名（3 个内部函数 + 2 个测试同步升级）；②「bounce 记 guard_intercept+context.bounce:true」的落账口径（历史数据保持旧口径，消费侧双时代兼容）；③「分类是拦截时点行为」的单轨归因（变为直标主路+反查兜底双轨）
- **绕过的保护**：无——classify 文案反查完整保留（兜底能力不降级）；「历史事件不重分类」的既有设计（F20261030gcfbx）完全遵守；escalation/bounce 判定逻辑零改动
- **兼容风险**：countRecentGuardBounces 双时代查询漏一侧会少数 bounce——测试 GB-3 以历史形态 seed 验证兼容分支计数正确

## 影响面当场自检

- **同步了的**：monthly-prune-review.md 口径（本次内）；guard-intercept-classify.ts 维护契约注释（增删规则须同步剪枝口径清单）
- **隐含变化已声明的**：daily-health-check.md 的 guard_intercept 样本池隐含变纯（bounce 拆出后样本不再混流程记录——改善而非恶化，bounce 无 ruleId 本就无法固化），无需改 prompt，留痕于此防后续困惑（检视发现 9）
- **失效但不回改的（历史文档铁律）**：F20260930gslog「classify 从文案分类 ruleId」的机制描述、F20261030gcfbx「活文案清单」指向——已由本档追加说明取代；宪法（bash-guard-constitution.md）未动（活跃/历史分层是聚合口径非规则治理规则，留给未来宪法修订统一收编——取舍留痕于此）
- **决定不做的**：self-healing-analysis.md 口径（无候选面）；宪法文档补封存账概念（见上）

## 检视处置记录（首轮对抗审视，检视獭：较真）

| 发现 | 级别 | 处置 |
|---|---|---|
| 1. CI 红（分支 behind main） | 严重 | 已修：merge origin/main（1e9024c7） |
| 2. B8 体积预算（monthly-prune 净增 1033B>500B 无申报） | 严重 | 已修：PR 描述补体积申报段（口径文字为规则清单+分层原则必要最小面） |
| 3. B7 Golden Gate 记录缺失（60 SKIP=零记录） | 严重 | **呈搭档裁决项**：环境无 LLM 端点非本 PR 可解，已留显式豁免声明与裁决请求（非默认放过） |
| 4. flow 侧计数无判别性测试 | 严重 | 已修：补 GB-3c（新口径 seed×2 → 超限升级判别用例） |
| 5. flow 侧不按 bounce:true 过滤语义未声明 | 建议 | 已修（选更精解）：双侧对称过滤 bounce:true（仅回发计数计入），语义回归「回发次数」本义 |
| 6. isHistoricalAttribution("unknown") 封存吞补表信号 | 建议 | 已修：unknown 显式不封存 + 三分注释 + 边界断言 |
| 7. 双清单无机械同步 | 建议 | 已修：补一致性测试（prompt 清单 ↔ ACTIVE_RULE_IDS 机械比对） |
| 8. monthly-prune 参考 SQL 未过滤历史 bounce | 建议 | 已修：SQL 加 `bounce IS NOT true` 过滤 |
| 9. daily-health-check 隐含口径变化未声明 | 建议 | 已修：本档「影响面」段声明 |

## 回滚

纯 git revert（无 DB schema 变更、无数据迁移）；历史数据从未被改写。revert 后 guard_bounce_flow 新事件需消费侧注意（revert 后又写回 guard_intercept）——生产无残留风险（事件只增不改）。

🤖 Generated with [Otter Buddy](https://github.com/chenlaicai/otter-buddy) by 大獭
