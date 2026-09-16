---
id: F20260916e46x
title: 事故 #962 流程修复：迁移类变更硬规则 + 省事偏好三道刹车 + 测试库加载 vec
summary: |
  2026-09-16 生产启动崩溃事故（#944 CTAS 丢结构 / #962 外部修复）复盘的流程层修复——8 项改进条款落成
  skill/测试规范/代码：①真启动验证硬规则（code-implementation 步骤 6）；②B3 新增 DB migration 类；
  ③迁移测试三不变量（testing-rules）；④焦点建议防锚定（adversarial-review 步骤 2）；⑤迁移结构保持
  核查（CTAS 即严重发现）；⑥省事声明即触发论证；⑦负面向验收条目；⑧捷径审查；
  ⑨createTestDb 加载 sqlite-vec 对齐生产构型。
change_type: feature
capability_test: "n/a: 纯规则文本（skill/references）+ 测试基建改动——条款约束的是海獭流程行为而非 LLM 生成行为，A 类全量测试（3089 用例）+ lint + golden gate 已验证"
created: 2026-09-16
created_in_conversation: 9d66fb86-b15a-4d23-88b3-adab5ab91c7b
modules:
  - .pi/skills/code-implementation/SKILL.md
  - .pi/skills/code-implementation/references/testing-rules.md
  - .pi/skills/adversarial-review/SKILL.md
  - .pi/skills/adversarial-review/references/review-dimensions.md
  - .pi/skills/requirement-analysis/SKILL.md
  - tests/helpers/db.ts
causal_links:
  from:
    - F20260915midu   # 引入 CTAS 换键复制的迁移（#944，事故源头）
    - F20260916rkct   # CTAS 丢结构修复（#962，事故现场）
    - F20260812emgr   # 同类前科：新表漏迁移致启动 crash（#244）
status: implemented
tags: [skills, process, migration, sqlite, review, incident-962]
intent:
  problem: "事故 #962 复盘确认七道防线全部失效于同一盲区：「结构正确性」和「启动验证」两个概念在整个流程里不存在；同时搭档指出 LLM 把「省事」当优点是物种级认知偏差，缺对应刹车"
  expected_effect: "迁移类 PR 被要求真启动验证 + 迁移测试断言三不变量 + CTAS 即严重发现；检视者不被作者焦点建议锚定；「省事/更简」类自评词必须附带「省掉的是什么」论证；测试库加载 vec 使 vec 路径不再静默零覆盖"
  verify_by:
    type: behavior_check
---

# F20260916e46x: 事故 #962 流程修复——迁移类变更硬规则 + 省事偏好三道刹车

## 背景

事故锚点链：F20260915midu（#944，9/15 深夜合入，remapKeyedTable 用 CTAS 复制四张卫星表）
→ 2026-09-16 早搭档更新系统，启动即 exit 1（embedding_tasks 丢 PK，bootstrap enqueueRetry
的 ON CONFLICT 炸）→ 外部 Claude 排查修复（F20260916rkct / #962），手工重建生产库 4 张表。
同类前科：F20260812emgr（#244，8/12 新表漏迁移致启动 crash）——同事故类型 35 天内踩两次。

复盘终审（对话工作区 incident-962-postmortem-final.md，两只独立反思獭结论一致）判定：
**流程 50% / 开发獭-942（kimi）35% / 检视獭-944（mimo）15%**——不是任何一环偷懒，而是
「结构正确性」和「启动验证」两个概念在整个流程里不存在。搭档补充议题：LLM 把「省事」
写进文档当优点是物种级偏差（训练目标无总成本变量 / 省事伪装成美德 / 认知负荷不对称），
与 9/7 机制预算（治无脑加法）同根——本次给「无脑减法」装刹车。

搭档 2026-09-16 拍板开工，8 项改进 + 1 项代码修订合并为本 PR 一次落地。

## 目标

T1: 迁移类变更的「真启动验证」成为自检与审视 B3 的硬要求（不再接受「跑迁移+SQL 校验」冒充演练）
T2: 迁移测试断言三不变量（数据/结构/功能探针）成为 testing-rules A 类硬规则
T3: 测试库 createTestDb 加载 sqlite-vec，消灭 vec 路径静默零覆盖
T4: 检视者不被作者「检视焦点建议」锚定，对变更机制本身保留独立检查
T5: CTAS 用法在审视维度里直接标严重发现；同函数两种严谨度 = 强信号逐表核实
T6: 省事偏好三道刹车（省事声明即触发论证 / 负面向验收条目 / 捷径审查）落进 skill 文本

