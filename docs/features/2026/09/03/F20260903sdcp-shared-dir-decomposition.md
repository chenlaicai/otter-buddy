---
id: F20260903sdcp
title: _shared 目录拆解：约定升格独立 skill
summary: |
  架构决策（chen 2026-09-03 拍板，事实 38fd48a2）：.pi/skills/_shared/ 目录整体拆解，skills/ 下只有 skill。
  ①署名/审视协议/冲突解决 3 约定升格独立 skill（category: reference，各带 use when）②SKILL-TEMPLATE 归 writing-skills/references/
  ③全部引用改写（「遇到 X 用 skill Y」模式 + 相对路径规范化）④_shared/ 删除⑤lint 改跨 skill 引用规范（继承 #758 诊断资产，E1b 改任何 _shared 引用均 error）。
  验证：lint 0 error（14 skills）+ npm test 2922 全绿 + golden 4 场景全过；3 个 pre-existing 失败附 stash 基线对照证据。
created: 2026-09-03
change_type: prompt
modules:
  - .pi/skills/
  - .pi/SYSTEM.md
  - prompts/skills/manifest.yaml
  - scripts/lint-skills.mjs
tags:
  - skills
  - architecture
  - refactor
  - lint
capability_test: "n/a: 结构性拆解为确定性规则，由 lint:skills 校验 7/9 + tests/scripts/lint-skills.test.ts 10 用例覆盖（真脚本临时目录实跑）；LLM 行为层由存量 golden 4 场景回归保障，无新增行为断言场景"
created_in_conversation: a56c349e-c566-438c-97d0-653a260171ed
causal_links:
  from:
    - F20260811sktp
intent:
  problem: ".pi/skills/_shared/ 聚合目录违反「每个 skill 独立完整」架构原则——SDK 只注入 name+description，_shared 内容对 agent 触发不可见；跨目录引用产生 28 次 ENOENT 实证读取失败（#758 session 扫描）"
  expected_effect: "skills/ 下只有 skill（14 个）；3 个约定升格为独立 skill 被 SDK 发现可触发；全部引用相对化，lint 校验 7/9 守护新结构；存量行为零回归（lint 0 error + 单测全绿 + golden 4 场景通过）"
  verify_by:
    type: static_only
---

# _shared 目录拆解：约定升格独立 skill

## 背景

- **架构决策来源**：chen 2026-09-03 拍板（14:09-14:47 对撞讨论，事实记录 38fd48a2）。搭档原话：「每个 skill 都是独立完整的」。教训留痕：大獭曾用脑补的 manifest 注入机制论证（实为仅注入 name+description），被搭档以实证纠正——架构论证必须先核机制再立论。
- **前序**：PR #758（保留 _shared/ 修写法的方案）因前提被架构决策推翻而关闭不合，但其诊断资产由本 PR 继承：940 session 扫描方法、28 次 ENOENT 根因（`_shared/x` 裸写法解析到 `<skill>/_shared/x`）、索引-only 引用零读取实证、lint 校验 9 设计与测试结构。
- 跟踪 issue：#726（重开）。

## 方案设计

1. **3 个约定文件升格为独立 skill**（各带 use when，与 worktree-isolation 使用模式同构，其他 skill 以「遇到 X 用 skill Y」模式引用）：
   - `signature-convention`（category: reference）——commit/PR/报告/评审署名查表
   - `review-protocol`（category: reference）——代码 PR 审视 + 方案审视两套编排协议
   - `conflict-resolution-protocol`（category: reference）——冲突分型/策略矩阵/升级协议/裁决记录
   - 内容以原文件为基础按 skill 结构（触发/输入/工作流/产出/参考）重组，信息无损
