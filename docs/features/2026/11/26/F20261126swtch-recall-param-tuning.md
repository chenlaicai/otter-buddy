---
id: F20261126swtch
title: 记忆检索参数切换（threshold 0.1 / vec 池深 20 / 半衰期 14 天）
summary: 按 R20261126amrca Phase C 网格与双盲标评测（Kappa 0.8544）验证的 t0.1-k20-h14 组合切换三项检索默认值——vecSimilarityThreshold 0.3→0.1、新增 vecCandidateLimit=20 解耦池深与 query.limit、weightHalfLifeDays 7→14；golden 回归地板随新基线上移重锁，被否路径（h21/K50）留痕。
change_type: feature
doc_type: feature
created_at: 2026-11-26
created_in_conversation: f4402db8-9dee-4979-82b9-f0d46ed4f195
capability_test: "n/a: 纯 A 类配置默认值与检索管线行为，由 loadConfig 默认值断言、reader 边界池深断言与 golden 合成回归（FTS-only 口径）验证，不新增 LLM 自由行为"
tags: [memory, retrieval, parameter-tuning, recall, evaluation, config]
modules:
  - src/frameworks/config-service.ts
  - src/usecases/memory/search-engine.ts
  - src/usecases/memory/search-memory.ts
  - config/config.yaml.example
  - tests/usecases/memory/golden-eval.test.ts
  - tests/usecases/memory/vec-candidate-limit.test.ts
intent:
  problem: "vecSimilarityThreshold=0.3（等价 cos≥0.65）使 vec 路过门率≤4%、96.4% 可及 gold 被杀，语义检索实际未参与融合，检索实为 FTS 单路；vec 候选池深度隐式跟随 query.limit（与 FTS 池 50 不对称）且无法独立标定；消息半衰期 7 天过度压制近两周记忆。"
  expected_effect: "默认 t0.1-k20-h14 后，20 条真实查询 recall@10 0.304→0.454、真实融合池 r_pool 0.60→1.00、MRR +0.044、nDCG@5 +0.124，扫描延迟不增（全表扫，k 不影响量级）；golden 合成回归三项不低于重锁地板 0.768/0.775/0.898。"
  verify_by:
    type: behavior_check
    rollback: "revert 本 PR 即恢复旧默认（threshold 0.3 / 池深跟随 limit / 半衰期 7 天）；无 schema 迁移、无数据变更；yaml 显式覆盖可即时回退单个参数。"
    risk_note: "20 条真实查询为小样本，组合间 ±0.03 级差异低置信（推荐组合选全门槛通过且余量最大者）；阈值项在 FTS-only 口径的 golden 回归中测不到，切换后需观察真实使用效果；30 天龄 message 排序上浮为预期行为变化（golden E12 榜首翻转已重锁留痕）。"
---

# 记忆检索参数切换（t0.1-k20-h14）

## 背景与实施基线

- 实施基线 `origin/main@c2dfdeb72`（fetch 后最新，含 #2056）。
- 决策链：R20261126amrca（评测路线）→ Phase B 双盲标（Kappa 0.8544 ≥ 0.6 质量门，gold 221 条）→ Phase C 网格 24 组合 + 现状对照 → 搭档 2026-11-26 15:50 卡片拍板「同意实施参数切换（t0.1-k20-h14），Phase D 暂缓」（M-52da06af）。
- 关键发现（阈值杀伤审计）：vec0 用 L2 距离，`(1-d)≥0.3` 等价 cos≥0.65，bge-m3 在本语料的 gold 相似度典型 0.55-0.65，被门挡在融合外；20 查询 vec50 池过门率最高 4%。过滤逻辑在 `search-engine.ts` `filterVecHitsByThreshold`。

## 目标与非目标

### 目标

1. `vecSimilarityThreshold` 默认 0.3 → 0.1（`config-service.ts` buildMemoryConfig）。
2. vec 候选池深度解耦为独立配置 `vecCandidateLimit`，默认 20（原池深=query.limit 隐式耦合）；`searchConversationInternal` 两处调用接线。
3. `weightHalfLifeDays` 默认 7 → 14 天。
4. golden 合成回归夹具与地板随新默认同步（PROD_MEMORY_CONFIG 声明为生产默认，不同步即失真）。

### 非目标

- 不动 FTS 池（`DEFAULT_FTS_LIMIT=50`）、alpha、RRF k、rerank 权重等其余参数。
- 不做 Phase D（最终组装层优化，搭档拍板暂缓）。
- 不沉淀评测工具进 repo（另立工作，大獭安排记忆研究獭）。
- 不动 `searchSimilar` 路径的池深语义（见设计取舍）。

## 设计取舍

