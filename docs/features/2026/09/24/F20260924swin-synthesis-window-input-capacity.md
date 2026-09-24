---
id: F20260924swin
title: 合成窗口口径修正：显式 max_tokens 正杠杆 + 预算按失败线夹逼定标 + modelOverride 链路修复
doc_type: feature
change_type: fix
created: 2026-09-24
created_in_conversation: f4982c33-edbf-4156-913d-aaac095ff485
modules:
  - src/frameworks/agent/narrative-synthesis-engine.ts
  - src/frameworks/agent/pi-session-factory.ts
  - src/interface-adapters/agent-runtime/agent-invoker.ts
  - src/bootstrap/platforms.ts
  - tests/frameworks/agent/handoff-synthesis-budget.test.ts
  - tests/frameworks/agent/compaction-synthesis-shadow.test.ts
  - tests/interface-adapters/unified-handoff.test.ts
summary: "9/24 实证（搭档重启大獭）：合成 prompt 227,110 chars 超窗 400 降级机械档案（trim 未触发——生产预算 731,856 chars，切片输入不可能超预算；trim 观测缺口本 PR 补日志）。根因（设计缺陷，检视獭-swin 两轮对抗审视后 v3 定稿）：①合成请求未显式传 max_tokens → 输出预留 = Kimi 服务端默认（推断 ~64K），输入容量被吃掉 ~25%；②trim/预检拿「请求总预算 262,144」当「输入容量」用，预算系统性超估；③runCompactionSynthesis 端口声明的 modelOverride 被唯一实现静默丢弃，换模型重启预算锚错模型。修法（决策树①）：显式传合成专用 max_tokens=4,096（输出实证 ≤2.7K，输入容量 +30% 的正杠杆）；trim/预检统一为「全文预算」函数，按夹逼法定标（最小失败 ×0.8，跨窗口按占比 0.693 缩放）；modelOverride 链路修通。#1148 并入。"
tags: [handoff, synthesis, context-window, token-budget, kimi, max-tokens]
capability_test: "n/a: 预算公式+参数修正，回归用例固化于 tests/frameworks/agent/handoff-synthesis-budget.test.ts（夹逼预算断言）+ tests/frameworks/agent/compaction-synthesis-shadow.test.ts（maxTokens/override 断言）+ tests/interface-adapters/unified-handoff.test.ts（预检拦下/换模型重启断言）"
causal_links:
  from:
    - F20260923hsyn
    - F20260923hspx
  fixes_issue: 1148
---

## 背景（意图锚）

> 搭档 2026-09-24 08:35：「我用最新版本，然后试了下你当前对话的你的重启獭生，发现我原本是期望你走前世压缩和交接，但我发现，还是变成机械档案，你自行再排查下」
>
> 搭档 2026-09-24 08:49：「这次你出了方案后，你必须得拉 mimo 一起来审视下，我期望本次是最后一次修复了。要完整来看整个流程、不要再打补丁还打错位置」

## 目标

- T1：合成请求显式传 max_tokens（正杠杆），输入容量从 ~198K（服务端默认预留 64K）扩到 ~258K（预留 4K）——不修公式只修参数就能救回一大批灰色地带案例
- T2：trim/预检预算口径统一为「全文预算」，按夹逼法定标（最大成功 < 预算 < 最小失败 × 0.8），必死区数学消失、动机案例可合成
- T3：`runCompactionSynthesis` 的 modelOverride 链路修通（端口声明第三参被唯一实现丢弃），换模型重启不再预算锚错模型
- T4：完整流程体检结论真实（含水位阈值计量口径核查），#1148 并入不重复开战线

## 非目标

- 不改 SDK auto-compaction 内部窗口口径（pi 框架内部逻辑，非本特性范围）
- 不新增 config 字段（max_tokens 合成专用值硬编码 4,096，理由见设计取舍；真有按模型细调需求时再加，向后兼容）
- 不改水位交接阈值 240,000（阈值高于实际容量的问题挂观察 issue，改阈值是产品取舍不在本 PR）
- 不改熔断/超时/降级语义、不动 #1146 已闭环的锁模型
- selfSummary/机械供料不加上限（留观察，观测锚写死预检拦截日志）

## 现象与证据链（troubleshooting 结论固化，v2 按检视修正）

### 现场（搭档重启大獭，2026-09-24 08:34）

| 环节 | 日志/数据 | 锚点 |
|---|---|---|
| 换世成功 | `Session created`，816ms——#1146 锁修复生效 | otter-buddy.log:1247343 |
| 合成启动 | `shadow channel starting, promptLength: 227110` | otter-buddy.log:1247339 |
| 合成 400 | `400 Your request exceeded k3-256k model token limit: 262144` | otter-buddy.log:1247340（注意：错误信息只给总预算，不给输入/输出明细） |
| 降级机械 | `narrative synthesis failed, degrading to mechanical archive, consecutiveFailures:1` | otter-buddy.log:1247341 |

