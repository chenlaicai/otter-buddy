---
id: F20260902sigm
title: 链路信号模型：docStatus 退役与病态判定重构
summary: 健康链路病态判定从文档 status 字段改为实时派生的链上信号：删除 zombie/doc-only 判死与 #659 推进器遗产，新增 pr-stalled 信号与 PR 采集器，四态兼容投影上线。
created: 2026-09-02
change_type: feature
modules:
  - src/entities/document
  - src/usecases/health
  - src/frameworks/db/document
  - src/interface-adapters/http/controllers
  - web/src/pages/health
  - scripts
tags:
  - health
  - doc-status
  - chain-model
  - refactor
status: final
capability_test: "n/a: 判定层重构为确定性规则（无 LLM 行为变化），由单元测试覆盖（chain-builder/pr-collector/rhi-scan-worker 共 268+ 用例）"
---

# 链路信号模型：docStatus 退役与病态判定重构

## 背景（意图锚）

搭档 2026-09-02 原话：

> 「特性文档是跟着 pr 走的，是这个 pr 改动的说明；然后 pr chain 作为发展/更新的链路证据，也就是说，特性文档不代表本系统最新状态，**特性链才代表本系统的来时路**！……我认为其实都不应该有这个字段！合入就是合入，没有什么中间状态变化。」

> 「不能单看某一个历史特性文档就认为其是 zombie！**演进链路**！所有当前的特性都可能会更新，也会变成链上的一点而已！」

> （对「信号」的确认后）「ok，那你出，然后拉小獭们再对抗审视下」

### 问题定性

当前系统把**特性文档的 status 字段**当作「特性生命周期状态」的真相源，健康面板基于它判定 stalled/zombie。三层偏差（均有实证）：

1. **手工字段必然腐烂**：395 篇 F 文档，status 值域已发散到 8 个合法值 + 4 种带行内注释的变体；127 篇标 `development`，多数 PR 早已合入，从未回写。
2. **生命周期叙事越权**：zombie 判定 =「30 天无 commit 且近 30 天对话无人提及该 FID」——用「没动静」预言「已死」。而链是开放结构，任何链都可能明天来新 PR。
3. **信号污染与漏报并存**（2026-09-02 亲跑 `buildChainsOnce` 实测）：
   - 400 链分布：active 342 / stalled 51 / orphan 7 / zombie 0 / regressed 0
   - **51 条 stalled 全部是 doc-only 链**（零 commit，`daysSinceLastCommit=null`），文档状态构成为 draft 23 / development 18 / design 7 / proposed 2 / reviewed 1——报的「病」是「写了文档 14 天没变成 commit」，不是「工作卡住了」
   - 全量 git 历史核对：395 篇文档中 **245 篇零 commit 关联**（样本全是 7 月中旬 FID commit 规范确立前的存量）——「文档无 commit」在本仓是常态而非病态
   - **regressed 判定要求 inFlight 前提**（chain-builder.ts:199）——已合入链上出 BugFix 反而不报，而合入后修 bug 恰是最常见的回退场景

### 模型修正

| | 修正前（生命周期模型） | 修正后（链路信号模型） |
|---|---|---|
| 主语 | 单文档的一生（走到哪步了） | 链的当下事实（链上有什么） |
| 表达 | status 枚举状态机，写入 DB，需推进 | 查询时实时派生的信号清单，不落库 |
| 静默 | 停滞 → 病态 | 稳定默认态，不报 |
| 终态 | zombie（判死）/ terminal（豁免） | 无终态概念——不预言未来 |
| 互斥 | 单值取最严重 | 信号可叠加，挂几个报几个 |

## 目标

T1: **status 字段全面退役**——前端、判定、解释文案、评分不再消费 feature 文档 status（存量 395 篇 frontmatter 一字不动，#615 铁律保护原地不动）
T2: **病态判定改为链上实时派生的信号**，判据 100% 来自 git/PR 事实，零字段消费
T3: **消除「静默=病」与「判死」语义**：stalled 重定义为 open PR 停滞；zombie 删除无替代；doc-only 判死链删除
T4: **修复 regressed 漏报**：去掉 inFlight 前提，合入后 BugFix 触碰链内文件即报
T5: **#659 遗产处置**：doc-advancer / docs-advance.mjs / substatus 机制废弃（值域契约模块降级为存量兼容层后删）；每日推进器调度遗留问题随之消失
T6: **UI 从「五态状态」迁移到「信号清单」**：泳道线尾、筛选 chips、汇总条、抽屉 docStatus 展示同步收编

