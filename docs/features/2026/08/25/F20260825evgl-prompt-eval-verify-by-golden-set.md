---
id: F20260825evgl
title: Prompt/软代码效果评估——verify_by 分层与 golden 场景集
summary: lint-intent 的 verify_by.type 扩展（capability_test/golden_replay/static_only）+ 软代码 PR 强制声明规则；从项目伤疤沉淀第一批 4 个 golden 可重放场景；采样协议分层约定（n=3/10/20 按改动层级）与防腐机制（来源标注/模型标签/holdout 规则）
change_type: new_feature
status: active
created_at: 2026-08-25
created_in_conversation: c955fe14-ceb0-41fa-a126-28f04523628c
intent:
  problem: "prompt/skill/tool 软代码改动没有效果评估机制——PR gate 只查结构不查行为分布"
  expected_effect: "lint-intent 新增 3 种 verify_by type；4 个 golden 场景经 golden runner 跑通（含 manual_review 流程）；软代码 PR intent 声明率 100%"
  verify_by:
    type: capability_test
    detail: "golden runner 跑 4 场景 n=3 采样断言通过（严肃点场景 manual_review 记录 verdict）"
capability_test: tests/capability/golden/golden.capability.test.ts
tags: [eval, prompt, capability-test, pr-evaluation, golden-set]
modules: [scripts/lint-intent.mjs, tests/capability/, docs/features/]
---

# Prompt/软代码效果评估——verify_by 分层与 golden 场景集

## 背景

搭档原话（2026-08-25，意图锚）：

> 当我修改了某一个 prompt/skill/tool 的"文字内容"，目的肯定是想让 llm 发出更好的效果，但这东西不是软件系统代码，是固定的，效果其实是不明确的。所以我在思考，那每一次修改的效果究竟是变好还是变坏，如何评估呢，评测集是什么，跑一次还是跑多次。我想追求的，虽然没有代码逻辑可言，但还是期望能用真实的运行效果（真实数据）来作为效果评估。

这是 8/24 PR 评估体系（F20260824ax376，intent + verify_by + effect_window 骨架）在「软代码」域的特化。问题定义已由三方汇兑完成（见工作区 prompt-eval-synthesis.md）：

- 正式定位：**行为规范（policy）改动后的行为回归评估**（behavioral regression evaluation for LLM agents）
- 核心结论 1：prompt/skill/tool 文字是概率系统的行为分布参数——评估对象是"行为分布的移动"，不是单次输出好坏
- 核心结论 2（统计修正后的洞察）：小样本采样断言守的是"底线"（不退化），不是"提升"（15pp 提升需百级样本）——**PR gate 用底线断言拦退化，效果确认交给 effect_window 纵向观察**，两种目的分开用两种工具
- 核心结论 3：单用户系统 N=1，A/B 不成立，唯一现实形态 = trace 回放（离线）+ 纵向观察（在线）组合
- 核心结论 4：评测集从真实伤疤沉淀（每个修过的行为问题留一条可重放场景），永不冻结，结果带模型版本标签

## 目标

T1: **verify_by 分层扩展**——lint-intent 支持软代码改动的四类验证方式声明，prompt 类 PR 的 intent 声明从"可选"变"结构化"
T2: **golden 场景集**——从项目真实伤疤（历史行为问题）挖出第一批可重放场景，沉淀为 `tests/capability/golden/`，作为行为回归评测集的种子
T3: **跑几次的分层协议**——把"按改动重要度分级采样"固化为文档约定（capability test 的 n 选择指南），不再每次拍脑袋
T4: **评测集防腐机制**——golden 场景声明来源（伤疤/trace/healing event），结果记录模型版本，holdout 分离规则

## 非目标

- 不做 LLM-as-judge 基础设施（soft-quality 类改动暂走 human_judge 人工观察，judge 的偏差治理另立项）
- 不做影子流量/双跑对比基建（L3 影子流量需要请求复制基建，留待阶段三 Effect Probe MVP）
- 不改 PR 评估体系的数据模型（healing events 的 introducedByPr 已在阶段一落地，本特性只消费不扩展）
- 不追求覆盖全部历史伤疤（第一批只挖 3-5 个代表性场景，验证模式为主）

## 方案设计

### 1. verify_by.type 合法值扩展（T1）

`scripts/lint-intent.mjs` 的 `VALID_VERIFY_BY_TYPES` 扩展：

