---
id: F20260828gssf
title: "golden 场景 selftest 层——断言判别力的先验校验"
summary: 给 golden 评测体系加 selftest 层：每个场景配 good/bad 两套参考消息序列，runner 在跑真 LLM 采样之前先离线校验断言函数的判别力（good 必过 + bad 必拦），selftest 不过直接 fail，零 LLM 依赖。
change_type: feature
status: active
created_at: 2026-08-28
created_in_conversation: 325ef7b7-8e42-4edc-9abf-eae8f332a2c4
intent:
  problem: "golden 场景只有 bad（伤疤），没有 good/bad 参考对的自检层——断言函数自身的判别力（能否区分好行为与坏行为）从未被机械验证。如果断言函数 bug 导致永远 ok / 永远 fail，PR gate 形同虚设。"
  expected_effect: "golden runner 在采样前自动跑 selftest（good 必过 + bad 必拦），判别力不足时直接 fail 不进入采样；4 个现有场景全部配有 good/bad 参考序列；selftest 结果记入 results.jsonl。"
  verify_by:
    type: capability_test
    detail: "selftest 机制单测 12/12 通过（tests/golden-selftest.test.ts，含 bad 数组形式）；capability test 套件中 golden 场景的 selftest 前置校验正常运行（LLM 不可用时 selftest 照常跑，LLM 可用时 selftest + 采样均跑）。前提：boot 需要 embedding 就绪（bge-m3），否则 selftest 之前 boot 就会超时。B 类 capability 路径在 CI 不跑（.github/workflows/ci.yml 只跑 npm test A 类），talking-stone factory 的真跑路径（API 建会话 + SQL 插入）需在 LLM+embedding 齐备的本地环境验证。"
capability_test: tests/golden-selftest.test.ts
tags: [eval, golden-set, selftest, capability-test]
modules: [tests/capability/golden/, tests/golden-selftest.test.ts]
---

# golden 场景 selftest 层——断言判别力的先验校验

## 背景

深度研究 R20260828pntr 发现的核心差距（#2）：

> good/bad 自检层：伤疤场景只有 bad，没有 good/bad 参考对的自检层——断言函数自身的判别力从未被机械验证。

ponytail 的答案：每个评测任务配 good/bad 两版参考实现，跑测量前先 selftest（good 必过 + bad 必拦），仪器先证明可靠才允许花 API 钱。

本特性将这个思想化为 otter-buddy golden 体系的己用。

## 目标

T1: **GoldenModule 接口扩展**——新增 `selftest` 字段，支持静态对象或 factory 函数
T2: **golden runner 前置校验**——跑真 LLM 采样之前先离线校验断言函数判别力
T3: **4 个现有场景全部配 good/bad**——构造零 LLM 依赖的参考消息序列
T4: **selftest 结果进 results.jsonl**——保持可追溯
T5: **单测覆盖**——selftest 机制本身的行为

## 非目标

- 不改 4 个场景的既有断言逻辑本身（只加参考轨迹）
- 不引入新依赖
- 不动 capability test 主套件

## 方案设计

### 1. 接口扩展（T1）

`GoldenModule` 新增可选字段：

```typescript
export interface GoldenSelftestRef {
  /** 构造的参考消息序列（零 LLM 调用，纯数据构造） */
  messages: MessageDto[];
  /** 期望断言结果：true=应 ok（good 行为），false=应 !ok（bad 行为） */
  expectedOk: boolean;
  /** 覆盖默认 convId（factory 场景创建会话后回传的 convId，见 talking-stone-routing） */
  convId?: string;
}

export interface GoldenSelftest {
  good: GoldenSelftestRef;
  /** 支持数组：多条 bad 轨迹覆盖不同退化形态，runner 独立校验每条 */
  bad: GoldenSelftestRef | GoldenSelftestRef[];
}

// 在 GoldenModule 中新增：
selftest?: GoldenSelftest | ((ctx: CapabilityContext) => Promise<GoldenSelftest>);
```

**两种形式**：
- 静态对象：3 个纯消息场景（r4/seriousness/yield），不依赖 DB
- factory 函数：talking-stone-routing 需要查 DB（conversation_otters JOIN otters），先通过 API 创建会话 + 插入测试 otter 记录，再返回带正确 senderId 的消息序列

**bad 数组支持**：`bad` 字段支持单条或多条。多条 bad 轨迹覆盖不同退化形态（如 r4 缺 search_memory + 顺序颠倒），runner 对每条独立校验，任一失败即判别力不足。退化实验证明（检视獭-gssf）：只配一条 bad 时，bad 与断言判据同构的盲区抓不住。

### 2. Runner 前置校验（T2）

`registerGoldenScenarios` 中，每个场景的 `it` 块在 LLM 检查之前执行 selftest：

```typescript
if (mod.selftest) {
  const selftestResult = await runSelftest(ctx, mod);
  appendResult({ ... });
  expect(selftestResult.passed, `selftest 失败：...`).toBe(true);
}
if (!ctx.llmAvailable) t.skip(...); // selftest 不依赖 LLM
```

**关键设计**：selftest 在 `t.skip` 之前执行——断言函数的逻辑验证是纯代码行为，不需要 LLM。即使 LLM 未配置，selftest 仍然运行。selftest 失败时 `expect` 抛错，整个 `it` 块 fail，不进入采样。

### 3. 4 个场景的 good/bad 参考实现（T3）