### 生产 vs 探针的数字偏差（检视建议 1，假设待观测定谳）

| 口径 | 值 | 说明 |
|---|---|---|
| 生产 promptLength | 227,110 chars | 交接触发瞬间的 jsonl 快照切片（+ trim？见下） |
| 探针重放 | 363,772 chars | 全部 555 entries（探针跑时 jsonl 已增长到 660，交接后 keep window 继续写入同一文件）；探针 trim dropped 0（363K < 生产预算 731,856 chars 不触发） |
| 偏差解释（假设） | 生产切片输入更小（触发瞬间 entries 少/切片起点不同）→ 227K **原样未裁** → 400 | 数学闭合性：生产 trim 触发需 pre-trim > 731,856 chars，而全量 555 entries 才 362,732 chars——生产触发时更小，**不可能触发 trim**。但生产无 droppedCount 观测（无人消费/无日志），「原样未裁」与「裁了」无法从现有日志区分 |
| 观测锚（本 PR 顺手补） | trim 落一行日志（输入长度/预算/droppedCount/输出长度） | 一行 logger，防「下一个谜团」——若未来再现偏差，日志直接定谳 |

### 输出预留的实证链（v2 核心修正，检视严重 2 推动的再核查）

| 环节 | 事实 | 锚点 |
|---|---|---|
| config | kimi-256k 未设 maxTokens（全 config 仅 mimo 两处显式 131,072） | config/config.yaml:37/48 vs :76-115 |
| models-factory | `maxTokens: options.maxTokens ?? template.maxTokens` → 模板回退 gpt-4 档 8,192 | models-factory.ts:146 + pi-ai data/openai.json（gpt-4 maxTokens 8192） |
| **API 层（决定性）** | `if (options?.maxTokens && compat.supportsMaxOutputTokens)` —— **falsy 时不发 max_tokens 参数** | pi-ai/dist/api/openai-responses.js:235 |
| 结论 | 请求里**没有 max_tokens** → 输出预留 = Kimi 服务端默认值 | 模板 8,192 从未生效 |
| 服务端默认值实测 | **推断** ~64K：362,272 chars @密度~1.8 ≈ 201K tokens + 64K ≈ 265K > 262,144 → 400 ✓；227,110 chars @密度~1.08 ≈ 210K + 64K ≈ 274K > 262,144 → 400 ✓（双自由度拟合：密度与预留同为边界反推，任意预留值都能调密度「吻合」——不构成实测，但修法不依赖它：显式 max_tokens 后服务端默认值不再影响合成路径） | 两组失败样本交叉吻合 ~64K |
| 正杠杆 | 显式传 max_tokens=4,096 → 输入容量 = 262,144 − 4,096 − 固定段 ≈ **258K tokens（+30%）** | 合成输出实证 ≤2,415 chars（≤~1K tokens，prompt 规则 7 自限 ≤2000 tokens），4,096 余量 4 倍 |

### 全量合成样本回放（13 例，枚举自日志）

| 时间 | alias | prompt chars | 结果 | 备注 |
|---|---|---|---|---|
| 09-17 08:20 | kimi(1M) | 249,038 | ✅ completed | 1M 窗口非约束 |
| 09-20 11:20 | glm(1M) | 393,822 | ✅ completed | glm 窗口实为 1M（config:57，v1 文档「128K/192K」失实，检视严重 4 修正） |
| 09-20 15:15 | glm(1M) | 334,009 | ✅ completed | 同上 |
| 09-23 08:10 | kimi-256k | 362,272 | ❌ 400 | 密度 ~1.8 |
| 09-23 08:14 | kimi(1M) | 956,403 | ✅ completed | |
| 09-23 08:16 | kimi-256k | 386,809 | ❌ 400 | |
| 09-23 14:21 | kimi-256k | 566,216 | ❌ 400 | shadow channel starting → 合成真跑 → token limit 400 → degrading（#1146 当日 20:25 才合入，此刻预检不存在） |
| 09-23 20:25 | kimi-256k | 566,216 | ✅ 预检拦下 | #1146 预检生效案例（prompt still over window after trim，budgetChars 524,288） |
| 09-23 08:5x | kimi-256k | 14,713 / 9,053 | ✅ completed ×2 | 小样本成功 |
| 09-23 1x:xx | kimi(1M) | 138,338 | ✅ completed | |
| 09-23 1x:xx | kimi-256k | 614,960 | ❌ 400 | |
| 09-24 08:34 | kimi-256k | 227,110 | ❌ 400 | **最小失败样本**（密度 ~1.08，尾部） |
| 09-23 08:38 | kimi-256k | 41,951 | ⏱ timeout 但 completed | 引擎 50s 测试超时，通道本身成功（epoch 实读：比 227,110 案例早 23.9 小时） |