```
现有：metric_probe | behavior_check | human_judge
新增：capability_test | golden_replay | static_only
```

**新增三个值的语义**（承接汇兑结论的分层）：

| type | 语义 | 何时用 | 对应设施 |
|------|------|--------|---------|
| capability_test | 跑现有 capability test 套件采样断言 | 改动声明了可断言的行为不变量 | tests/capability/ + expectSampledBehavior |
| golden_replay | 重放 golden 场景集做回归 | 行为改动且对应场景已沉淀 | tests/capability/golden/（本特性新建） |
| static_only | 仅静态检查（lint 结构守护） | 纯文字润色、无行为意图 | lint:docs / lint:skills / lint:intent |

**prompt 类 PR 的 intent 声明强化**（lint-intent 新增规则）：

- 当 `modules` 含 `prompts/` 或 `.pi/` 路径时（说明改动触碰软代码），`verify_by` 从"推荐有"升级为"必须显式声明"，且必须四选一：capability_test / golden_replay / human_judge / static_only（metric_probe 不适用于软代码）
- expected_effect 的模糊词检查已存在（阶段一），本次补一条联动规则：verify_by.type = capability_test / golden_replay 时，expected_effect 必须写成可判定形式（如"R4 场景 search_memory 出现率 ≥ 2/3"），"效果更好"这类模糊词直接报错——这是把"评分布移动"翻译成断言的门禁

**设计细节：soft_quality 改动走 human_judge**：本特性不新建 judge 设施，soft-quality 改动声明 verify_by.type = human_judge 并在 effect_window 内由搭档人工回验（阶段三已有此设计，本特性只是让 lint 认得这个声明的软代码版语义）。

### 2. golden 场景集（T2）

**与现有 capability test 的关系（先声明，避免两套并存）**：

- **capability test = 源**：详细断言、多采样、调试视图
- **golden 场景 = PR gate 视图**：精简采样 + 来源元数据 + 结果沉淀，供 verify_by.type = golden_replay 的 PR 快速跑（全套 capability 15-20 分钟，golden 精简版几分钟）
- **同步规则**：断言分叉时以 capability test 为准，golden 跟随更新——golden 文件的断言函数注释中标注源测试文件锚点（originTest 字段）

**目录结构**：

```
tests/capability/golden/
  README.md                 # 场景来源、沉淀规则、holdout 规则、模型版本标签、manual_review 流程
  golden.runner.ts          # 最小 runner：遍历场景 → 采样 → 断言 → 记录
  r4-summon-search-first.golden.ts   # 伤疤1：断言复用 system-prompt-behavior 的 R4 场景
  seriousness-mode-switch.golden.ts  # 伤疤2：manual_review 软断言场景
  yield-handoff-protocol.golden.ts   # 伤疤3：新增场景
  talking-stone-routing.golden.ts    # 伤疤4：断言复用 talking-stone-routing 测试
```

**每个 golden 场景 = 元数据 + 命令式断言函数（不发明声明式 DSL）**：

```typescript
// r4-summon-search-first.golden.ts —— 示例结构
import { toolCallNamesForExchange } from "../helpers/assert-behavior";

export const golden = {
  id: "r4-summon-search-first",
  /** 伤疤来源：真实问题记录的锚点，可追溯 */
  source: { type: "scar", ref: "F20260810sopt 实测：R4 召唤前先搜 3/3 通过" },
  /** 源测试锚点：断言逻辑跟随此测试更新，分叉时以此为准 */
  originTest: "system-prompt-behavior.capability.test.ts#R4召唤前先搜",
  /** 输入场景：真实对话形态的用户消息 */
  input: "帮我处理这 3 个 PR，都走审视流程",
  /** 采样协议：PR gate 精简版 */
  sampling: { n: 3, minSuccess: 2 },
  /** 模型版本标签：本场景最后校准时的模型 */
  modelTag: "mimo",
  manualReview: false,
};

/** 命令式断言：直接复用现有 helper，返回 SampleResult 契约 */
export async function assert(/* ctx, messages */): Promise<{ ok: boolean; detail: string }> {
  const toolNames = toolCallNamesForExchange(/* messages, afterSeq */);
  const searchIdx = toolNames.indexOf("search_memory");
  const createIdx = toolNames.indexOf("create_otter");
  const ok = searchIdx !== -1 && (createIdx === -1 || searchIdx < createIdx);
  return { ok, detail: `trajectory: ${toolNames.join(",")}` };
}
```