## 非目标

- 不动存量文档 frontmatter（含 status 字段本身——留在原地，只是无人消费）
- 不动 research 文档的 sync 链路（archived 语义是 sync 对账用的，见「设计取舍 R4」）
- 不引入 PR 数据的持久化表（PR 状态查询时现拉，见「设计取舍 R3」）
- 不做 #691 CARAMEL-700（独立小活，另行处理）

## 方案设计

### 1. 信号定义（全部实时派生，不落库）

| 信号 | id | 判据（已发生的事实） | 消失条件 |
|---|---|---|---|
| PR 停滞 | `pr-stalled` | 链上存在 open PR ∧ 该 PR 超过 N=7 天无推进（无新 commit / review / comment） | PR 有任何动静或被关闭 |
| 质量回退 | `regressed` | 链最近一次合入后，main 上出现 BugFix commit 且触碰链内文件（**无 inFlight 前提**，T4） | 永久事实不消失；链有新合入则刷新 |
| 引用缺口 | `doc-gap` | 合入 commit 的 FID 在 docs/features 无文档（现 orphan 定义不变） | 补文档 |

**删除无替代**：zombie（含提及豁免 Map 补丁）、doc-only 判死（classifyDocOnly 整段）。

**悬空文档信号（`orphan-doc`）经实查否决**：全量核对 395 篇文档中 245 篇零 commit 关联，且样本全部早于 2026-07 中旬（FID commit 规范确立前）——该信号上线即产生 245 条噪音。若未来 commit 规范覆盖率变化，可作为后续 issue 重议。**决策记录：不是模型否决（「文档存在∧链上零 PR」不违反链路模型，链路模型只说链是真相源），是存量噪音否决。**

### 2. 判定层改造（chain-builder.ts）

```
ChainState = "active" | "stalled" | "regressed" | "orphan"   // 枚举保留4值（zombie删除）
+ 新增 chain.signals: Signal[]                                // 信号清单，可叠加
```

- `classifyChain`：删除 `inFlight` 豁免入口（:196）、zombie 分支（:198）、regressed 的 inFlight 前提（:199）
- stalled 语义改为 `pr-stalled`：数据源扩展 open PR（`gh pr list --json` 采集，见下）
- `classifyDocOnly` 整段删除：doc-only 链（零 commit 且有文档）= 稳定，state=active、signals=[]
- `buildChainsWithZombieJudging`（rhi-scan-worker）的提及豁免 Map 参数删除；`fidMentionCounts` 选项删除

**state 与 signals 的关系**：state 是 signals 的兼容投影（stalled↔pr-stalled / regressed↔regressed / orphan↔doc-gap / active↔[]），保留单值 state 一学期供现有消费方（D3 评分、web 排序）平滑迁移，最终收敛到 signals。这是过渡设计，收敛计划写入本文档「迁移」节。

### 3. PR 数据采集（新增 PrCollector）

当前 rhi-scan-worker 只有 git log 数据源，无 PR 概念。新增 `src/usecases/health/pr-collector.ts`：

- `gh pr list --state open --json number,title,headRefName,body,updatedAt,url` + 逐 PR `gh pr view <n> --json commits,reviews,comments`
- 采集失败（无 gh / 无网络 / 限流）降级：`pr-stalled` 信号缺席，不误报、不崩——**检测器缺失 ≠ 系统健康**（与 #658 检测器清洗的原则一致）

**PR↔链关联规则（处置 S1 补全）**——三级优先，正则全部复用 fid-format.ts 契约：