### 机制判定留痕（检视修订版）

机制识别检查点七项清单逐项核对（troubleshooting SKILL.md 修法决策树节，机械判断不凭感觉）：**命中第一项「新增配置字段/枚举/开关」**——`vecCandidateLimit` 为全链路新增（yaml → RawConfig → AppConfig → buildMemoryConfig → SearchEngine 构造回填 → searchConversationInternal 接线，含接线测试）。首版留痕以「组件/守卫/流程/管辖/语义结构」词表声明「全部未命中」，漏核清单字段项，物理矛盾被检视发现（2026-11-26 PR #2062 review 严重发现 1）——本段为修正版，初版记录保留于 git 历史。

**为何命中清单但不涉净新增机制（走修法决策树①的论证）**：该字段是把既有行为量（vec 池深）从隐式取值（恒等于 query.limit）显式化为配置入口——无新增决策分支（构造时固定回填 20，非运行时分支）、无状态生命周期、无持久化、无跨模块新调用路径（沿既有 configRef 读取链）；运行时调用点与数据流与旧版完全同构（同一 `searchVec` 调用，仅深度取值来源改变），且「取值 10→20」的行为变化本身即搭档拍板的参数切换本体（非修复顺手夹带），故属既有检索管线语义内的参数显式化而非机制新增。论证效力由对抗审视核验；若论证不成立应改走④重对抗门，检视可推翻。

`Modification-Class: narrow-fix`（维持，依据上述论证；非「未命中」式声明）。

### 实现载体：配置字段 vs 硬编码常量

- **选定**：`SearchEngineConfig` 新增可选字段 `vecCandidateLimit?: number` + 构造回填默认 20（`DEFAULT_VEC_CANDIDATE_LIMIT` 导出常量防漂移）——与同段 `vecSimilarityThreshold`/`weightHalfLifeDays` 载体统一，yaml 可显式覆盖，贴合搭档「参数切换」语义与单参数回滚能力。
- **被否**：仿 FTS `DEFAULT_FTS_LIMIT=50` 用模块常量硬编码——零配置面更简，但不可覆盖、与另两个参数载体割裂，且「参数」语义下应可被 yaml 调整。

### 被否路径（评测证据）

- **半衰期 21 天**：真实集方向更优，但 golden 合成回归 nDCG10=0.7711 擦线低于旧地板 0.772，按「合成回归不退化」门槛出局（phasec-grid 实测）。
- **池深 K=50**：t=0.1 时有 8.1% gold 独占增量、t≥0.2 时为 0——增量强依赖阈值；本次不动，阈值切换稳定后单独验证（R20261126amrca 未决问题 #4）。
- **旧组合 t0.3-k10-h7（现状）**：vec 路过门率≤4%，r_pool 仅 0.40（vec 路零增量）。

### searchSimilar 路径不动

`searchSimilar` 的 vec 池深语义是「找相似条目」（调用方显式 limit+1 排自身），非对话检索候选池，不在本次评测射程内，保持原样。

### golden E12 判别力隔离（行为变化留痕）

msg 半衰期 7→14 使 30 天龄 message 权重 ×4.4，E12 场景默认榜首由文档 `g-clu-06b` 翻转为 message `g-clu-06a`（评测网格背书的预期变化）。处置分两路：

- 「新增 5 查询逐条锁」按生产默认重锁 top1=g-clu-06a（targets 不变，两正例仍均入 top10）。
- 「文档半衰期判别力」用例将 msg 半衰期固定为 7（单变量隔离 doc 半衰期边际效应），保持判别力结构；生产默认下的 E12 榜首变化由逐条锁用例承载。

### multiply 回退基线重锁

半衰期是所有 rerank 模式的共同输入，h14 下 multiply 基线由 0.6783/0.7028/0.8112 → 0.6814/0.7052/0.8129，随之重锁（语义=锁定回退路径不漂移，非锁定 h7 时代数字）。additive 全中性化反事实锚点 0.7792/0.7950/0.9315 不受影响（全中性化时半衰期被中性化），实测复现一致。

## 变更清单