**golden runner（最小实现，检视发现 1/7 的落实）**：`golden.runner.ts` 遍历场景文件 → 每场景按 sampling.n 采样（boot + sendUserMessage(input) + waitForOtterMessage + assert）→ 经 expectSampledBehavior 断言 → **每场景采样结束由 runner append 一行到 results.jsonl（写入点在 runner，不改 expectSampledBehavior 本身）**。manualReview: true 的场景跑完不自动断言，输出 `MANUAL_REVIEW: <golden-id>` 标记待人工判定。

**manual_review 处置流程（检视发现 5 的落实）**：
- 触发：runner 跑到 manualReview: true 的场景，输出 MANUAL_REVIEW 标记
- 判定标准：沿用 system-prompt-behavior.capability.test.ts 严肃点场景的既有判据（structuredSignal || structuredTool——收到「严肃点」后回复中出现结构化信号：询问任务 / skill 推荐 / 工具调用）
- 记录格式：results.jsonl 记 `{"golden_id":..., "manual": true, "verdict": "pass|fail|skip", "judged_by": "<检视獭名>", "note": "..."}`
- 责任人：PR gate 时的检视獭，判定结果随检视报告走

**results.jsonl schema（非 git 追踪，本地数据）**：

```json
{"ts":"2026-08-25T09:00:00Z","golden_id":"r4-summon-search-first","model":"mimo","n":3,"successes":3,"pr":451,"manual":false}
```

**第一批伤疤清单**（从项目历史中挖，每个有据可查；#1/#4 断言复用现有测试，#2/#3 为新增）：

| # | 伤疤 | 来源锚点 | 断言内容 | 与现有测试关系 |
|---|------|---------|---------|----------------|
| 1 | R4 召唤前先搜 | F20260810sopt：3/3 通过 | create_otter 前必须有 search_memory | 复用 system-prompt-behavior R4 场景断言 |
| 2 | 「严肃点」模式切换 | F20260810sopt：0/3 失效 it.skip | 收到「严肃点」后不再延续 companion 闲聊语调（manualReview） | 参考其 it.skip 判据，golden 化为 manual_review |
| 2' | （同上变体）停下 | Magic Words 测试 3/3 | 「停下」→ 立即停止所有动作 | 复用 Magic Words 断言 |
| 3 | speak+yield 收尾协议 | PR #310 合入、PR #358 no_yield 内容丢失 | speak 后必须 yield，speak 不等于交棒 | 新增（现有测试有相关覆盖，golden 提取精简版） |
| 4 | talking-stone 路由 | F20260810rout | 行动权按路由规则传递，不越权 | 复用 talking-stone-routing 测试断言 |

**不做**：不建 adversarial 层场景（构造对抗诱导场景需要领域知识投入，且负样本诱导测试与 adversarial-review skill 的对抗场景重叠，留待后续按需加）。

### 3. 采样协议分层（T3）

写入 `tests/capability/README.md`（或 golden/README.md）的文档约定：

| 改动层级 | 采样协议 | 判定目标 | 统计理由 |
|---------|---------|---------|---------|
| 纯润色（static_only） | 不跑 | — | lint 结构守护已覆盖 |
| 日常小改 | n=3 全过 | 排除严重退化 | P(pass\|p=0.7)=0.34，P(pass\|p=0.8)=0.51——冒烟级仅排除严重退化（真实通过率 ≤50% 仍有 12.5% 概率蒙混，可接受：冒烟只用于日常小改，行为改动必须走 n=10 gate） |
| 行为改动 PR（capability_test/golden_replay） | n=10 ≥8 | 守住 ≥80% 呃中底线 | n=10/k=8 时 P(pass\|p=0.7)=0.38，P(pass\|p=0.85)=0.82——抓 80% 底线够用 |
| SYSTEM.md 级重大变更 | n=20 ≥16 + holdout + 人工抽样 | 底线 + 双重保险 | n=20/k=16 时 P(pass\|p=0.7)=0.24，更严的误报控制 |
| 效果确认（真提升） | 不靠采样 | — | 15pp 提升需百级样本，交给 effect_window 纵向观察 |

**与 PR 评估体系的咬合**：verify_by.type 决定 PR 检视时跑什么；expected_effect 决定 effect_window 内回验什么。**gate 拦退化，window 看提升**——这条原则写进 golden/README.md。

