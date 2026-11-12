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
| 日常小改 | n=3 | smoke/定位信号 | 只能提供很弱的单次样本证据，不能声称守住某个成功率底线 |
| 行为改动 PR（capability_test/golden_replay） | 预注册 base/head 非劣协议 | 绝对底线 + 不显著劣化 | 见 `../live-protocol.json`；样本量由最小劣化、α 与功效反推 |
| SYSTEM.md/shared runtime/helper 级重大变更 | 默认全套件非劣 + holdout + 人工抽样 | 影响面不能只挑相关题 | 多重比较按同族场景数修正，禁止跑到绿后只呈最后一次 |
| 效果确认（真提升） | 纵向 effect window | 能力改善而非仅非劣 | 15pp 提升通常需更大样本，小样本 smoke 不声称提升 |

**旧文档把 n=10≥8 误述为“守住 ≥80% 底线”是不成立的**：n=10/k=8 在真实 p=0.7 时
通过率仅约 38%，既不是充分统计功效，也没有 base/head 差值区间。n=3/10/20 只能按
预注册目的称为 smoke 或特定检验，不能凭名称获得统计保证。硬门消费机器 comparison 并
重算，不再由场景↔PR 映射或 PR 文本自报单独决定。

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

## 新场景准入（F20260917sdpl，T5）

**唯一合法来源 = 真实案发现场**：healing event / 事故复盘 / daily-review issue / 搭档实锤反馈。
新场景入库必须携带案发锚点（healing event ID / issue 号 / F 文档号 + 案发现场一句话描述），
并通过 selftest 断言判别力（F20260828gssf 既有纪律）。

**三类来源禁止入库**：纯想象场景、未发生过的假设场景、从其他项目移植未经本地验真的场景。
理由（搭档口径锚定）：「语义级无法靠测试代码来看护，只能由咱们系统真实的案发现场来验证」——
合成场景证明不了本系统的行为，反而稀释真实伤疤的判别力。

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
