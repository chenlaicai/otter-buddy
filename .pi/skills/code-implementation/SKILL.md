---
name: code-implementation
description: >-
  Use when: 搭档要求按方案实现功能/写代码/写测试.
  Not for: 无方案的需求分析 → requirement-analysis. 小改动（lockfile、配置、文档订正）→ worktree-isolation.
  Output: 代码 PR + 特性文档（含测试、自检通过、对抗审视通过），呈搭档终审.
co_loads: []
category: technique
---

# Code Implementation

把技术方案变成可运行、可验证的代码变更。

## 触发

**触发条件**：搭档要求按方案实现功能、写代码、写测试时。

**排除**：无方案的需求分析 → `requirement-analysis`。小改动（lockfile、配置）→ `worktree-isolation`。

**输入**：
| 输入 | 必选 | 缺失时 |
|------|------|--------|
| 技术方案（搭档确认后） | 是 | 停下来问搭档。禁止自行编造方案 |
| 方案编号 | 是 | 从方案文档或特性文档 frontmatter 读取 |
| 工作分支 | 是 | 先走 worktree-isolation 创建 worktree |
| 特性文档 | 否 | 通过 `list_artifacts` 查找；不存在则步骤 7 创建

## 工作流

1. **准备环境**：执行 `worktree-isolation` 最小流程创建 worktree。记录 worktree 名、分支名、特性编号。
2. **确认理解**：通读方案，确认涉及的文件和模块、核心逻辑、是否有破坏性变更。用 `search_terminology` 确认术语。不清楚就问，不猜。不在方案内的功能不实现。
3. **预检查**：动手实现前，先检查相关测试断言和设计意图——尤其是权限白名单、配置约束、接口契约等易冲突区域。用 `grep` 扫描测试文件中的 `expect`/`not.toContain` 断言，识别潜在冲突。发现冲突时自行分析设计意图并给出建议方案，不把问题抛给用户。

   **机制判定前置（issue 驱动未经 requirement-analysis 的特性必做，动手前完成）**：本特性若未经方案流程（无 RA 产出的方案文档，如 issue 驱动直接实现），**在写第一行实现代码前**完成机制识别检查点判定（清单逐项打勾，清单与四问定义见 troubleshooting skill 修法排序节）——命中任一项 → **机制预算四问当场作答**，答案与方案同步成形（写进特性文档「设计取舍」段，该段可先于代码存在）；全部未命中 → 判定结论一行留痕（提交时写入「设计取舍」段）。经 RA 流程的特性此判定已在方案期完成，不重复。**为什么前置**：判定若留到实现后的文档步骤，四问就沦为补作业——方案已定代码已写，答四问改变不了任何决策；动手前判定，④退役条件和③后续机制才真实参与方案成形。
4. **实现**：按方案逐步实现。遵守 `references/coding-principles.md` 中的架构约束和命名规范。匹配项目术语。非显而易见的设计意图加注释。

   **省事声明即触发论证（事故教训，刹车一）**：规则与现场见 requirement-analysis 步骤 6 同名段（真相源）——本条管辖面扩到实现说明与 PR 描述：实现/提交时写「省事/更简/更快/零成本」类自评词同样触发论证义务，检视獭会核对。