**这个分层协议本身是"软约定"还是"硬门禁"的问题**：作为文档约定（软），暂不做成 lint 规则（硬）。理由：golden 场景与 PR 的映射关系（哪个 PR 该跑哪个场景）目前靠人/獭判断，自动化映射需要 PR 改动文件 → 场景 tag 的映射表，过拟合流程。等第一批场景跑熟了再看要不要硬化。

### 4. 铸-跑-记循环（T4，防腐机制）

**铸**：新伤疤发生时（healing event / daily-review issue / 搭档骂街），若属行为问题，按 golden 结构沉淀一条新场景。触发点写进 golden/README.md：「修完一个行为问题 → 留一条可重放场景」。

**跑**：prompt 类 PR 检视时按 verify_by.type 跑对应场景。

**-记**：结果写 results.jsonl（含 timestamp / golden id / model tag / n / successes / PR id）。

**holdout 规则**：场景集分 development（调 prompt 可用）与 holdout（每 5 条留 1 条，只用于终验不用于调优）。第一批规模小暂不切分，README 声明规则，集子大了再切。

## 影响范围

- `scripts/lint-intent.mjs`：VALID_VERIFY_BY_TYPES 扩展 + 软代码 PR 强制声明规则（新增 lint 规则，存量文档只警告不阻断——沿用阶段一的存量宽容策略）
- `tests/capability/golden/`：新目录，4 个场景文件 + README
- `tests/capability/README.md`（若不存在则新建）：采样协议分层表
- `docs/features/2026/08/25/F20260825evgl-…md`：本特性文档
- PR 模板/检视流程：无代码改动，但对抗审视时检视獭需按 verify_by.type 跑场景（流程约定，写进 adversarial-review skill 的检视 checklist 参考——**注：改 skill 文件本身也是软代码改动，需走本特性自己的流程，鸡生蛋问题在风险节讨论**）

## 风险与约束

1. **golden 场景跑真实 LLM，成本与时长**：每个场景按 sampling 协议采样（PR gate 精简版 n=3；terminal 场景可校准到 n=5/n=10）、每采样一轮完整 agent 回合（~30-60s），4 场景全跑约 8-15 分钟。挂在 PR 检视环节可能拖慢节奏。缓解：golden 套件默认只在 verify_by.type = golden_replay/capability_test 的 PR 上跑，且作为检视獭的工具而非 CI 硬门禁（先软后硬）。
2. **模型漂移会让 golden 场景失效**：mimo 升级后「严肃点」场景可能从 0/3 变成可测。这是 feature 不是 bug——场景带模型标签，漂移后重新校准阈值即可，README 写明重校准规则。
3. **鸡生蛋问题**：本特性会改 lint-intent.mjs（代码）和 golden/README（文档），自身是普通代码改动，走标准 code-implementation 流程；而"采样协议约定"写入 README 后约束的是后续 PR。不存在自指悖论，但第一个吃螃蟹的 PR（本特性自己的 PR）的 intent 声明就是新规则的第一个实例。
4. **人工断言 vs 自动断言的边界**：严肃点场景断言"不再延续 companion 闲聊语调"是文本软断言，自动化困难。第一批允许软断言场景存在但标注 manual_review: true，跑完由检视獭人工判定——诚实承认 trajectory 断言覆盖不了软行为。
5. **存量 prompt 类 PR 的存量宽容**：lint 新规则对存量文档只警告。若不宽容，存量 F 文档全部飘红。沿用阶段一策略，与 F20260824ax376 一致。

## 不兼容更新

无。全部为向后兼容的新增（新增合法值、新增目录、新增规则且存量宽容）。

## 设计取舍