**夹逼法定标**：最小失败 227,110 chars → 预算上限 = 227,110 × 0.8 = **181,688 chars @262K 窗口**（0.8× 因子防内容密度方差 ~20%）；跨窗口按占比缩放（1M → 726,752）。**1M 档泛化是保守外推（安全方向）**：最大成功 956,403 > 726,752——(726,752, 956,403] 区间现状可全量合成，修复后最老 ~24% 会被裁（确定的保真代价，接受：裁方向安全不漏放 400；1M 保真特例留待实测驱动再调）。已知最大成功（256k 档）41,951 < 181,688 ✓。**夹逼缺口 (41,951, 227,110) 内无成败样本——0.8× 即残余风险定价**。交叉验证（非定标依据）：181,688 chars @尾部密度1.15 ≈ 158K tokens，显式 max_tokens=4,096 后 ≈ 162K/262,144 = 使用率 62%（余量 38%）。

### 既有 400 失败清单（232 条 `exceeded k3-256k`）

抽样核查：含 `SDK compaction failed`（pi 内部自动压缩，非本特性范围）与 handoff 合成两类。本特性只修后者；前者在显式 max_tokens 落地后同样受益（SDK 内部也走同一 provider 的 Model.maxTokens——但它走 model.maxTokens=8,192 模板值，本来就有参数，不受影响）。

## 根因（v2：三个独立缺陷叠加）

1. **输出预留失控**：合成请求未显式传 max_tokens → 服务端默认 ~64K 预留吃掉 25% 窗口——**这是最大的单点杠杆**，不修它只修公式，预算要压到失败线以下会过度裁剪（181,688 chars 的预算 vs 容量 258K tokens，本可以更宽松）
2. **预算口径错误**：trim/预检拿「请求总预算 262,144」当「输入容量」，且 trim 预算是「历史段」口径、预检是「全文」口径（检视严重 3）——两个错误叠加出「trim 裁满仍被预检拦」的自相矛盾
3. **modelOverride 丢弃**（检视严重 5）：端口声明第三参、唯一实现没接——换模型重启预算按新模型算、请求发给旧模型，必 400。这是「下一个补丁打错位置」的引信，必须同 PR 修

## 修法（修法决策树①：既有机制语义内修）

### 改动点 1：显式合成专用 max_tokens（pi-session-factory.ts）

影子 session prompt 前，经 SDK 模型解析拿到 Model 后，调用合成时显式传 `maxTokens: 4_096`（合成输出实证 ≤2,415 chars ≤ ~1K tokens，prompt 规则 7 自限 ≤2000 tokens，4 倍余量）。SDK 链路：`options.maxTokens` → `max_output_tokens`（openai-responses）/ `max_tokens`（anthropic-messages）。**输入容量从 ~198K 扩到 ~258K（+30%）**——不修公式只修参数就能救回 09-23 的 362K/386K 案例（@密度1.8 ≈ 201K/215K tokens < 258K ✓）。

### 改动点 2：统一全文预算函数（narrative-synthesis-engine.ts）

```ts
/** F20260924swin：合成全文预算（chars）——trim 与预检共享的唯一预算对象。
 *  定标（夹逼法，只用实测成败样本，不依赖容量/密度推导链，锚点见特性文档「全量合成样本回放」）：
 *    最小失败 227,110 chars（09-24 大獭）× 0.8 余量（防内容密度方差 ~20%）= 181,688 chars @262K 窗口；
 *    已知最大成功（262K 档）41,951 chars < 181,688 ✓。
 *  跨窗口泛化：按窗口占比缩放（= 181,688/262,144）——1M 窗口 → 726,752 chars。
 *    注意（保守外推，安全方向）：1M 档最大成功样本 956,403 > 726,752——预算低于已证成功线，
 *    (726,752, 956,403] 区间的输入现状可全量合成，修复后最老 ~24% 会被裁（确定的保真代价）。
 *    接受该代价：裁方向安全（不漏放 400），1M 档保真特例（如 max(占比, 成功线×1.1)）留待实测驱动再调。
 *  夹逼缺口 (41,951, 227,110) 内无成败样本——0.8× 因子即为此缺口的残余风险定价（见特性文档「已知风险」）。
 *  预算对象 = 全文（含固定段）；trim 内部用「全文预算 − 固定段实测」裁历史段，
 *  公式内不再扣固定段（实测在 trim 内扣，此处只定天花板）。 */
const SYNTHESIS_BUDGET_WINDOW_RATIO = 181_688 / 262_144; // 精确分数（不写三位小数——262144×0.693=181,664 漂移 24 chars）
export function synthesisFullBudgetChars(contextWindowTokens: number): number {
  return Math.floor(contextWindowTokens * SYNTHESIS_BUDGET_WINDOW_RATIO);
}
```

