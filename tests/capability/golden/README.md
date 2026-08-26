# Golden 场景集——软代码行为回归评测集

> F20260825evgl：从项目真实伤疤沉淀的可重放行为场景，作为 prompt/skill/tool 软代码改动的
> PR gate 回归视图。核心原则：**gate 拦退化，window 看提升**——小样本采样断言守的是
> "底线"（不退化），不是"提升"（15pp 提升需百级样本，交给 effect_window 纵向观察）。

## 这是什么

每个 golden 场景 = 一个修过的行为问题留下的可重放场景（元数据 + 命令式断言函数）。
改 prompt/skill/tool 文字内容时，按改动声明的 `verify_by.type` 跑对应场景，验证行为分布
没有按**反方向**移动（退化）。

## 与现有 capability test 的关系（先声明，避免两套并存）

- **capability test = 源**：详细断言、多采样、调试视图（`tests/capability/*.capability.test.ts`）
- **golden 场景 = PR gate 视图**：精简采样 + 来源元数据 + 结果沉淀，供
  `verify_by.type = golden_replay` 的 PR 快速跑
- **同步规则**：断言分叉时**以 capability test 为准**，golden 跟随更新。golden 文件的断言
  函数注释中标注源测试锚点（`originTest` 字段）。改 capability test 的断言逻辑时，必须
  同步检查对应 golden 场景。

## 采样协议分层（T3）

| 改动层级 | 采样协议 | 判定目标 | 统计理由 |
|---------|---------|---------|---------|
| 纯润色（static_only） | 不跑 | — | lint 结构守护已覆盖 |
| 日常小改 | n=3 全过 | 排除严重退化 | P(pass\|p=0.7)=0.34，P(pass\|p=0.8)=0.51——冒烟级仅排除严重退化（真实通过率 ≤50% 仍有 12.5% 概率蒙混，可接受：冒烟只用于日常小改，行为改动必须走 n=10 gate） |
| 行为改动 PR（capability_test/golden_replay） | n=10 ≥8 | 守住 ≥80% 命中底线 | n=10/k=8 时 P(pass\|p=0.7)=0.38，P(pass\|p=0.85)=0.82——抓 80% 底线够用 |
| SYSTEM.md 级重大变更 | n=20 ≥16 + holdout + 人工抽样 | 底线 + 双重保险 | n=20/k=16 时 P(pass\|p=0.7)=0.24，更严的误报控制 |
| 效果确认（真提升） | 不靠采样 | — | 15pp 提升需百级样本，交给 effect_window 纵向观察 |

**"跑几次"由改动的 expected_effect 幅度反推**——这是 PR 评估体系 intent 声明的统计学理由。
**这个分层是文档约定（软），暂不做成 lint 规则（硬）**——场景↔PR 映射靠人/獭判断，跑熟再硬化。

## 每个 golden 场景的结构

场景 = 元数据（`golden` 对象）+ 命令式断言函数（`assert`）。**不发明声明式 DSL**，断言直接
复用现有 helper（`toolCallNamesForExchange` 等），返回 `SampleResult` 契约（`{ok, detail}`）。

```typescript
export const golden = {
  id: "r4-summon-search-first",
  source: { type: "scar", ref: "F20260810sopt 实测：R4 召唤前先搜 3/3 通过" },  // 伤疤来源锚点
  originTest: "system-prompt-behavior.capability.test.ts#R4召唤前先搜",         // 源测试锚点
  input: "帮我处理这 3 个 PR，都走审视流程",                                       // 真实对话形态的用户消息
  sampling: { n: 3, minSuccess: 2 },                                             // PR gate 精简版
  modelTag: "mimo",                                                              // 最后校准时的模型
  manualReview: false,
};
```

## 铸-跑-记循环（T4，防腐机制）

- **铸**：新伤疤发生时（healing event / daily-review issue / 搭档骂街），若属行为问题，
  按 golden 结构沉淀一条新场景。**修完一个行为问题 → 留一条可重放场景**。
- **跑**：prompt 类 PR 检视时按 `verify_by.type` 跑对应场景。
- **记**：结果写 `results.jsonl`（非 git 追踪），含 timestamp / golden_id / model / n /
  successes / PR id。写入点在 golden runner，不动 `expectSampledBehavior` 本身。

## 防腐规则

1. **来源标注**：每个场景必须带 `source`（伤疤/trace/healing event 锚点），可追溯
2. **模型版本标签**：每个场景带 `modelTag`，结果记录带 `model`——模型漂移后重新校准阈值
3. **holdout 规则**：场景集分 development（调 prompt 可用）与 holdout（每 5 条留 1 条，
   只用于终验不用于调优）。**第一批规模小（4 条）暂不切分**，集子 ≥10 条再切。
4. **永不冻结**：golden set 持续从真实 trace 补充，不是一次性 benchmark

## manual_review 处置流程

软行为（如「严肃点」模式切换的语调判断）trajectory 断言覆盖不了，诚实标注
`manualReview: true`，跑完由检视獭人工判定：

- **触发**：runner 跑到 `manualReview: true` 的场景，输出 `MANUAL_REVIEW: <golden-id>` 标记
- **判定标准**：沿用对应 capability test 的既有判据（如严肃点场景用
  `structuredSignal || structuredTool`——收到「严肃点」后回复中出现结构化信号：询问任务 /
  skill 推荐 / 工具调用）
- **记录格式**：results.jsonl 记
  `{"golden_id":..., "manual": true, "verdict": "pass|fail|skip", "judged_by": "<检视獭名>", "note": "..."}`
- **责任人**：PR gate 时的检视獭，判定结果随检视报告走

## 重校准规则

模型升级后场景可能失效（如 mimo 升级后「严肃点」从 0/3 变可测）。这是 **feature 不是 bug**：
场景带模型标签，漂移后按新模型重新跑一遍校准 `sampling.minSuccess` 阈值即可。校准时更新
`modelTag` 并在 results.jsonl 留一行校准记录。

## 运行方式

```bash
npm run test:capability   # golden 场景作为 capability 套件的一部分跑（*.golden.ts 经 runner 注册）
```

单个场景的采样数遵循其 `sampling` 字段；runner 负责遍历场景、采样、断言、写 results.jsonl。