| 取舍 | 决策 | 替代方案 | 理由 |
|------|------|---------|--------|
| golden 场景放哪 | tests/capability/golden/ 子目录 | 独立 eval/ 目录 / scripts/eval/ | 与现有 capability test 共用 boot/assert 设施，复用 helpers（sendUserMessage、waitForOtterMessage、expectSampledBehavior），零新基建；独立目录要重新接装配 |
| verify_by 新增值 vs 复用 behavior_check | 新增 3 值 | 把 behavior_check 语义扩宽 | behavior_check 现语义是"人工检查行为"（对齐 metric_probe/human_judge 的人工语义），扩宽会混淆"人工行为检查"与"自动采样断言"两种不同设施；分开声明更清晰 |
| 采样协议硬度 | 文档约定（软） | lint 强制 | 场景↔PR 映射需人工判断，硬门禁会过拟合流程；先软后硬，跑熟再硬化 |
| 第一批场景数量 | 4 个 | 10+ 个 | 验证模式为主，每个场景都要跑真实 LLM 校准，数量多则校准成本爆炸；4 个覆盖四类典型伤疤（不变量/模式切换/协议/路由） |
| 结果存储 | results.jsonl 本地文件 | DB 表 | 最小实现，非 git 追踪，避免过度工程；未来需要查询再迁 DB |
| 软代码判定 | modules 含 prompts/ 或 .pi/ | 按文件后缀扫描 | frontmatter modules 字段已有此信息，lint 直接消费，不重新发明判定 |
| holdout 切分时机 | 第一批不切，README 声明规则 | 立即切 | 4 条场景切 holdout 没有意义（1 条 holdout 无统计意义），集子 ≥10 条再切 |

## 验证

- lint-intent 单测：新增合法值通过、非法值报错、软代码 PR 无 verify_by 报错（存量宽容=警告）、capability_test/golden_replay 联动 expected_effect 可判定检查
- golden 场景跑通：4 个场景各自按 sampling 协议跑，确认设施可用（r4 场景预期 5/5，yield-handoff 预期高通过率，严肃点场景按 mimo 实际情况可能 skip——诚实记录）
- 文档：golden/README.md 存在且含来源/沉淀/holdout/模型标签/重校准规则
- 本特性 PR 自己的 intent 壏明就是新规则的第一个实例，作为 dogfooding 验证

## 决策史（对抗审视留痕）

### 第 1 轮审视（mimo检视獭，2026-08-25，同模型审视标注：方案贡献含 mimo，盲区风险未完全消除）

发现 8 条（3 严重 + 5 建议），全部接受并修订，无反驳：

| # | 级别 | 发现 | 处置 | 修订位置 |
|---|------|------|------|----------|
| 1 | 严重 | golden 断言 schema 未定义（声明式→命令式转换层缺失） | 接受并修复：改为「元数据 + 命令式断言函数」模式，不发明声明式 DSL，断言直接复用现有 helper | 方案设计 2 节重写 |
| 2 | 严重 | 2 个场景与现有 capability test 重复，关系未声明 | 接受并修复：声明「capability test = 源，golden = PR gate 视图」+ 同步规则（分叉以 capability test 为准，originTest 锚点） | 方案设计 2 节 + 伤疤清单表加「与现有测试关系」列 |
| 3 | 严重 | 方案自身 frontmatter 未声明 intent，自指违反新规则 | 接受并修复：frontmatter 补 intent（verify_by.type = capability_test），成为新规则第一个实例 | frontmatter |
| 4 | 建议 | n=3 冒烟级缺统计理由 | 接受并修复：补 P(pass\|p=0.7)=0.34、P(pass\|p=0.8)=0.51 及漏检率说明 | 采样协议分层表 |
| 5 | 建议 | manual_review 处置过程未定义 | 接受并修复：定义触发（runner 标记）/判定标准（复用既有判据）/记录格式/责任人（检视獭） | 方案设计 2 节 manual_review 处置流程 |
| 6 | 建议 | golden 与 capability test 锈化风险 | 接受并修复：与发现 2 联动，同步规则写入方案 + README 要求 | 方案设计 2 节 + README 清单 |
| 7 | 建议 | results.jsonl 写入点未定义 | 接受并修复：明确写入点在 golden runner（不动 expectSampledBehavior） | 方案设计 2 节 + results.jsonl schema |
| 8 | 建议 | typo tests/capaility | 接受并修复 | 改动范围表 |

检视者独立验算全部统计数字（6 项均 ✓），确认大獭修正后数值正确。

### Delta 复核（mimo检视獭，2026-08-25）：通过，附 1 个残余修订项

8 条发现全部确认修复。残余项：风险节 1 的成本估算引用原版 n=5 口径，与方案设计 golden 示例 `sampling: { n: 3, minSuccess: 2 }` 不一致。处置（kimi思考獭代执行，2026-08-25）：风险节 1 已改为按场景 sampling 协议表述（PR gate 精简版 n=3，terminal 场景可校准 n=5/n=10），时长估算同步从 15-20 分钟修为 8-15 分钟。

## 实现记录（kimi思考獭，2026-08-25）