- `SYNTHESIS_EXPLICIT_MAX_TOKENS = 4_096`（与改动点 1 同值，单一真相源——显式 max_tokens 是「扩容量」的正杠杆，预算是「防超窗」的兜底，两者独立生效）
- `trimMessagesToBudget` 内部改为：`historyBudget = synthesisFullBudgetChars(window) − measuredFixedChars`（固定段实测长度，不再拍 10K token 假设）
- **预检改用同一函数**（改动点 3）：`prompt.length > synthesisFullBudgetChars(window)` 即拦——trim 的产物（全文 ≤ 预算）天然过预检，不再自拦

### 改动点 3：modelOverride 链路修通（pi-session-factory.ts + agent-invoker.ts）

- `runCompactionSynthesis(otterId, prompt, modelOverride?)` 实现接第三参：模型解析优先 `modelOverride`，缺省回退 otterConfigProvider（既有行为）
- agent-invoker 合成调用点把 `modelAlias`（用户选的新模型）传下去——预算模型 = 执行模型，换模型重启不再错配
- 回归测试：换模型重启场景（kimi-256k → kimi 1M）断言预算按新模型算且请求发给新模型

### 改动点 4：层约束管道（检视建议 3）

`synthesisFullBudgetChars` 经 `HandoffEngineDeps` 端口注入 agent-invoker（既有模式，不跨层 import frameworks 常量）。

## 机制识别检查点（v2 重判，检视建议 4 推动）

- □ 新增配置字段/枚举/开关——**不命中**（max_tokens 硬编码 4,096 非 config 字段；无枚举表——v1 的分档表已随严重 2 删除）
- □ 新增状态生命周期——不命中
- □ 新增定时任务/后台进程——不命中
- □ 新增信号类型/消息格式——不命中
- □ 新增持久化存储——不命中
- □ 新增决策分支（结果被记住影响后续）——不命中
- □ 新增跨模块调用路径——**不命中**（modelOverride 第三参走既有端口声明，预算函数经既有 Deps 端口注入）

**判定：不涉及净新增机制** → Modification-Class `narrow-fix`。v1 的分档表已删，建议 4 的擦边球自动消解。

## 设计取舍（v2 重写）

| 取舍 | 决策 | 替代 | 理由 |
|---|---|---|---|
| max_tokens：显式 4,096 vs 不显式（修公式适配服务端默认 64K） | **显式 4,096** | 预算按容量 198K 定标 | 输出实证 ≤1K tokens，64K 预留是纯浪费；显式 4K 输入容量 +30%，同样预算下裁剪更轻（信息保留更多）。这是检视严重 2 指出的「正杠杆」，不用白不用 |
| max_tokens 值：4,096 vs 8,192（模板值） | 4,096 | 8,192 | 输出 ≤1K 实测 + 规则自限 ≤2K，4K 余量 4 倍足够；8K 白吃 4K 输入容量。若未来合成输出变长（规则改版），按实测再调——硬编码注释锚定实测 |
| 预算定标：夹逼法（失败线 ×0.8）vs 理论推导（容量 × 密度） | **夹逼法** | 纯理论 | 容量/密度都是推导值（错误信息不给明细），夹逼法只用实测成败样本定常数，不依赖推导链。理论值（181,688 @1.15 ≈158K << 258K）作为交叉验证，不是定标依据 |
| 预算对象：全文统一 vs trim/预检各自口径 | **全文统一** | 各自口径 | 检视严重 3：各自口径导致「预检拦 trim 产物」自相矛盾。全文预算 − 固定段实测 = 历史段预算，一处定义两处复用 |
| 固定段：实测 vs 10K token 假设 | **实测** | 10K 假设 | 固定段三源（机械供料/previousSummary/selfSummary）长度运行时可知，实测零成本；10K 假设是 #1130 留的近似，selfSummary 无界（检视建议 2）会击穿假设 |
| selfSummary 上限：截断 vs 不动 | **不动（留观察）** | 截断保头 | 实测 selfSummary 是 LLM 自己写的（≤500 字规则），用户手动粘贴任意长是边缘场景；预检会拦（拦了走机械档案，不致命）。截断是新分支，为边缘场景加分支不划算。观测锚：预检拦截日志的 promptChars 字段 |
| 水位阈值 240K vs 实际容量 ~198K（不显式 max_tokens 时） | **挂观察 issue，本 PR 不改** | 降到 190K | 阈值是「何时触发交接」的产品取舍（留多少余量跑当前 turn），不是容量口径错误；且本 PR 显式 max_tokens 后实际容量变 258K > 240K，矛盾自动消解大半。观察 issue 记「若未来阈值 > 容量再次出现」的检测锚 |