5. **写测试**：为新增或修改的行为写测试。见 `references/testing-rules.md`。测试失败时先诊断：是测试错还是实现错？不自动回退业务代码。
6. **自检**：测试通过、符合项目规范、无方案外变更、无兼容桥代码、视觉变更有截图证据、发现的问题全部修复。

   **UI 视觉变更的真机自查（三轮修复事故硬规则）**：本次变更涉及布局/弹层/定位/样式（含疑似「UI 不生效」类 bug 修复）时，自检必须包含「真实浏览器亲眼看」：①起 dev server 或等价真实实例；②用无头浏览器（Playwright 或等价工具）**复现搭档的真实 UI 状态**（面板展开/收起、窗口尺寸、浏览器类型——无头验证不覆盖真实状态等于没验，此前右栏关闭验证漏掉右栏 containing block 现场）；③驱动复现路径后截图 + 关键元素 `getBoundingClientRect()` 数值取证，截图存对话工作区并在 PR Verification 节附路径；④弹层「不可见」类问题禁止只用 DOM 存在性断言交付——DOM 存在 ≠ 可见（现场：菜单渲染成功但 left=3130 飞出视口）。**代码推理猜不出渲染结果**：CSS containing block（祖先含 backdrop-filter/transform/filter/perspective 时 fixed 退化）、 stacking context、视口钳位这类问题只在渲染层现形，单测全绿不能替代亲眼看。依据：搭档原话「你有截图能力也有看图能力，为什么要我猜」。

   **废弃资源清理（教训）**：本次变更若替换/迁移了旧路径、旧文件、旧默认值（DB 路径、配置 fallback、硬编码常量），自检必须核查四件：①旧代码引用清零；②**旧文件本体删除**——只改代码默认值不删文件，会留下“看起来正常”的孤儿文件（现场：孤儿库 otter.db 残留 6 天，schema 完整、有真实数据痕迹，误导数据核查得出「零事件」错误结论，错误数据差点胜过搭档的正确记忆）；③旧配置/环境变量迁移说明写入特性文档；④DB 等运行时副本与 git 真相源同步（update-scheduled-task-body.mjs 类脚本）。

   **db 迁移类变更的真启动验证（事故教训硬规则）**：本次变更涉及 migration.ts 新增/修改迁移函数、或 schema.ts 表结构变更时，自检必须包含「生产副本真启动」：①备份生产 DB 副本；②在副本上执行完整启动路径（`scripts/otter-buddy.sh start` 或等价 bootstrap 调用），确认服务监听成功、日志无 SqliteError；③真启动结果（命令 + 关键日志行）写入自检报告与 PR Verification 节。**「跑迁移函数 + SQL 校验行数」不等于真启动**——现场：演练全绿，但崩溃点在 bootstrap enqueueRetry 的 ON CONFLICT，只有真启动能触达，SQL 校验永远摸不到。依据：同类事故已踩两次（漏迁移致启动 crash / CTAS 丢结构致启动 crash），第三次不可接受——出处见 git 历史与特性文档。

   **负面向验收条目（事故教训，刹车二）**：迁移/破坏性/替换类变更的验收与自检清单必须包含一条负面向条目——「**本次变更破坏了什么旧契约 / 绕过了什么既有保护**」。省事方案的标志就是绕过某个既有保护（现场：绕过 retry worker 兜底，绕过了 sqlite_master 结构保持），逼着作者把「绕过」写出来，很多雷在写的时候就会自己暴露。

   **pre-existing 声明硬门禁**：自检报告中的任何「pre-existing / 与本次变更无关」的测试失败声明，必须附验证证据——`git stash -u`（含未跟踪文件，防新增测试残留致假验证）后基线复跑输出，或基于 `origin/main` 的基线对照输出。无证据 = 未验证，不得写入自检报告（历史现场：5 个自引入失败被误报为与己无关，靠大獭人工核实才兜住）。

   **最简实现检查**（必答，结论记入特性文档「验证」节）：此方案能否用更少代码/文件/依赖达成同等效果？先过一道阶梯——仓库已有实现 → stdlib/平台原生 → 已装依赖 → 才写新代码（思想源 R20260828pntr §0：LLM 天然偏好过度建设，"我要一个函数，它给我一个框架"）。发现更简实现且不改语义 → 采简弃繁；确认已最简 → 在验证节记"已过最简检查"。

   **Golden Gate 自检（软代码改动必须）**：
   - **触发条件**：本次变更涉及 prompt/skill/协议层（软代码）时，必须跑 golden gate
   - **豁免（检视修正）**：verify_by.type 为 `static_only` / `human_judge`（纯润色或写作纪律类，golden 无对应场景可跑）时豁免跑 gate——但必须将豁免声明写入 PR Verification 节（「Golden Gate: n/a（verify_by=human_judge，无场景可跑）」），供 B7 核验。记录缺失且 PR 无豁免声明 = 严重发现
   - **执行**：在 worktree 内运行 `npm run test:capability` 或 `npx vitest run --config vitest.capability.config.ts`
   - **记录留存**：results.jsonl 会自动写入主仓根 `data/metrics/golden-results.jsonl`（P0-b 修通后）
   - **fail 处置闭环**：
     - 单场景 fail → 实现者复跑一次，复跑通过则记后续通过记录
     - 连续两次 fail → 修问题再跑，直至通过
     - 无法修复 → 走申诉留痕决议（在 PR 描述中说明理由）
   - **复跑主体 = 实现者**（生产方职责），检视獭不重复跑

   **CI 验证（必须）**：
   - 推送 PR 后，等待 CI 运行完成：`gh run watch`
   - CI 失败时立即诊断修复——检视也会将 CI 失败标记为严重发现

