---
doc_type: feature
id: F20260929tdrv
title: 工具 description 合理性审视（issue #1230：借注入面体积发现审视内容合理性）
summary: 借 issue #1230 发现工具注入面 ~27K token 的契机，对 39 条工具 description 做内容合理性审视（不为瘦身而瘦身）：2 条与事实矛盾的描述修订（create_scheduled_task 獭型门控表述按搭档决策改为所有獭可用、list_rhi_signals 去掉小獭拿不到的虚假主体），37 条合理不动并留痕判定理由；lint 体积闸与 RHI 信号工具是否开放小獭留为候选项。
change_type: prompt
capability_test: "n/a——description 文案变更由全量测试（305 文件/4313 用例含 description 断言）+ lint-tool-manifest 守护，无可执行行为变化（verify_by=static_only：两处修订均为字符串字面量，行为面由既有 4313 用例 + lint 静态守护，无 LLM 行为变化可测）"
created_in_conversation: 1d3437f9-ae46-488f-824b-d67936791165
intent:
  problem: "issue #1230 实测大獭 39 个工具定义合计 ~31,600 字符 ≈ 27K token 占新世首请求注入面 ~60%；其中 create_scheduled_task 描述「小獭不可」与机制矛盾（manifest system 组小獭持有、代码无獭型门控），list_rhi_signals 描述承诺小獭可用但小獭拿不到——description 与事实脱节且长期只增不减。"
  why_now: "搭档 2026-09-29 原话：「创建定时任务是所有獭都具备的（我明确下来，你本次顺手改一下）」「本次咱们要先审视具体内容，不能为了瘦身而瘦身，咱们是借助本次发现内容过大的时机来审视下**是否存在**不合理的地方！咱们的目的是把不合理的描述进行优化，而不是为了小而小！」"
  expected_effect: "39 条工具 description 全部经过内容合理性判定并留痕；2 条与事实矛盾的描述对齐机制；后续再有注入面体积讨论时，可引用本文档的逐条判定而非从零重审。"
  verify_by:
    type: static_only
    reason: "两处修订均为字符串字面量变更，无运行时行为面；description 相关断言含于全量 4313 用例，manifest 结构由 lint-tool-manifest 静态守护。"
causal_links:
  issues: [1230]
tags: [tool-description, prompt, entropy-reduction]
modules:
  - src/interface-adapters/agent-runtime/tools/
  - src/frameworks/agent/tool-description-overrides.ts
  - config/tool-manifest.json
---

## 背景

搭档原话（意图锚）：
> 「创建定时任务是所有獭都具备的（我明确下来，你本次顺手改一下）」
> 「本次咱们要先审视具体内容，不能为了瘦身而瘦身，咱们是借助本次发现内容过大的时机来审视下**是否存在**不合理的地方！咱们的目的是把不合理的描述进行优化，而不是为了小而小！」

契机：issue #1230 实测大獭 39 个工具定义合计 ~31,600 字符 ≈ 27K token，占新世首请求注入面 ~60%。核实结论（本对话 18:34 发言）：issue 中「小獭白白背上大獭专属工具」为**误报**——按獭类型裁剪机制已在跑（`session-helpers.ts:getOtterToolNamesForType` + `config/tool-manifest.json`，`buildCustomTools` 按白名单过滤后只有入选工具定义传给 SDK）；真实问题是 description 本体体积（~10.9K token）+ 无体积预算闸。

## 目标

T1: 逐一审视全部工具 description 的**内容合理性**（错误/过时/冗余重复/缺关键触发条件），修订不合理处——体积下降是副产品不是目标
T2: 修正 `create_scheduled_task` 门控描述：搭档明确「所有獭都具备」，代码侧「小獭不可」表述错误（manifest 本身正确，small 型 system 组包含该工具）
T3: 审视结论留痕（改了什么/为什么/没改什么/为什么）

## 非目标

- 不以压缩体积为目标的改写（不新增「description 越短越好」类约束）
- 不动行为触发类引导（F20260825hcpg 教训：「什么时候该用」的引导必须留在注入面，description 与 SYSTEM.md 同为每轮常驻注入，搬家无 token 收益）
- 不重复压缩 F20260917dscp 已按四类原则处理过的四个大头（search_memory/speak/get_related/yield），除非发现新的不合理
- 不引入新的工具裁剪机制（issue 建议 3「按獭类型裁剪」已被现状覆盖）

## 历史脉络（先找反对）

| 文档 | 结论 | 对本次的约束 |
|---|---|---|
| F20260917dscp（9/17 PR-C） | 四个大头已按「硬校验兜底替代预教育/删系统强制信息/双写归一/行为触发豁免」压缩过 | 本次不重复压缩；其四类原则可作审视维度参考 |
| F20260825hcpg | 行为触发类引导必须在工具 description（每请求注入），「搬家=减负」是错误模型 | 不把行为引导迁出 description |
| F20260904cg77（#776） | 编码工具覆写引导（bash 慎用的实证数据）基于真实 session 解剖，搭档决策归位 description | overrides 的实证数据引导属行为触发类，不动 |
| SYSTEM.md 熵减重构（记忆 3b91a497） | 「搬家到工具 description = 减负」是错误模型；位置移动不产生 token 收益 | 审视标准是看每句话**在当前位置是否有牵引力**，不是搬家 |

## 现状清点（事实层）

实测（2026-09-29，node 正则清点 9 个工具定义文件）：**自定义工具 description 共 39 条**，其中 `tool-factory.ts` 21 个 name 定义、同目录 8 个分组文件 18 个。