## 对立假设质询（v2，含检视修正后的全量结论）

| 质询 | 检验 | 结论 |
|---|---|---|
| H1：还有没有其他窗口口径错误？ | 全仓 `contextWindow` 消费点 + 水位计量口径 | trim/预检本 PR 修；**水位阈值口径是真实 usage（input+output+cache 四项合计，context-tokens.ts:4），不是 SDK 估算——检视建议 7 的「3 倍形同虚设」不成立**；但「阈值 240K vs 不显式 max_tokens 时实际容量 ~198K」存在阈值 > 容量矛盾（水位触发时 session 已超窗跑不动），本 PR 显式 max_tokens 后容量 258K > 240K 矛盾消解，残余挂观察 issue |
| H2：SDK tokensBefore 估算可信吗？ | 与服务端实测对比 | 不可信（3.19 chars/token vs 实测 1.08~2.16），但只用于 findCutPoint 切保留窗口（切多切少不影响 400），不用于预算——本特性不依赖 |
| H3：服务端默认预留 64K 会不会变？ | Kimi 端点行为 | 可能变——但本 PR 显式 max_tokens 后，服务端默认值不再影响合成路径（参数已显式）。H3 问题被改动点 1 根治 |
| H4：glm 预留档证据 | config 实读 | glm 窗口实为 **1,048,576**（config.yaml:57，v1「128K/192K」失实）——393,822 chars 成功对预留无约束力。v2 删分档表，glm 不再单列；glm 走同一公式（窗口 1M，预算自然大） |
| H5：固定段无上限 | 三源枚举 | 机械供料（实测 92 chars）+ previousSummary（压缩过）+ **selfSummary（v1 漏列，LLM 自写 ≤500 字规则但用户可粘贴任意长）**。决策：不加上限留观察，观测锚 = 预检拦截日志 promptChars；预检修对（严重 3）后拦截可靠 |
| H6：动机案例修复后可合成？ | 数学验证 | 227,110 > 预算 181,688 → trim 必裁 → 裁后全文 ≤ 181,688 chars @尾部密度1.15 ≈ 158K tokens + 4,096 ≈ 162K/262,144 = 使用率 62%（余量 38%）✓。09-23 的 362K/386K 案例：若密度 ~1.8 ≈ 201K/215K < 258K 新容量可不裁合成；若密度在尾部 1.08-1.15，386K chars ≈ 336K tokens > 258K → 自动裁剪兜住（裁到 181,688 → 可合成）——「修复后可合成」对全密度区间成立，「不裁也」只对非尾部密度成立。provider 路径注记：anthropic-messages 路径另有 `clampMaxTokensToContext`（simple-options.js:3-9，按 SDK 估算再减 4,096）——1M 窗口无感，未来小窗 anthropic 模型有感；openai 路径下限 `OPENAI_RESPONSES_MIN_OUTPUT_TOKENS=16`，4,096 安全 |
| H7：必死区（>63 万 chars）修复后？ | 公式验证 | 预算 181,688 chars：63 万 → 裁 71%；100 万 → 裁 82%。裁得动 + 预检双保险。**必死区数学消失** |
| H9（新增）：夹逼缺口的残余风险？ | (41,951, 227,110) 区间无成败样本 | 预算取缺口**上沿**（失败线 227,110）× 0.8 = 离上沿还有 20% 余量；若真实失败线低于 227,110（更小 chars 也会 400 的极端密度内容存在），trim 裁到 181,688 仍可能 400——预检拦下走机械档案兜底（不致命，付一次学费）。观测锚：trim 日志（本 PR 补）+ 合成 400 日志 |
| H8（新增）：显式 max_tokens 会不会被 SDK clamp 吃掉？ | SDK 链路 | `clampMaxTokensToContext`：available = contextWindow − estimateContextTokens(context) − CONTEXT_SAFETY_TOKENS，`Math.min(maxTokens, Math.max(MIN_MAX_TOKENS, available))`——available 为负时取 MIN_MAX_TOKENS（16），max_tokens 仍发送（小值）。不会被吃掉，只会被压小，方向安全 |

## 影响范围