7. **文档**：将实现要点、变更说明写入本特性的文档——**新建追加，不改历史**（铁律）：本特性已有文档（本分支/本 PR 内创建）则追加；否则新建 `docs/features/` 文档记录，包括「本次变更对旧特性做了什么」也写在新文档里，回改已合入的历史文档一律禁止（特性文档约定见 worktree-isolation skill 步骤 4 内联段；pre-commit 的 lint-historical-docs 会机械拦截）。写完/改完文档后调 `sync_docs`（root_dir 传 worktree 绝对路径）立即入库，并用 `link_memory` 声明"当前讨论 produced 本文档"——让"这文档怎么来的"之后可被 get_related 拼出链。

   **机制判定核对**：机制识别检查点判定已在步骤 3（动手前）完成——本步骤只核对「设计取舍」段已含判定结论（命中则含四问答案），缺失 = 流程跳步，补判定并反思为何步骤 3 漏判。

   **Intent 块生成（软代码改动必须）**：
   - **触发条件**：本次变更涉及 prompt/skill/协议层（软代码）时，特性文档 frontmatter 必须生成 intent 块
   - **格式**（⚠️ verify_by 必须是对象不是字符串——三次同型 CI 红的根因就是照旧示例写成字符串；且 golden_gate 不是合法枚举）：在 frontmatter 中添加 `intent` 字段，包含 `problem`（要解决什么问题）、`expected_effect`（可判定的预期效果，字符串）和 `verify_by`（对象，`type` 用合法枚举）
   - **verify_by.type 合法枚举**（真相源 scripts/lint-intent.mjs，读它为准）：`metric_probe` / `behavior_check` / `human_judge` / `capability_test` / `golden_replay` / `static_only`
   - **commit 前本地跑** `npm run lint:intent`，0 error 才算过（CI 的 intent gate 会拦，本地提前拦住不用返工）
   - **n/a 须附理由**：如果 verify_by 填 n/a，必须附理由说明为什么不需要验证
   - **示例**（可直接抄的合规格式）：
     ```yaml
     intent:
       problem: "海獭在召唤小獭前不搜记忆，违反 R4 约束"
       expected_effect: "召唤前 search_memory 调用率从基线 X% 升至 ≥Y%，无相关结论时才创建新獭"
       verify_by:
         type: behavior_check
     ```
   - **目的**：让评测机制知道这个变更需要什么验证方式，是 golden gate 的输入信号

8. **提交**：特性 ID 生成纪律（先跑 `date` 取日期 + 新 ID 查重复用）见 worktree-isolation 步骤 4（真相源，本步不重复）。按 `references/commit-convention.md` 格式 commit，署名按 signature-convention skill。
9. **推送 PR**：`git push -u origin <branch>` + `gh pr create`。