description 真相源分布：
- `src/interface-adapters/agent-runtime/tools/tool-factory.ts`：speak / yield / wait / merge_pr 等核心工具（**21 个** name 定义）
- 同目录 8 个分组文件：artifact(2) / healing(1) / html-card-contract(1) / message(3) / rhi-signal(2) / scheduled-task(1) / signal(4) / workspace(4) = 18 条
- `src/frameworks/agent/tool-description-overrides.ts`：bash/read/grep/find/ls 的 description 后缀覆写（F20260904cg77）
- pi builtin 基线：read/write/edit/bash/grep/find/ls 的原始 description 来自 SDK

manifest 分组事实（config/tool-manifest.json）：`orchestration` 组 = halt_otter / unhalt_otter / resolve_signal 三件（标注「仅 big 型引用」）；**triage_signal / list_rhi_signals 未编入任何 capabilityBlock**——small 型不持有它们的直接原因是「不在 small 的 groups 展开结果里」，而非「在 orchestration 组」。二者仅经 big 型 `"tools": "*"` 可见。

## 未决问题

- 是否引入工具 description 体积 lint（对齐 lint-prompt-size 思路）？——issue 提及，但搭档本次意图聚焦「合理性审视」，lint 闸属新增机制（需过机制预算四问），**本次不做**，留待搭档拍板是否单独立项。

## 设计取舍

① **定性为内容合理性审视而非体积压缩**：39 条逐条判定，37 条不动、2 条修订（事实性错误）、1 存疑项留搭档。修订标准是「描述与机制/事实是否一致」「当前位置是否有牵引力」，不是长度。
② **行为触发类引导保护**：speak 卡片判断标准（F20260825hcpg 归位）、bash 慎用实证引导（F20260904cg77）、search_memory 四场景（R4 真相源）等——description 与 SYSTEM.md 同为每轮常驻注入，搬家无 token 收益，且 8/25 教训证明移出会失传。
③ **不重复压缩 F20260917dscp 四个大头**：speak/yield/search_memory/get_related 9/17 已按四类原则处理，本次复核未发现新的不合理。
④ **lint 体积闸不做**：属新增机制（需过机制预算四问），搭档本次意图聚焦合理性审视；issue #1230 留评记录该候选项。
⑤ **`list_rhi_signals` 修描述而非放权限**：「被派工小獭拉清单」描述承诺了 manifest 不交付的能力，但把 RHI 信号工具编入 small 可见的组是能力开放决策（且不能简单加 orchestration 组——会把 halt/unhalt/resolve_signal 一并放开），超出描述审视范围——先修描述对齐事实，是否真开放单独议。

## 验证

- 全量测试 305 文件 / 4313 用例通过（description 文本变更未破坏任何断言）
- `node scripts/lint-tool-manifest.mjs` 通过（manifest 未动，工具白名单机制本身由该 lint 守护）
- `node scripts/lint-intent.mjs` intent 块存在（本修订均为字符串字面量，verify_by=static_only；golden-results.jsonl 豁免——无可执行 LLM 行为变化可记录）
- 体积影响：两处修订净变化约 -10 字符（审视定性非压缩，体积本就不是目标）

## 逐条审视记录

**修订（2 条）**

| 工具 | 问题 | 处置 |
|---|---|---|
| create_scheduled_task | 「大獭可创建，小獭不可」与事实矛盾——manifest system 组小獭持有、代码无獭型门控 | 搭档明确「所有獭都具备」，改为「（所有獭均可创建）」 |
| list_rhi_signals | When 写「被派工小獭拉未接单清单」，但该工具未编入任何 capabilityBlock，small 型拿不到——描述承诺了机制不交付的能力 | 改为「未接单清单查询作为派工输入」，去掉虚假主体；是否真放权限留存疑项 |

**存疑（1 项）**：triage_signal / list_rhi_signals 是否编入某个 small 可见的组开放给小獭——能力决策（注意不能直接复用 orchestration 组，会连带放开 halt/unhalt/resolve_signal），单独议。

**合理不动（37 条，分类摘要）**

- **dscp 已压缩四头**：speak/yield/search_memory/get_related——9/17 四类原则已处理，复核无新问题；speak 的卡片判断标准属 hcpg 归位的正向标准，保护
- **硬校验/授权闸类**：merge_pr（授权闸+原话机械校验说明）、manage_healing_events（batch_resolve 参数语义+单批上限+幂等陷阱——参数级契约，删了 LLM 无法正确调用）
- **行为触发引导类**：wait（speak 先行的黑盒透明义务+时长上下限的熔断语义——行为约束，9/28 slan 新增，复核合理）、search_terminology/add_terminology（GOTCHA「必须搭档显式定义」防污染是行为约束）、记忆三件套（link/get_related/unlink 的边界与时机）、restart/dissolve（不可逆警告）
- **机制必答类**：get_html_card_contract（写卡前必调，session 冷启动契约）、speak/yield（通信模型唯一真相源）
- **简洁事实类**：message 三件套、context 三件套、artifacts 两件套（list/update）、workspace 四件套、signal 台账两件（query_signals/resolve_signal）、create/dissolve/halt/unhalt、sync_docs、create_linked_resource、triage_signal、get_active_participants、create_otter、search_messages、query_dispatch_ledger
- **编码工具 overrides**：bash/read/grep/find/ls 后缀引导（cg77 实证数据，行为触发类豁免）
- **SYSTEM.md 核对**：「召唤小獭」段与 otter-summon skill 无实质双写（前者管两步动作+首哑处置，后者管简报模板）