| 面 | 影响 | 方向 |
|---|---|---|
| 大 session（>18 万 chars） | trim 裁到 181,688 chars 预算内，显式 max_tokens 后容量 258K → 合成成功率大幅 ↑ | 信息保留比 v1 方案更多（预算 181K vs v1 的 242K 但容量从 210K→258K，实际可合成的上限更高） |
| 09-23 的 362K/386K 案例 | 修复后**可合成**（全密度区间成立）：非尾部密度 ~1.8 → 201K/215K < 258K 新容量不裁也能合成；尾部密度 1.08-1.15 → 386K chars ≈ 336K tokens > 258K → 自动裁剪到 181,688 兕住 | 灰色地带全部变可合成 |
| 小 session（<18 万 chars） | 预算 181,688 > 其长度，trim 不触发 | 无变化 |
| 换模型重启 | modelOverride 链路修通，预算=执行模型 | 从「必 400」变「正确」 |
| glm/mimo 路径 | 统一公式（窗口 1M → 预算自然大），无分档 | 行为更宽松，与实证一致 |
| #1148 | 本特性并入（改写 issue 目标为「观察：服务端默认预留变化 + 水位阈值 vs 容量矛盾」） | 不重复开战线 |

## 验证

1. **失败证据（修复前）**：otter-buddy.log:1247339-1247341（227,110 → 400 → 机械档案）；全量样本回放表（13 例枚举）
2. **回归测试（修复后必过）**：
   - 动机案例：22.2 万 chars 合成数据（227,110 实证同档；造数为合成、非 jsonl 真实切片——测试名已名实相符）→ **dropped ≥ 1 且 trim 后全文 ≤ 181,688 且预检放行**（单分支——227K > 预算必裁，「dropped=0 放行」分支恰是公式写错时的 bug 行为，断言不得兼容）
   - 必死区：100 万 chars 输入 → trim 后全文 ≤ 181,688 chars（裁到位）
   - 不误裁：15 万 chars 输入（< 预算 181,688）→ dropped 0；20 万 chars 输入 → 裁但保留最近段（裁最老保最近语义）
   - 预检一致性：trim 裁满的产物（全文=预算）→ 预检放行（不自拦）；超预算 prompt → 拦下走机械档案
   - 换模型重启：kimi-256k → kimi(1M)，断言预算按 kimi 算 + runCompactionSynthesis 收到 modelOverride=kimi
   - max_tokens 显式：断言影子 session 的 prompt 调用链带了 maxTokens=4,096（mock SDK 层验证参数）
3. **全量测试**：`npx vitest run` 全绿 + tsc + eslint
4. **生产验证**（合入后搭档操作）：重启系统 → 手动重启大獭獭生 → 预期走叙事合成；若仍降级，日志时间点甩我

## 未决问题

- Kimi 服务端默认预留 ~64K 是实测交叉定位（非官方文档），显式 max_tokens 后不再影响合成路径，但 SDK auto-compaction 路径仍受服务端默认影响（非本特性范围，观察锚：`SDK compaction failed` 日志频率）
- mimo-pro/mimo-flash 的合成输出长度未实测（取 4,096 统一值）——若实际输出 >4K 被截断（lastStopReason=length），fail-closed 拒入库走机械档案，不致命；观测锚：截断日志

## 决策史（审视轮次回写）

### 一轮（检视獭-swin，mimo-pro）：需要修改（5 严重 7 建议）

| 发现 | 处置 | 分类 |
|---|---|---|
| 严重1：预算 242,573 > 失败线 227,110，动机案例必复现 | 采纳——夹逼法重定标（预算 181,688 = 227,110 × 0.8） | 本方案修复 |
| 严重2：输出预留 50K 无锚点且被请求参数反证；正杠杆闲置 | 采纳且深化——核查发现 max_tokens 根本没发送（SDK falsy 跳过分支），真值是服务端默认 ~64K；显式 max_tokens=4,096 成为改动点 1（正杠杆） | 本方案修复 |
| 严重3：trim/预检预算对象口径混用，预检自拦 trim 产物 | 采纳——统一全文预算函数（synthesisFullBudgetChars），trim 用「全文 − 固定段实测」，预检比全文 | 本方案修复 |
| 严重4：glm 窗口 1M 非 128K/192K，8K 档证据崩塌 | 采纳——删分档表，统一公式（窗口大预算自然大）；文档事实错误全部修正 | 本方案修复 |
| 严重5：modelOverride 被唯一实现丢弃，换模型预算锚错 | 采纳——链路修通（改动点 3）+ 换模型回归测试 | 本方案修复 |
| 建议1：探针 363K vs 生产 227K 偏差 60% 未解释 | 采纳——已解开（jsonl 交接后增长，生产切片是触发瞬间快照）；文档对齐两数；回归测试用同量级合成数据（真实切片未落地——jsonl fixture 未引入，delta 复核建议3 后测试名已名实相符） | 本方案修复 |
| 建议2：H5 漏 selfSummary 无界 | 采纳——H5 补 selfSummary；决策不截断留观察（边缘场景 + 预检兜底），观测锚写死 | 本方案修复 |
| 建议3：预算函数跨层 import 撞层约束 | 采纳——经 HandoffEngineDeps 端口注入（改动点 4） | 本方案修复 |
| 建议4：机制检查点「枚举/开关」擦边球 | 采纳——分档表已删（严重 2 处置附带），擦边球自动消解；判定重写 | 本方案修复 |
| 建议5：#1148 并入二选一定死 | 采纳——定死「改写 issue 目标为观察项」，frontmatter fixes_issue 保持 1148 | 本方案修复 |
| 建议6：frontmatter modules 含 config.yaml 与非目标矛盾 | 采纳——v2 modules 删 config.yaml（改动点不动 config） | 本方案修复 |
| 建议7：水位计量口径「3 倍形同虚设」 | **部分驳回**——水位口径是真实 usage（context-tokens.ts:4 实读），不是 SDK 估算；但「阈值 240K vs 不显式 max_tokens 时容量 ~198K」矛盾属实，本 PR 显式 max_tokens 后消解大半，残余挂观察 issue（#1148 改写时并入） | 驳回（附证据）+ 残余建 issue |