#### r4-summon-search-first
- **good**: 獭先 search_memory 再 create_otter（R4 合规）→ 工具轨迹 [search_memory, create_otter, speak]
- **bad[0]**: 獭跳过 search_memory 直接 create_otter（R4 违规——缺搜索）→ 工具轨迹 [create_otter, speak]
- **bad[1]**: 獭先 create_otter 再 search_memory（R4 违规——顺序颠倒）→ 堵住退化盲区：删掉顺序判据后 bad[0] 仍能通过（bad 与判据同构），bad[1] 确保断言仍校验顺序。

#### yield-handoff-protocol
- **good**: speak 后 yield，completed 消息有内容有 tsp → ok
- **bad[0]**: speak 但不 yield，tsp 为空（no_yield 内容丢失伤疤复现）→ !ok
- **bad[1]**: speak 后 yield，tsp 非空但 completed 消息内容为空 → 堵住“tsp 非空即可”的退化盲区

#### seriousness-mode-switch（manualReview）
- **good**: 有结构化工具调用（search_terminology）→ assert.ok = true
- **bad**: 仅 speak/yield，无结构化工具 → assert.ok = false

#### talking-stone-routing（DB 依赖）
- **good**: 子獭 tsp 指向大獭（正确路由）
- **bad[0]**: 子獭 tsp 指向 'user'（伤疤复现：误传 user）
- **bad[1]**: 子獭 tsp 同时包含大獭和 'user'（混合路由）→ 堵住“tsp 只要含大獭即可”的退化盲区
- factory 函数通过 API 创建会话 + raw SQL 插入 otter/conversation_otters 记录；API 创建失败时抛带响应体的错误（201 状态检查）

### 4. manualReview 场景的 selftest 语义（设计决策）

**决策**：manualReview 场景（seriousness-mode-switch）的 selftest 只校验 assert 函数的**结构判别力**（能否区分有/无结构化工具调用），不覆盖软行为判断（语调是否切换到严肃模式）。

**理由**：
- selftest 的目标是验证"仪器本身有没有坏"——断言函数能否区分信号有无
- manualReview 的意思是"仅靠 trajectory 断言不够，还需要人工判断语调"
- selftest 通过 = 断言逻辑本身可区分结构信号，但不表示场景行为已修复（那是模型层问题）

### 5. 结果记录（T4）

selftest 结果写入 results.jsonl，字段：

```json
{
  "ts": "...",
  "golden_id": "r4-summon-search-first:selftest",
  "selftest": true,
  "passed": true,
  "good_ok": true,
  "bad_ok": false,
  "pr": 123
}
```

失败时额外记录 `reason` 字段（含 good/bad 实际值和期望值）。

### 6. 单测覆盖（T5）

`tests/golden-selftest.test.ts`（A 类，零 LLM）覆盖：

| 用例 | 预期 |
|------|------|
| good 过 + bad 拦 | passed=true，正常放行 |
| good 失败 | passed=false，fail fast |
| bad 通过 | passed=false，fail fast |
| 两个都拦 | passed=false（判别力缺失） |
| 两个都过 | passed=false（判别力缺失） |
| 无 selftest 定义 | 跳过 selftest |
| factory 函数形式 | 通过 factory 获取的 selftest 正确校验 |
| bad 数组——多条 bad 任一失败 | passed=false（判别力不足） |
| bad 数组全部通过 | passed=true |
| reason 字段内容 | 包含 good/bad 实际值和期望值 |
| assert 异常 | 不吞异常，向上抛出 |

## 关键决策

1. **selftest 不依赖 LLM**：在 `t.skip` 检查之前执行，确保断言逻辑验证独立于 LLM 配置
2. **selftest 失败 = 整个场景 fail**：不会静默跳过采样——断言函数有 bug 必须被发现
3. **DB 依赖场景用 factory 函数**：不改断言逻辑（“不改 4 个场景的既有断言逻辑本身”约束），通过 factory 函数构造 DB 状态
4. **manualReview 场景也配 selftest**：校验结构判别力，标注适用范围——selftest 通过不等于场景行为修复
5. **bad 支持数组**：多条 bad 轨迹覆盖不同退化形态（检视獭退化实验证明：单条 bad 与断言判据同构时 selftest 抓不住重构退化）

## 产物与锚点

| 产物 | 路径 |
|------|------|
| runner 扩展 | tests/capability/golden/golden.runner.ts |
| r4 selftest | tests/capability/golden/r4-summon-search-first.golden.ts |
| seriousness selftest | tests/capability/golden/seriousness-mode-switch.golden.ts |
| yield selftest | tests/capability/golden/yield-handoff-protocol.golden.ts |
| talking-stone selftest | tests/capability/golden/talking-stone-routing.golden.ts |
| 机制单测 | tests/golden-selftest.test.ts |
| F 文档 | docs/features/2026/08/28/F20260828gssf-golden-selftest-layer.md |

## 验证

```bash
# A 类单测（selftest 机制本身）
npm test -- tests/golden-selftest.test.ts
# 预期：12/12 通过（含 bad 数组形式）

# 全量 A 类套件
npm test
# 预期：165 files, ~1982 tests pass

# B 类 capability 套件（需要 LLM + embedding）
npm run build && npm run test:capability
# 预期：golden 场景 selftest 前置校验正常运行
```

**已知前提**：
- B 类 capability 套件 boot 阶段需要 embedding 就绪（bge-m3），否则 selftest 之前 boot 超时
- CI 只跑 A 类（npm test），B 类 golden + factory 路径在 CI 不执行
- talking-stone factory 真跑路径（API 建会话 + SQL 插入）需在 LLM+embedding 齐备的本地环境验证