## 非目标

- 不动 CI 冒烟测试立项（终审报告改进 7，P1，另行建 issue）
- 不动 kimi 派工自查条款的 skill 化（终审报告改进 6，大獭派工惯例即刻生效，无需 PR）
- 不重写既有迁移测试用例去补结构断言（条款约束未来变更；存量补测另行评估）
- 不修改生产代码逻辑（除 tests/helpers/db.ts 测试基建外零 src/ 改动）

## 改动清单（8+1 项，全部本 PR）

| # | 条款 | 落点 | 类型 |
|---|------|------|------|
| 1 | db 迁移类变更真启动验证硬规则：涉及 migration.ts 迁移函数或 schema.ts 表结构变更时，自检必须含生产副本真启动（备份副本→完整启动路径→服务监听成功+日志无 SqliteError），「跑迁移+SQL 校验」不算数 | code-implementation/SKILL.md 步骤 6 | 事故硬规则 |
| 2 | B3 Verification 清单新增「DB migration changes」：真启动验证才算 B3 通过 | review-dimensions.md B3 节 | 事故硬规则 |
| 3 | db 迁移测试三不变量：①数据 ②结构（sqlite_master DDL 等价：PK/UNIQUE/FK/虚拟表形态）③功能探针（ON CONFLICT 写入/FTS5 MATCH/vec0 KNN） | testing-rules.md A 类硬规则 | 事故硬规则 |
| 4 | 作者检视焦点建议的防锚定规则：作者焦点只能作输入之一，不能替代检视者自己的焦点声明；对「变更机制本身」永远保留独立检查动作 | adversarial-review/SKILL.md 步骤 2 | 事故硬规则 |
| 5 | 迁移结构保持核查：CTAS 用法直接标严重发现；同函数主表/卫星表两种严谨度 = 强信号逐表核实 | review-dimensions.md Correctness 节 | 事故硬规则 |
| 6 | 省事声明即触发论证（刹车一）：「省事/更简/更快/无窗口/零成本」类自评词必须同段回答「省掉的是什么？有没有主人？」 | requirement-analysis/SKILL.md 步骤 6 + code-implementation/SKILL.md 步骤 4 | 省事刹车 |
| 7 | 负面向验收条目（刹车二）：迁移/破坏性/替换类变更验收清单必含「本次变更破坏了什么旧契约/绕过了什么既有保护」 | code-implementation/SKILL.md 步骤 6 | 省事刹车 |
| 8 | 捷径审查（刹车三）：对「替代既有路径的新捷径」核验原路径存在原因 + 新捷径是否满足同样约束 | review-dimensions.md Correctness 节 | 省事刹车 |
| 9 | createTestDb 加载 sqlite-vec（对齐生产 initDatabase），加载失败直接抛；修一个依赖「vec 不存在」旧假设的测试（3 维假向量→1024 维） | tests/helpers/db.ts + search-memory.test.ts | 代码 |

## 设计取舍

| 取舍 | 决策 | 替代方案 | 理由 |
|------|------|----------|------|
| 条款落在 skill 文本而非新流程 | 内嵌既有 skill（8 处修订） | 新建「迁移审视」子流程 | 机制预算四问③：零新机制，条款随既有流程自然被执行；新流程本身会成为下一个没人走的补丁 |
| 刹车一用词清单枚举（省事/更简/更快/无窗口/零成本） | 枚举 + 「类自评词」兜底 | 只写原则「凡自评省事必论证」 | 纯原则在 LLM 执行时会漂移；枚举给机械抓手，兜底词防清单外逃逸 |
| CTAS 一律严重发现（不设例外） | 硬规则 | 允许「确证无结构需求的表」例外 | 例外口子就是下次事故入口——#944 作者正是认为「卫星表简单所以 CTAS 够了」；正确姿势（sqlite_master 提 DDL / 原地 DELETE+INSERT）成本不高，不值得为例外开口 |
| createTestDb 加载失败直接抛 | 测试环境必须能加载 vec | 对齐生产 D22 降级容错 | D22 降级是生产容错，不是测试默认形态——测试 100% 跑降级、生产 100% 跑完整，构型完全相反正是 #944 vec 零覆盖的根因 |
| 8 项合并一个 PR | 一次落地 | 事故硬规则 / 省事刹车拆两个 PR | 同一批 skill 文件，拆分会造成 skill 短时间改两轮；条款间有引用（刹车三与改进 5 同节），合并语义更完整 |