### 二轮 delta（检视獭-swin）：需要修改（3 严重 4 建议）

| 发现 | 处置 | 分类 |
|---|---|---|
| 严重A：公式 snippet（(262144−4096−10000)×1.15=285,255）与定标 181,688 矛盾 + 固定段双重扣减 + 跨窗口规则缺失 | 采纳——snippet 改为直接实现夹逼占比缩放（`window × 0.693`），删 FIXED_OVERHEAD 扣减（固定段由 trim 内 measuredFixedChars 单点覆盖），跨窗口规则写明（1M → 726,752 < 956,403 ✓） | 本方案修复 |
| 严重B：动机案例断言「dropped=0 放行」兼容 bug 行为（空转）+「20 万不误裁」对正确实现必红 | 采纳——断言改单分支「dropped ≥ 1 且 ≤ 181,688 且预检放行」；不误裁边界随预算改 15 万；补 20 万「裁但保最近段」用例 | 本方案修复 |
| 严重C1：「生产 trim 实际裁了」无锚点且数学不闭合（生产触发需 pre-trim > 731,856，全量才 362,732） | 采纳——改口「trim 未触发」为数学闭合结论，「裁没裁」降级为观测缺口假设；本 PR 补 trim 日志（输入/预算/droppedCount/输出）作观测锚 | 本方案修复 |
| 严重C2：「566,216 预检拦下（#1146 生效）」与日志相反（09-23 14:21 真跑了合成 → 400；20:25 的才是预检拦下） | 采纳——样本表改回实况（两行分述） | 本方案修复 |
| 严重C3：「41,951 09-24 08:39」日期错一天 | 采纳——改 09-23 08:38（epoch 实读） | 本方案修复 |
| 建议1：「服务端默认 ~64K 实测吻合」措辞过强（双自由度拟合） | 采纳——降级为「推断 ~64K」，注明修法不依赖它 | 本方案修复 |
| 建议2：「362K/386K 不裁也能合成 @1.8」降级 + provider 路径注记 | 采纳——H6 改为「全密度区间可合成（非尾部密度不裁 / 尾部密度自动裁剪兜住）」；补 clampMaxTokensToContext / MIN_OUTPUT_TOKENS=16 注记 | 本方案修复 |
| 建议3：夹逼缺口 (41,951, 227,110) 无样本 + 余量方向反（62% 是使用率非余量） | 采纳——缺口与 0.8× 残余风险写入 H9 + 定标段；「余量 62%」全部改为「使用率 62%（余量 38%）」 | 本方案修复 |
| 建议4：20 万不误裁边界数字随预算同步 | 采纳——并入严重B 处置 | 本方案修复 |

**检视獭自我修正留痕（A2 示范）**：v1 严重2「请求实际带 max_tokens=8,192」认错（把 Model.maxTokens 工厂层当成请求参数发送层，openai-responses.js:235 falsy 跳过分支实锤）；v1 建议7「水位虚标 3 倍」收回（usage 真实口径实读）。

### 三轮 delta（检视獭-swin）：通过（三轮收敛）

3 严重 4 建议处置核验 7/7 全真、无夹带。merge 前落实清单 3 条（零代码阻塞）全部采纳并当场落实：

1. **1M 泛化「✓」方向失真**：采纳——标注改「保守外推（安全方向）」+ 保真代价量化（(726,752, 956,403] 区间最老 ~24% 会被裁）；**L1 拍板：不加 1M 保真特例**——特例公式（max(占比, 成功线×1.1)）是把「单点实测」当成「容量证明」，与夹逼法「只用成败样本」的方法论矛盾；接受保守方向的确定保真代价，留待 1M 档实测失败样本出现再校准（观测锚：trim 日志）。理由记此。
2. **比率常数表达漂移**：采纳——实现用精确分数 `181_688 / 262_144`，注释写明「不写三位小数（262144×0.693=181,664 漂移 24 chars）」。
3. **H9 措辞反向**：采纳——「下沿」改「上沿」两处。