| 文件 | 变更 |
|---|---|
| `src/frameworks/config-service.ts` | threshold 默认 0.1；新增 `vecCandidateLimit`（RawConfig + AppConfig + buildMemoryConfig）；halfLifeDays 默认 14；注释同步 |
| `src/usecases/memory/search-engine.ts` | SearchEngineConfig 新增可选字段 + 构造回填（`DEFAULT_VEC_CANDIDATE_LIMIT=20` 导出） |
| `src/usecases/memory/search-memory.ts` | searchConversationInternal 两处池深接线（`configRef.vecCandidateLimit ?? DEFAULT_VEC_CANDIDATE_LIMIT`） |
| `config/config.yaml.example` | weightHalfLifeDays 样例 7→14（显式值会覆盖默认，必须同步）；新增 threshold/vecCandidateLimit 注释样例 |
| `tests/usecases/memory/golden-eval.test.ts` | PROD_MEMORY_CONFIG 同步 h14；E12 逐条锁重锁；E12 判别力段 msg 隔离；multiply 基线重锁；BASELINE 地板 0.765/0.772/0.888→0.768/0.775/0.898 |
| `tests/usecases/memory/vec-candidate-limit.test.ts` | 新增：缺省回填 / 池深接线（缺省 20、显式 15）/ loadConfig 三默认值 |

## 影响范围与风险

- **行为面**：所有走 `search_memory` 主路径的检索（agent 工具、API）在未显式覆盖 yaml 时切换到新参数。检索结果排序与构成会变化——这正是本变更目的。
- **排序局部翻转**：近两周～30 天龄 message 排序上浮（半衰期放缓的直接效应），个别场景文档条目相对下沉。聚合指标净正（网格 25 组合同方向），局部翻转由 golden 逐条锁承载并留痕。
- **延迟面**：池深 10→20 全表扫同量级（Phase B 实测 k20 370ms vs k10 377ms，噪声级）；阈值/半衰期不新增延迟路径。
- **小样本边界**：20 条真实查询、组合间 ±0.03 级差异低置信；阈值项在 FTS-only 口径 golden 中测不到（评测报告如实声明），切换后需观察真实使用效果。
- **部署兼容**：显式 yaml 配置永远优先于默认值——已显式设 0.3/7 的部署不受影响（保持旧行为）；未显式设置的部署自动切新默认。

## 回滚

- 代码回滚：`git revert` 本 PR 单 commit 即恢复全部旧默认。
- 参数级回滚：不改代码，yaml 显式设 `vecSimilarityThreshold: 0.3` / `vecCandidateLimit: 10`（或删除该行并配合代码回滚）/ `weightHalfLifeDays: 7` 即可逐项回退。
- 无数据变更、无 schema 迁移，无数据回滚需求。

## 机械验收

| 场景 | 操作 | 预期结果 | 状态 |
|---|---|---|---|
| config 默认值 | `loadConfig` 无 memory 段 yaml | threshold=0.1 / vecCandidateLimit=20 / halfLifeDays=14 | ✅ vec-candidate-limit.test.ts 第 4 用例 |
| 池深接线（缺省） | `search(limit=5)` + spy reader.searchVec | k=20（不跟随 limit） | ✅ 第 2 用例 |
| 池深接线（显式） | vecCandidateLimit=15 | k=15 | ✅ 第 3 用例 |
| golden 回归 | `npx vitest run tests/usecases/memory/golden-eval.test.ts` | 14/14，三项 ≥ 0.768/0.775/0.898 | ✅ |
| 全量回归 | `npm test` | 553 文件 / 6993 用例全绿 | ✅ |
| 构建与 lint | `npm run check` | exit 0（build+lint+schema+smoke:boot） | ✅ |
| 类型检查 | `npx tsc --noEmit` | 0 error | ✅ |

## 验证与证据

- `npm run check` exit 0；`npm test` 553/6993 全绿；`tsc --noEmit` 0 error（npm ci 后；此前旧 node_modules 下 `shell-action-executor.ts` 的 onSpawn 类型报错在重装依赖后消失，属本地依赖版本差异，非代码问题，不构成 pre-existing）。
- golden 三项实测 0.7684/0.7754/0.8985，与评测侧 phasec-grid 预验证数字完全一致（独立环境交叉验证成立）。
- 负面向验收（本变更破坏了什么旧契约）：①「文档压 message」的 E12 类排序预期被翻转——已重锁留痕；②「池深=query.limit」隐式契约消失——仓内唯一生产调用点 searchConversationInternal 已接线，无其他消费者；③本地 config.yaml（不入 git）若显式设旧值则保持旧行为——向后兼容语义不变。
- 最简实现检查（已过阶梯）：复用既有可选字段+构造回填模式（beliefBoost/supersededPenalty 先例）、既有 `d()` 默认值机制、既有 spy 测试口径；零新依赖、零新生产文件。考虑过更简的硬编码常量方案并被否（取舍段）。
- capability 层（真 LLM）：本变更不新增 LLM 自由行为，本地未跑 `test:capability`，由 CI capability job 覆盖。

## 下一步（不在本 PR）

- K=50 增量验证（阈值切换稳定后）。
- Phase D 立项与否（搭档已拍板暂缓，先观察切换后真实效果）。
- 评测工具沉淀 repo（另立工作）。