2. **SKILL-TEMPLATE.md → writing-skills/references/**（唯一真消费者；开头加迁移出处注记）
3. **引用改写**（11 处可变域 + 1 处语义性陈旧指针）：
   - SYSTEM.md ×2、code-implementation ×3（含 commit-convention.md 内「署名见 worktree-isolation」→ signature-convention）、requirement-analysis ×2、writing-skills ×2、worktree-isolation ×3（特性文档约定段落内联进步骤 4，含位置/协调/时机/角色/格式/入库六要素）、adversarial-review/references/author-response-protocol.md ×1
   - 引用形态遵守 #758 诊断规则：相对路径从 skill 目录解析；存量 4 处裸跨目录路径（`adversarial-review/references/x`）规范化为 `../adversarial-review/references/x`（post-merge-cleanup 的 2 处上下文说明改为 prose 不带路径）
4. **删除 .pi/skills/_shared/**——可变域（.pi/ scripts/ src/ tests/ prompts/ package.json）grep 无残留可解析引用；剩余 `_shared` 字样均为出处散文/注释/规则文本（lint E1b 正则不误伤，已验证）
5. **lint 重构**（lint-skills.mjs）：
   - E1 不变（绝对路径 → error）
   - E1b 改为「任何 `_shared/` 引用（裸写或 `../` 前缀）→ error」——目录已删，#758 推荐的 `../_shared/x` 过渡写法同样失效
   - 引用宇宙调整：跨 skill 裸写（`<name>/references/x`、`<name>/SKILL.md`）从非法改为合法（相对 skills 根解析）——#758 判其 error 的根据是 `_shared/x` 解析落空，拆解后目标目录真实存在
   - E2（索引-only → error / 跨 skill 工作流绑定 → warning）与 O(skills) 并集优化继承 #758
   - scanSkillDirs 不再特判 _shared（目录即 skill）
6. **manifest.yaml**：3 个新 skill 入册（category: reference，not_for 声明分流）

### 索引-only 引用修复（继承 #758 未竟事项）

新 lint 立即抓出 6 处索引-only 引用（#758 已诊断、修复随 PR 关闭未落）——本 PR 按其原方案内联绑定：adversarial-review 步骤 6（author-response-protocol + review-loop）、otter-summon 步骤 3（collaboration-patterns）、requirement-analysis 步骤 1（intent-anchor-guide）、writing-skills 步骤 2/3（skill-types + description-examples）。

## 影响范围

- 所有引用 _shared 的 skill（code-implementation / requirement-analysis / worktree-isolation / writing-skills / adversarial-review）与 SYSTEM.md
- agent 系统提示新增 3 个 skill 条目（name + description 注入）
- lint:skills 通过判据（新 error 项）

## 设计取舍

| 取舍 | 决策 | 替代方案 | 理由 |
|------|------|----------|------|
| 3 个约定的形态 | 独立 skill（category: reference） | 保留 _shared/ 只修写法 | 架构决策（事实 38fd48a2）：SDK 只注入 name+description，_shared 无触发通道；「每个 skill 都是独立完整的」 |
| 消费方引用模式 | 「按 X skill」prose + 少量 `../` 相对路径 | 全部路径引用 | 与 worktree-isolation 使用模式同构（架构决策指定）；prose 免路径漂移 |
| worktree-isolation 特性文档约定 | 内联进步骤 4 | 指向 SKILL-TEMPLATE | 架构决策指定内联化；该 skill 是特性文档约定的主要执行现场 |
| 跨 skill 裸写形态 | 放行（skills 根解析） | 沿用 #758 全禁 | #758 判 error 的根据（解析落空）在拆解后不成立；保留规范化存量改写为 `../` 形态 |
| category 选型 | reference（新 3 个） | technique | 三者均为查表约定无执行工作流（SKILL-TEMPLATE category 定义）；writing-skills 步骤 2 佐证 |
| golden 新场景 | 不建 | 复刻 #758 的 skill-references-visibility | 本 PR 为结构拆解，行为断言已由 lint + 单测静态覆盖；任务范围不含 golden 扩建 |

## 验证

- lint：`npm run lint:skills` OK（14 skills，0 error，9 warnings——8 条存量互指 + 1 条 adversarial-review 行数，均为拆解前既有；rebase 后复验同样通过）
- 单测：`npx vitest run tests/scripts/lint-skills.test.ts` 10/10 通过（继承 #758 测试结构 + 新增 E1b 两形态 / 跨 skill 裸写归一 / 指向不存在 skill 三用例）
- 全量：npm test 全绿（rebase 至 e3808027 后：**2922 passed / 235 files**）
- golden gate（test:capability，3 轮）：golden 4 场景全过（r4-summon-search-first / seriousness-mode-switch / yield-handoff-protocol / talking-stone-routing）；40 passed / 3 failed / 1 skipped
- **pre-existing 声明附基线证据（#614）**：3 个失败（身份注入 / Magic Words「停下」采样 / Magic Words「星星罐子」）均经 git stash 后在纯 origin/main（e3808027）基线复跑对照——同样失败。归因：#770 重构 identity-builder.ts / agent-invoker.ts（diff 域含 src/frameworks/agent，非本 PR 改动域）+「星星罐子」是词表删除（F20260826mwrd）后的测试陈旧断言。环境注：worktree 需符号链接主仓 models/bge-m3 与 config/config.test.local.yaml（非 git 资源，.gitignore 已覆盖）
- 人工抽查 3 个改写点语义无损：worktree-isolation 步骤 4（特性文档六要素齐备：位置/协调/时机/角色/格式/入库——原「历史文档不可变」段保留原位未动）、review-protocol skill（代码/方案两协议全量迁移 + 通用约束保留）、signature-convention（三处署名位置 + 身份获取规则齐备）
- 最简实现检查：已过——升格 3 文件内容无损平移而非重写；lint 仅改引用宇宙与 E1b 规则，校验 1-8 未动

## 对旧特性的影响

- F20260811sktp 引入的 _shared/ 结构退役；其 skill 契约化框架（manifest/lint/三段式）不变且扩展（校验 9 落地）
- F20260810ka23「_shared/ 用引用不内联」取舍被本架构决策取代（引用模式仅保留于 references 文件引用；约定类内容全部 skill 化或内联）