**检视獭自我修正留痕**：二轮严重C2「#1146 09-24 合的」口误认领（实际 09-23 ~20:25 合入并即时生效，20:25 预检拦截日志为证）。

**收敛记录**：一轮 5 严重 7 建议 → v2；二轮 3 严重 4 建议 → v3；三轮 3 条零阻塞落实项 → **通过**。验收基线 = 验证节（动机案例单分支断言 + 换模型重启回归 + trim 观测日志 + 15/20 万边界用例）。

## 实现记录（2026-09-24，搭档拍板「开工干吧」后）

四个改动点全部落地，全量 281 文件 3,961 测试通过（本 PR 净增 9 用例，rebase 基线 1b2afc10；检视獭独立实测与实现者双源一致）、tsc/eslint 0 error：

| 改动点 | 落地 | 关键决策 |
|---|---|---|
| ① 显式 max_tokens | `pi-session-factory.ts:450`：`resolvedModel = { ...resolvedModel, maxTokens: SYNTHESIS_EXPLICIT_MAX_TOKENS }`——走 `buildBaseOptions` 的 `options?.maxTokens ?? model.maxTokens` 既有管道（simple-options.js:11），不包 streamFn（包 streamFn 会碰 SDK 内部束结，spread 是最小侵入）。常量在 narrative-synthesis-engine 导出（单一真相源），同包 import 不撞层约束 |
| ② 统一全文预算 | `narrative-synthesis-engine.ts`：`synthesisFullBudgetChars`（夹逼占比 181,688/262,144）+ `trimMessagesToBudget` 第三参 `measuredFixedChars`（delta 复核建议2 后必填，legacy 旧口径公式已删除——无生产消费者）。`buildNarrativeSynthesisPrompt` 两遍组装实测固定段（序列化是纯拼接，百 ms 级可接受）。`BudgetTrimResult` 加 `inputChars`/`historyBudgetChars` 观测字段 |
| ③ modelOverride 链路 | `pi-session-factory.ts` 实现接第三参（优先于 otterConfig）；`agent-invoker.ts runShadowSynthesis` 本就透传（链路断点只在实现侧） |
| ④ trim 观测日志 | `NarrativeSynthesisInput.onTrim` 回调（缺省静默，测试/旧调用无感）→ `agent-invoker.ts` 落 `[handoff] synthesis trim` 日志（inputChars/measuredFixedChars/historyBudgetChars/droppedCount/promptChars）；预检改由 `HandoffEngineDeps.synthesisFullBudgetChars` 端口注入（platforms.ts 接线），`SYNTHESIS_PRECHECK_CHARS_PER_TOKEN` 常数退役 |

**测试钉死**（防「断言与 bug 行为兼容」的教训）：动机案例单分支断言（dropped ≥ 1 且全文 ≤ 预算且预检放行）；换模型重启双钉（invoker 层 override 透传 + factory 层模型解析优先）；15 万不误裁 / 20 万裁但保最近段；trim-预检同对象断言（裁满产物天然过预检）。

## delta 处置记录（检视獭-岚 代码对抗审视，2026-09-24）

**初轮**（5 严重 + 5 建议）→ 5 严重全修：rebase main、补 `Modification-Class: narrow-fix`、frontmatter 悬空引用修正、trim-note 预算三层闭合（`TRIM_NOTE_RESERVE_CHARS=200` 恒定预留 + 实测回退 + 断言零余量）、模块位 `[agent]`→`[context]`（#1159 黑名单）。建议 2/3/4/5 采纳（三参必填删 legacy、端口必填防 fail-open、测试名实相符、onTrim 真实输入长度）；建议 1 驳回（截断观测锚已存在三处），岚接受。

**二轮 delta**：初轮 5 严重闭合确认 + 严重4 本体三证通过；新增 B2（文档 3 处现状失实）+ 2 建议 → 处置：B2 回写本段上方三处；建议 1 处方 a（贴顶真边界两跑法替代旧用例——旧用例距边界 ≈30k 不区分修复前后，新用例修复前必红 + 常数下调 <85 必红）；建议 2 计数统一（commit/PR body/本文档对齐 281/3,961）。

**贴顶用例附带战果**：上岗即抓真 bug——增量估算循环混用 total（整体序列化）与 perMsg（单条序列化之和）两口径，分隔符差异导致贴顶消息被误丢（droppedCount=2 应为 1）；已改单口径（perMsg 和）定位 + 实测回退终局判据。