> ⚠️ PR 创建 ≠ 交付完成。步骤 9 完成后必须立即进入步骤 10。

10. **对抗审视**：
   > 小獭没有 create_otter 能力，无法自行召唤检视獭。小獭完成代码后，将产出（PR 链接、worktree 路径、测试结果）交回大獭，由大獭编排对抗审视。

   - 召唤检视獭（`otter-summon`），systemPrompt 中附上：`gh pr diff` 全文、worktree 绝对路径、测试与构建结果（标注为实现者自报）。要求其先 read `adversarial-review` skill
   - 收到报告后校验合规性（含"本轮焦点"声明、发现分级、file:line 引用）——不合规打回重做
   - **对抗审视原则**：检视发现不等于命令。对每条发现必须批判性评估：检视者有 fresh eyes 但上下文浅，作者上下文全但有立场——碰撞才有价值；照单全收等于把检视者的误读原样引入，对抗审视退化为单人审阅；**每条发现强制走决策树——回答"改了让系统变好还是变更差"，更好→修复/建 issue，更差→带证据反驳**；四类处置：接受并修复 / 反驳（必须附证据）/ 部分接受 / 呈搭档裁决；无证据的反驳（"我觉得没问题"、"过度设计"）等同未处置；不作为不允许
   - 按 `../adversarial-review/references/author-response-protocol.md` 逐条处置：决策树判断 + 四分类响应（接受并修复 / 反驳 / 部分接受 / 呈搭档裁决）
   - 处置完成后，更新 PR review comment，追加处置结果（含更好/更差判断 + 四分类响应）
   - 更新命令：`gh pr comment <PR_NUMBER> --body "## 处置结果
[逐条处置，含更好/更差判断]"`
   - 修复后更新 PR，重新审视。第 2 轮起是 delta 审视（附上轮发现清单 + 处置（含更好/更差判断）+ 修复 diff + 更新后的 PR 描述，核对 Discovered Issues 节 issue 落实）
   - 收敛判据：修复验证全部通过 + 无严重发现未处置 + 无阻断回归 → 通过；对立僵局 / 移动靶 / 僵尸循环 → 呈搭档裁决
   - 审视通过 → 呈搭档终审（**必须附决策简报**，模板见 `../review-protocol/references/decision-briefing.md`，SYSTEM.md R8——只抛问题清单 = 裸奔拍板 = 违规）

### 问题处理

发现问题后，按以下流程处理：

1. 问题在方案范围内？ → 立即修复，不问"要不要修"
2. 问题与当前变更相关（同一模块/文件/函数）？
   - 相关 + 数量 ≤ 5 → 顺手修复，PR 描述 Discovered Issues 节记录（格式见 `references/commit-convention.md`）
   - 相关 + 数量 > 5 → PR 描述 Discovered Issues 节记录，审查者决定是否拆分 PR
3. 问题与当前变更无关？ → 不能静默丢失：执行 `gh issue create`，按 SYSTEM.md R2 Issue 标签与标题规范打标（type=bug 或 tech-debt + priority P0/P1/P2，标题 `[模块] 摘要`），issue 链接写入 PR 描述 Discovered Issues 节（格式见 `references/commit-convention.md`）

检视獭报上来的发现不适用上述规则 → 走 review-protocol 作者处置协议（`../adversarial-review/references/author-response-protocol.md`），带证据的反驳是合法处置。走「建 issue」子路径前必须过**关联度前置闸**：与本 PR 语义强关联的发现（守护本 PR 行为不回退 / 澄清本 PR 刚改的口径 / 修本 PR 变更直接引入或暴露的问题）默认当场修——原 PR 未合入修在原 PR，已合入立即开补充 PR；建 issue 的举证责任在作者，须论证为什么**不能**现在修且理由命中合法清单（依赖未就绪 / 需产品决策 / 增量 >300 行或 >3 个新模块），「需搭 fixture」「非本 PR 文件」不构成承载障碍。