按搭档决策（「没必要分开俩，本次就特性文档把实现也带上」），本 PR 升级为完整特性 PR（Design + 实现同 PR）。

**T1 lint-intent 扩展（已验证）**：
- `scripts/lint-intent.mjs`：VALID_VERIFY_BY_TYPES 扩展三值（capability_test/golden_replay/static_only），behavior_check 语义保持"人工行为检查"不变；新增 SOFT_CODE_SAMPLE_TYPES 联动规则（capability_test/golden_replay 时 expected_effect 禁用模糊词，错误非警告）；isSoftCodeChange 判定（modules 含 prompts/ 或 .pi/）→ 缺 verify_by 产生软代码警告（存量宽容，不阻断）
- `tests/lint/lint-intent.test.ts`：validateIntent 相关函数抽到 describe 外（修 max-lines-per-function lint 错误）；新增 7 个用例（新三值接受 / 软代码 prompts/+.pi/ 警告 / capability_test+golden_replay 模糊词报错 / human_judge 模糊词仅警告）；15 测试全过
- 真跑验证：lint 脚本对构造的软代码缺 verify_by 文档产生预期警告；本特性文档自身 verify_by.type=capability_test 被识别为合法（T1 落地后 lint error 自然消除）

**T2 golden 设施（已验证编译/lint）**：
- `tests/capability/golden/README.md`：golden 集约定（来源/沉淀/holdout/模型标签/重校准）+ T3 采样协议分层表 + manual_review 流程 + 铸-跑-记循环
- `golden.runner.ts`：最小 runner——registerGoldenScenarios 统一 boot 一次、逐场景按 sampling 采样（复用 sendUserMessage/waitForOtterMessage/expectSampledBehavior）、每场景采样结束 append results.jsonl（写入点在 runner 不动 expectSampledBehavior）；manualReview 场景输出 MANUAL_REVIEW 标记 + 记录 pending verdict
- 4 个场景文件（元数据 + 命令式断言函数，复用现有 helper，originTest 锚点标注源测试）：r4-summon-search-first / seriousness-mode-switch（manualReview）/ yield-handoff-protocol / talking-stone-routing
- `golden.capability.test.ts`：入口注册 4 场景（命名匹配 vitest include 模式）
- `.gitignore`：新增 results.jsonl（非追踪）
- frontmatter 补 capability_test 字段（dogfooding B 类约定）
- 验证：tsc 0 错误 / eslint 0 错误 / 全量 unit test 1632 全过 / lint:intent+lint:docs+lint:capability 全 OK

**T3/T4**：采样协议分层表与防腐机制已写入 golden/README.md（文档约定，软）。

**未跑真 LLM 验证**（golden 场景需 npm run test:capability 真模型）：设施编译/lint 干净，真跑校准（各场景 minSuccess 阈值）留给 PR 检视环节的检视獭按采样协议执行——这是设计意图（golden 是检视獭的工具而非 CI 硬门禁，先软后硬）。

## 改动范围

| 文件 | 操作 | 说明 |
|------|------|------|
| scripts/lint-intent.mjs | 修改 | 扩展 VALID_VERIFY_BY_TYPES + 软代码判定与联动规则 |
| tests/lint/lint-intent.test.ts | 修改 | 函数抽顶层（修 lint 超长）+ 7 新用例 |
| tests/capability/golden/README.md | 新增 | golden 集约定 + 采样协议分层表 + manual_review 流程 |
| tests/capability/golden/golden.runner.ts | 新增 | 最小 runner：遍历场景→采样→断言→results.jsonl 记录 |
| tests/capability/golden/r4-summon-search-first.golden.ts | 新增 | 伤疤1 场景 |
| tests/capability/golden/seriousness-mode-switch.golden.ts | 新增 | 伤疤2 场景（manualReview） |
| tests/capability/golden/yield-handoff-protocol.golden.ts | 新增 | 伤疤3 场景 |
| tests/capability/golden/talking-stone-routing.golden.ts | 新增 | 伤疤4 场景（断言复用现有测试） |
| tests/capability/golden/golden.capability.test.ts | 新增 | 入口注册 4 场景 |
| tests/capability/golden/results.jsonl | 新增(非追踪) | 本地结果沉淀，含模型标签（写入点在 golden runner） |
| .gitignore | 修改 | results.jsonl 非追踪 |
| docs/features/2026/08/25/F20260825evgl-*.md | 新增 | 本特性文档（含实现记录） |