1. **PR commits 的 message FID**（最高优先）：commit-msg hook 强制 `[FID][module][type]` 前缀，规范确立后 100% 覆盖，零误配
2. **PR body 的 FID**（次优先）：同正则，覆盖 commit 不带但 body 带（如汇总 PR 引用多篇文档）的场景
3. **branch name 不提取**（决策）：分支命名无 hook 强制（`feature/rhi-pr2-ui` 这类命名无 FID），正则提取误配率高（日期字符串/历史 FID 残留），收益不抵误挂风险

- **多 FID**：PR 关联到所有命中链（一对多），pr-stalled 挂到每条命中链——跨链 PR 是真实场景
- **无 FID**（如 dependabot Bump PR）：不关联任何链——Bump PR 停滞不是特性链的病
- **推进判定**：lastActivity = max(最新 commit 时间, 最新 review 时间, 最新 comment 时间)；now − lastActivity > 7 天 → pr-stalled

### 4. 消费方迁移清单（逐一）

| 消费方 | 位置 | 现行为 | 迁移后 |
|---|---|---|---|
| 病态判定豁免 | chain-builder.ts:196, :199, :229-243 | inFlight/terminal/未知三分 + doc-only 判死 | 全删，判据走链上事实 |
| 状态解释文案 | rhi-controller.ts:53-77 | 读 docStatus 拼 stateReason；**:59 还有一份硬编码 in-flight 白名单**（与 doc-status.ts 契约已分叉的暗账） | 重写为信号事实文案：「open PR #N 已 7 天无推进」/「链尾后出现 BugFix a1b2c3d 触碰 N 个链内文件」 |
| 信号检测 | detect-signals.ts `detectChainStall` | 读 chain.state==stalled/zombie → signals 表 | 读 chain.signals（pr-stalled → stalled ladder） |
| D3 评分 | health-score.ts:111 `scoreD3` | 五态分布计分：`pct(active)×100 − pct(regressed)×150 − pct(zombie)×100` | 四态计分（审视 A1 补公式）：`pct(active)×100 − pct(regressed)×150 − pct(stalled)×100`——pr-stalled（投影 stalled）顶上原 zombie 的 ×100 权重位；**D5 分母口径不变**（active+stalled 投影保留，语义仍为「活跃+停滞中」链） |
| web 汇总/筛选/泳道 | index.tsx（**ChainStateBar 五态堆叠条 :279/:333/:675 + ChainFilterChips + stateCounts**）/ SwimlaneTimeline / chain-state-meta.ts | 五态 + docStatus 徽章 | 四态信号 chips；**ChainStateBar 显式列入（审视 S2 第 9 处消费方）**；ChainDetailDrawer「文档状态」行删除（改为显示信号事实） |
| health-report CLI | scripts/health-report.mjs | 复用 scoreD3 公式 | **无需独立改动**（公式改自动跟随），显式声明于此 |
| **测试文件**（审视 S2 补） | tests/usecases/health/chain-builder.test.ts（zombie/doc-only 用例约 30% 删改）/ tests/usecases/health/doc-advancer.test.ts（整删）/ web 侧 chain-state-meta 与五态断言测试（改四态） | — | 随源文件同步删改，CI 全绿为准 |
| DB 映射 | feature-mapper.ts / document 实体 | status 列读写 | 列保留（sync 对账仍用 archived 语义），健康链路不再读 status |
| 文档状态推进 | doc-advancer.ts + scripts/docs-advance.mjs + substatus | 每日批量推进 status | **删除**（#659 遗产处置，T5）。级联清单（实查补全，审视 A2）：doc-advancer.ts ｜ tests/usecases/health/doc-advancer.test.ts（整删）｜ scripts/docs-advance.mjs ｜ package.json `docs:advance` script ｜ rhi-scan-worker.ts `buildChainsWithZombieJudging` 方法（:484 提及豁免装配）｜ fid-mention-counter.ts（实查确认纯服务 zombie 判定，无其他消费方）｜ app.ts:58 countFidMentions wiring |
| chainDetail 端点 | rhi-controller.ts:379 | 返回 docStatus | 字段保留但标 deprecated（存量兼容），前端不再展示 |

### 5. 写入侧收口