## 锚点重放评审（核心 prompt 改动必须）

**触发条件**（规则化，不再是枚举清单——枚举式 gate 的盲区是「被改对象 ≠ 保护对象」的前提被 skill 改动打破）：本次变更涉及**任何 prompt/skill/tool description 的行为触发语义**时，必须在 PR 提交前跑一次「锚点重放评审」。判据一句话：改动会影响獭「什么时候做什么」的判断 → 必跑；纯润色/错别字/格式 → 豁免（豁免声明写入 PR Verification 节）。**拿不准 → 必跑**——判据模糊本身说明触达了行为语义边界。枚举参考（非穷举）：SYSTEM.md、全部 SKILL.md 工作流段、scheduled prompts、tool description 字符串。

**目的**：验证 prompt 改动没有让好产出变味或让坏产出的同类错再现——fail-closed。

**流程**：
1. 从 `tests/capability/golden/anchors/` 锚点语料库中抽样（至少坏锚点 5 条 + 好锚点 3 条）
2. 用改动后的 prompt 版本重放锚点的背景场景，由**异体模型**（不同于实现者的模型）评审产出质量
3. 评审输出**限带宽**（防评审本身变成另一个不可控产出）：
   - 输出格式：`VERDICT: YES/NO` + 一句话理由
   - YES = 产出质量通过（好锚点产出未变味 / 坏锚点同类错未再现）
   - NO = 产出质量不通过（需说明哪条元规则被违反）
4. 结果写入 PR Verification 节；NO 不过 = 不得合入

**评审 prompt 模板**（异体模型使用）：
```
你是一位严格的质量评审员。以下是海獭系统的一个历史产出锚点：

【锚点 ID】{anchor_id}
【判定】{verdict}（好/坏）
【元规则】{meta_rule}
【背景】{background}
【獭产出】{otter_output}
【实际发生】{what_happened}
【搭档反应】{buddy_reaction}

现在，假设用改动后的系统 prompt 重放这个场景，獭会交出什么样的产出？
请评估：
- 如果这是好锚点：新产出的质量是否仍达到或超过原产出？
- 如果这是坏锚点：同类错误是否仍会发生？

输出格式（严格遵守）：
VERDICT: YES 或 NO
REASON: 一句话理由
```

**元规则门禁检查清单**（评审时可作补充参考，完整来源见 `tests/capability/golden/anchors/README.md`）：
1. 证据必须真实可核，禁止杜撰/假数据（A1、D4）
2. 修复要治本想清楚，不补丁叠加（A2）
3. 交付文档/手册要可实操，不让搭档踩坑排查（A6、C1）
4. 编排纪律：产出交回大獭，不越权找搭档；流程不跳步（B2、B5）
5. 状态如实汇报，不虚报「进行中」（C5）
6. 交接/编号类资产动笔前重跑 date 核实（C3、D1）
7. 取舍依据/顾虑随结论主动呈现，不等问（D3）
8. 汇报以搭档为读者组织脉络，信息全 ≠ 讲清楚（D5）

## 产出

| 产出 | 下一步 | 执行者 |
|------|--------|--------|
| 特性文档（docs/features/F*.md，步骤 7） | 随 PR 接受对抗审视 B2 文档完整性检核 | 检视獭 |
| 代码 PR | **对抗审视（必须）** | 检视獭 |
| 审视通过 | 呈搭档终审（附决策简报） | 搭档 |
| 排查结论（需修复） | worktree-isolation | 当前獭 |

## 参考（索引）

- `references/testing-rules.md` — 步骤 5 使用
- `references/coding-principles.md` — 步骤 4 使用
- `references/commit-convention.md` — 步骤 8 使用
- 署名按 signature-convention skill — 步骤 8 使用
- 审视循环按 review-protocol skill — 步骤 10 使用
- `../adversarial-review/references/author-response-protocol.md` — 步骤 10 使用