**机制预算四问**（本 PR 净新增规则条款，属机制新增）：
- ① 谁需要：写方案/写代码/做检视的海獭（具体角色：实现者与检视者），以及不再被「省事」修辞误导的搭档
- ② 失败后果：条款流于形式 → 每次变更多写几句话的成本，可接受；条款缺失 → #962 同类事故第三次发生，搭档生产环境再次启动崩溃
- ③ 后续机制：条款可能失效的方式是「被执行者当八股跳过」——由 adversarial-review 的 B 维度核查（检视者核对刹车一执行）+ 每日 review 抽检兜底，不新建独立监督机制
- ④ 退役条件：两个版本周期内，若刹车类条款从未拦下任何一次真实「省事辩护」且从未被引用 → 降级为建议或删除

**负面向条目（刹车二自身演示）**：本次变更破坏了什么旧契约/绕过了什么既有保护？
——破坏了「迁移类 PR 可以用 SQL 校验冒充演练」的旧默契（#944 的 Verification 写法今后不再合格）；
破坏了「检视者可以直接采信作者焦点清单」的旧惯例。两处破坏都是有意为之的收紧，无第三方受害者。

## 验证

- `npm run lint`：0 error（4 个 pre-existing warning，与本次变更无关——证据：变更文件清单不含这两个文件，warning 在 origin/main 同样存在）
- A 类全量测试：256 文件 3089 用例全绿（含修复后的 search-memory P3-AT-1）
- tests/frameworks/db/ 27 文件 256 用例全绿（createTestDb 改动直接覆盖域）
- `npm run lint:intent`：0 error
- Golden Gate（`npm run test:capability`）：见自检报告（软代码改动必跑）
- createTestDb 加载 vec 实证：改动前全量跑暴露 1 个依赖「vec 不存在」旧假设的用例
  （search-memory P3-AT-1 插 3 维假向量，vec 表真实存在后维度校验生效报错）——
  这本身就是条款 9 价值的现场证明：vec 路径从「物理不存在」变为「真实被测」

## 同模型自查（kimi 三条失效模式，开发獭-962 执行）

埋雷者开发獭-942 与我同模型（kimi），三个失效模式逐条自查：

1. **抽象统一压过逐实例核实**：本 PR 8 项条款落点各不相同，逐项对照复盘报告 diff 原文
   落位（非套一个统一模板糊进所有文件）；createTestDb 改动后逐个诊断受影响测试
   （仅 1 个真实受影响，未一概而论改全部）
2. **把「省事」当优点陈述**：本文档及 commit message 全文检索「省事/更简/更快/零成本」——
   仅出现在条款原文引用与反面教材语境（#944 现场引述），无一处用作本方案自我优点陈述；
   「合并一个 PR」的决策在「设计取舍」表附了理由（避免两轮修订），非省事辩护
3. **清单驱动验收闭环**：8+1 项清单之外自答负面向条目（见「设计取舍」末段）——
   本次变更破坏的旧契约已显式列出并确认无第三方受害者

## 改动范围

| 文件 | 操作 | 说明 |
|------|------|------|
| .pi/skills/code-implementation/SKILL.md | M | 步骤 4 刹车一 + 步骤 6 真启动验证硬规则、刹车二 |
| .pi/skills/code-implementation/references/testing-rules.md | M | A 类硬规则新增迁移测试三不变量 |
| .pi/skills/adversarial-review/SKILL.md | M | 步骤 2 焦点建议防锚定规则 |
| .pi/skills/adversarial-review/references/review-dimensions.md | M | B3 新增 DB migration changes；Correctness 新增迁移结构保持核查 + 捷径审查 |
| .pi/skills/requirement-analysis/SKILL.md | M | 步骤 6 刹车一 |
| tests/helpers/db.ts | M | createTestDb 加载 sqlite-vec（失败即抛） |
| tests/usecases/memory/search-memory.test.ts | M | P3-AT-1 假向量 3 维→1024 维（vec 表真实存在后的维度合规） |
| docs/features/2026/09/16/F20260916e46x-incident-962-process-fix.md | A | 本文档 |