- 特性文档模板（code-implementation skill 链）：新文档 frontmatter 不再写 status —— 校验器现状 `if (status && !known)` 本就不强制（frontmatter-validator.ts:110），status 缺失已是合法路径，**零代码改动**，只改 skill 模板文案
- lint-docs.mjs 的 unknown-status 预算值随存量冻结不再放宽

## 影响范围

- **后端**：chain-builder / rhi-controller / detect-signals / health-score / doc-advancer（删）/ pr-collector（新）
- **前端**：health 页全部链相关组件 + api client 类型
- **数据**：signals 表存量 stalled 语义变化（历史行不迁移，自然滚动淘汰）；feature 表 status 列停止健康侧消费
- **skill/流程**：code-implementation 特性文档模板停写 status
- **连带消除**：#659 的「每日推进器调度挂载」遗留决策（CLI 删了，挂载问题消失）

## 风险与约束

1. **pr-stalled 依赖 gh CLI**：CI 环境无 gh 凭据时降级为信号缺席（已设计）；本地开发无 gh 同理
2. **D3 评分语义漂移（审视 A5 强化）**：五态→四态权重切换日，历史 D3 趋势与切换后**不可比、不回填、不可逆跳变**——处置：趋势图 UI 标注切换日期（垂直分隔线），快照表不迁移，滚动窗口自然滚动。跳变幅度预判：现基线 zombie=0，切换日差量仅来自 stalled 语义重定义（51 条 doc-only stalled 归零 + 真实 open PR 停滞计入），量级 ≈ 数分以内
3. **web 与后端同步上线**：chains 端点 state 枚举少一个值，旧前端会把 unknown 显示为 active 兜底（现有 fallback 逻辑覆盖）；反向新前端旧后端不会出现（同仓同 PR 发布）
4. **245 篇零 commit 文档**：本方案让它们从「被判病」变成「稳定」——面板 stalled 数会从 51 → ≈0，这是**信号质量修复**而非检测能力丢失，需在 PR 描述里向用户说明
5. **存量 signals 表**：zombie/stalled 历史行语义过时——不迁移（滚动窗口 30 天自然淘汰）

## 不兼容更新

- [Incompatible] `ChainState` 枚举删除 zombie；chain-builder 公开选项 `fidMentionCounts` 删除
- [Incompatible] chains/chainDetail 端点 stateReason 文案语义重写（消费方仅本仓 web）
- [Incompatible] doc-advancer API 与 `npm run docs:advance` 脚本删除

## 设计取舍

| # | 取舍 | 决策 | 替代方案 | 理由 |
|---|---|---|---|---|
| R1 | status 退役方式 | 原地保留停止消费，新文档停写 | A) 迁移脚本洗掉 395 篇 frontmatter | #615 铁律禁改历史文档；原地保留零风险零成本，语义自然风化 |
| R2 | 信号落不落库 | 不落库，查询时实时派生 | 落 signals 表 + 每日扫描 | 落库就有「推进/过期」问题（status 腐烂的根因复刻）；实时派生零滞后。detect-signals 的持久化通道保留给跨日趋势（bug 复发），链信号走实时 |
| R3 | PR 数据源 | gh CLI 现拉 + 失败降级 | 建 PR 持久化表 | 本仓 GitHub 单远程，gh 已是既定基础设施（docs-advance.mjs 同款用法）；建表是给「未来多仓」预付成本，YAGNI |
| R4 | research status | 不动 | research 也停消费 | research 的 archived 是 **sync 对账语义**（文件删了标 archived），不是生命周期状态——与 feature status 性质不同，不在本方案射程 |
| R5 | 兼容投影 state 保留一学期 | 保留四值 state | 直接全切 signals | D3/排序/web 消费方多，一次性全切 blast radius 大；投影层让迁移可分 PR 分层落地 |
| R6 | doc-only 链处置 | 稳定（active/无信号） | 继续判 stalled | 51 条现状全是「规范前文档」；「写了文档没动工」最多是提醒不是病；若未来要提醒走 orphan-doc 信号重议（已被 R2 存量噪音否决） |
| R7 | 阈值 | pr-stalled 7 天 | 14 天（现 stalledDays） | 语义变了：open PR 是显式开放的工作，7 天零 review 零 commit 即值得提醒；14 天太钝。首期可配（沿用 options 模式） |

## 验证

1. **单元**：chain-builder 重构后——pr-stalled 判定（有/无 open PR、PR 推进刷新）、regressed 无 inFlight 前提（合入后 bugfix 必报）、doc-only 稳定、zombie 分支全删
2. **回归数字对照**：重构后跑 `buildChainsOnce`，对照本方案记录的基线（400 链 active 342 / stalled 51 / orphan 7）——预期 active ≈ 393、pr-stalled 依真实 PR 状态 0-N、doc-gap 7
3. **端到端**：web health 页截图对照（泳道线尾、chips、抽屉无 docStatus 行）
4. **降级**：断 gh 凭据跑 pr-collector，断言信号缺席不抛错
5. **D3**：构造四态分布 fixture，验证新权重计分与趋势图切换点标注

## 改动范围

| 文件 | 操作 | 说明 |
|---|---|---|
| src/usecases/health/chain-builder.ts | 改 | 删 zombie/doc-only/inFlight 豁免；stalled→pr-stalled；+signals |
| src/usecases/health/pr-collector.ts | 新增 | gh CLI 采集 open PR + 推进时间，失败降级 |
| src/usecases/health/rhi-scan-worker.ts | 改 | 接 PrCollector；删 buildChainsWithZombieJudging 提及豁免 |
| src/usecases/health/detect-signals.ts | 改 | detectChainStall 读 signals |
| src/usecases/health/health-score.ts | 改 | scoreD3 四态 + 权重重算 |
| src/usecases/health/doc-advancer.ts | 删除 | #659 遗产 |
| tests/usecases/health/doc-advancer.test.ts | 删除 | 随源文件 |
| src/frameworks/db/health/fid-mention-counter.ts | 删除 | 纯服务 zombie 提及豁免（实查无其他消费方） |
| src/app.ts:58 | 改 | 删 countFidMentions wiring |
| scripts/docs-advance.mjs | 删除 | 同上 |
| src/entities/document/doc-status.ts | 改 | 降级为存量兼容层（validator 仍读），注释标 deprecated |
| tests/usecases/health/chain-builder.test.ts | 改 | 删 zombie/doc-only/classifyDocOnly 用例约 30%，stalled 改 pr-stalled 断言（delta 复核补齐，与消费方表对齐） |
| src/interface-adapters/http/controllers/rhi-controller.ts | 改 | stateReason 重写（删 :59 硬编码白名单暗账）；chainDetail docStatus 标 deprecated |
| web/src/pages/health/*（chain-state-meta/index/SwimlaneTimeline/Drawer） | 改 | 五态→四态信号 |
| web/src/api/client.ts | 改 | 类型同步 |
| .pi/skills/code-implementation/SKILL.md | 改 | 模板停写 status（文档指引） |

## 迁移与收敛

分两步落地：
- **Phase 1（本 PR）**：判定层 + 信号 + 消费方全迁 + 删 #659 遗产。state 四值兼容投影上线
- **Phase 2（后续）**：state 收敛进 signals，ChainState 枚举删除——待 web 端消费完全切换后另行小 PR

## 对抗审视处置记录

### 第一轮（执衡 mimo，2026-09-02）

**结论：需要修改。2 严重 + 5 建议。实查数字三连确认（400 链分布加法 ✓ / 白名单 5 值 vs 7 值分叉 ✓ / inFlight 前提位置 ✓）。报告：工作区 review-zhiheng-sigm.md。**

| # | 发现 | 处置 | 决策树判断 | 修订落点 |
|---|---|---|---|---|
| S1 | PR↔链关联只写目标未写实现 | 接受并修订 | 更好（关联规则错 = 信号误挂，方案必须写死） | §3 补三级优先规则（commit FID > body FID > branch name 不提取）+ 多 FID 一对多 + 无 FID 不关联 + lastActivity 判定 |
| S2 | 消费方漏 ChainStateBar + 测试文件未列 | 接受并修订 | 更好（漏消费方 = 迁移期断裂） | 消费方表补 ChainStateBar（index.tsx:279/:333/:675）+ health-report CLI 显式声明 + 测试文件行（chain-builder.test 删 ~30% zombie/doc-only 用例、doc-advancer.test 整删、web 四态断言） |
| A1 | D3 新公式未给出 | 接受并修订 | 更好（公式缺位 = 实现时拍脑袋） | 消费方表写入完整公式：stalled（pr-stalled 投影）×100 顶 zombie 权重位；D5 分母口径不变显式声明 |
| A2 | doc-advancer 删除级联不完整 | 接受并修订 | 更好（实查比我方案列得全） | 级联补全：package.json script / doc-advancer.test.ts / fid-mention-counter.ts / app.ts:58 wiring / buildChainsWithZombieJudging 方法 |
| A3 | 前端五态枚举散落 6+ 处、zombie 视觉影响未具体化 | 部分接受 | 更好（但 #687 刚收编 chain-state-meta 单一真相源，散落度已收敛） | 不建独立 issue，写为 Phase 1 实现清单项：改 meta + 渲染点，zombie 降饱和× 视觉直接删除无替代（该态不存在了） |
| A4 | health-report CLI 未显式声明 | 接受 | 更好（文档性） | 消费方表显式声明「复用 scoreD3，公式改自动跟随，无需独立改动」 |
| A5 | 趋势跳变风险被低估 | 接受并修订 | 更好（不可逆跳变必须写实） | 风险 2 强化：不可比/不回填/不可逆三不政策 + 趋势图标注切换日期 + 跳变幅度预判 |

**反驳记录**：S1 要求定义 branch name 提取正则——部分反驳：branch name 无 hook 强制（feature/rhi-pr2-ui 命名无 FID），正则提取误配率高（日期字符串/历史 FID 残留），决策为不提取。证据：分支命名规范无强制约束（.githooks 仅管 commit-msg），现役分支名抽查（feature/rhi-pr3-swimlanes / feature/sigm-chain-model）均无 FID。

---

# Phase 1 实现记录（2026-09-02，开发獭潮痕）

## 交付概览

三个分阶段 commit（防 429，分阶段测试通过再下一步）：

| commit | 范围 | 内容 |
|---|---|---|
| 986f354a | 后端判定层 | chain-builder 四态重构 + pr-collector 新增 + rhi-scan-worker 接线 + detect-signals/health-score/rhi-controller 消费迁移 + #659 遗产 7 项删除 |
| d916b600 | web 前端 | chain-state-meta 四态 + SwimlaneTimeline 删 zombie 视觉 + Drawer 信号清单 + client.ts 类型 |
| cdec29ba | skill 模板 | SKILL-TEMPLATE.md 核心字段清单停写 status（软代码） |

## 验证数字

1. **单元/集成**：2743 tests 全绿（主仓基线同口径 2743；改动文件 219 个测试文件无回归）；tsc 0 error；eslint 0 error（修掉自引入的 4 个：pr-collector 复杂度、未用 import、2 个测试文件行数超限）
2. **web**：384 tests 全绿（385→384：zombie 用例删除 + pr-stalled 新断言）；build 通过
3. **golden gate（软代码改动，2026-09-02 晚终版）**：
   - **关键场景 talking-stone-routing 3/3 全过**、yield-handoff-protocol 3/3、seriousness manualReview 路径正常出采样信号（人工判定项）
   - **r4-summon-search-first 本轮 0/3，但与软代码改动无关**——失败明细：两轮 `summoned=false`（大獭搜完记忆后未召唤直接答话）+ 一轮等待终态超时。本 PR 改的 SKILL-TEMPLATE L151 只删 status 字段说明，与 R4「召唤前先搜」行为零交集；历史记录佐证波动性（golden-results.jsonl：今晨 05:58 3/3 → 07:00 2/3 → 11:10 1/3 → 11:22 2/3 → 11:54 0/3，同代码逐轮下滑，与今天 LLM 端点限流频繁的时间线吻合）。今日恰逢 glm 5 小时窗口限流（18:02 重置），采样时段端点不稳
   - **首跑挂的根因（搭档追问后深挖定案）**：golden 断言自身 bug——断言查 `conversation_otters` 表，但 create_otter 的 join 生产链路写 `conversation_participants`（manage-participant.ts L69）。selftest 自插旧表数据所以判别力校验绿灯，真实采样永不命中旧表 → 0/3 稳定 fail。该 bug 由 PR #712（commit ccbfa6b6，14:27 合入）独立发现修复；潮痕 14:08 跑基线时修复未进 main，「主仓同挂」的 pre-existing 判定证据成立、方向正确，断言层根因由搭档质疑推动的二次深挖定位。rebase 后用 main 官方版验证通过
   - 证据：/tmp/golden-rerun.log（本轮完整输出）、data/metrics/golden-results.jsonl（历史波动记录）、工作区 main-baseline-output.txt（初版基线留档）
4. **回归数字对照**（方案验证节预期命中）：
   - 重构前基线：400 链 active 342 / stalled 51 / orphan 7 / zombie 0 / regressed 0
   - 重构后实测：**401 链 active 393 / stalled 0 / orphan 8 / regressed 0**——方案预期「active ≈393、doc-gap 7~8」精确命中；51 条 doc-only stalled 全部归零（信号质量修复落地）；pr-stalled 依真实 PR 状态（当前 open PR 全部今日活跃）= 0
   - 真实 PR 采集：15 条 open PR（6 条带 FID 关联、9 条 dependabot 无 FID 不关联）——关联规则实跑验证
5. **降级验证**：gh CLI 可用时 15 条 PR 正常采集；测试覆盖 gh 失败 → 空数组不崩
6. **web 截图**：四态信号对照（mock 数据：401 链 active 391 / stalled 2 / orphan 8，PR 停滞 chips/泳道无 zombie 元素）——工作区 health-chains-four-states.png / health-overview.png；独立端口 18923 server 用完自灭

## 实现偏差记录（事实优先，无静默偏离）

> 为什么会有偏差（共性归因，大獭 2026-09-02 晚对齐定案）：方案是审视定稿的**意图契约**，实现时撞上的是**代码现状**——三处偏差中两笔根因在方案/简报侧（偏差 2「stalled ladder」是旧僵尸阶梯遗留措辞未清干净；偏差 3 简报指错模板文件），一笔是方案粒度之下的合理裁量（偏差 1）。均不是设计变更，处置保持方案原意。

1. **方案 §4「检测器缺失 ≠ 系统健康」的实现细节**：pr-collector 的 gh pr view 逐 PR 失败时保留 PR 但 lastActivityAt=null（判定层不猜不判停滞）——方案未明确此中间态，实现取「数据不全不判定」
2. **detectChainStall 的信号粒度**：方案消费方表写「读 chain.signals（pr-stalled → stalled ladder）」——「stalled ladder」是旧 zombie 阶梯的遗留措辞；实现为逐 PR 出信号（一链多停滞 PR 时 N 条 chain_stall 信号，挂几个报几个），与方案「信号可叠加」原则一致
3. **skills 模板改动位置**：简报指向 code-implementation/SKILL.md，实查该文件不含 status 字段指引；真相源在 `_shared/SKILL-TEMPLATE.md` L151（特性文档核心字段清单，所有 skill 的共享约定段）——改后者，前者无改动需要。根因在派工简报（按方案 §4 字面表述转写）

## 最简实现检查（#614 必答）

已过最简检查：无新建表（PR 数据查询时现拉，方案 R3）、无新依赖（gh CLI 子进程复用 execFile 先例）、pr-collector 单文件（无框架）；删除代码（-468 行）远大于新增（+380 行），净简化。stalledPr label 逻辑内联在 SwimlaneTimeline（<10 行），未抽组件。

## #659 遗产删除核对（7/7）

- [x] doc-advancer.ts（262 行）
- [x] tests/usecases/health/doc-advancer.test.ts（443 行）
- [x] scripts/docs-advance.mjs（121 行）
- [x] package.json `docs:advance` script
- [x] rhi-scan-worker `buildChainsWithZombieJudging` 方法（含 fidMentionSource/mentionWindowDays/zombieDays 选项）
- [x] fid-mention-counter.ts（42 行，纯服务 zombie 判定）
- [x] app.ts countFidMentions wiring（import + 装配行）
