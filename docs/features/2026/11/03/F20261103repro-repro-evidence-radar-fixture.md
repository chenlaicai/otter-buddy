---
id: F20261103repro
title: 复现对照栏位（A）+ radar 确定性层 fixture 回归（C）——Momentic 启示落地方案（双评审修订版）
summary: A 把既有「bugfix 失败用例证据」硬规则升级为 PR 模板 Verification 内「失败用例证据」子块 + B9 判别力核对（半机械+异体审，不加机械闸，保留豁免出口）；C 给 radar 确定性抓取层抽零副作用 lib 并建 fixture 回归（过滤/排序/slug/schema/stdout 契约）。②③层（方向正确/全局思维）本次不加新机制，另有并行「案例回看」摸底既有机制有效性。B 项搭档已否，不做不计 issue。
change_type: prompt
capability_test: "n/a：模板/skill 文档与确定性脚本测试，无 LLM 行为面改动"
created_in_conversation: 98bd9fdd-8e28-4de8-b782-b59f46e733dd
created_at: 2026-11-03
intent:
  problem: "修复证据只存在 skill 文本，复核缺少可复跑且有判别力的路径；radar 分拣规则零回归"
  expected_effect: "修复类 PR 在 Verification 子块给出前后对照或豁免理由，B9 核对三查并抽样；radar 测试独立断言过滤、排序、slug、raw schema、stdout 与 main 接线"
  verify_by:
    type: behavior_check
tags: [requirement, evidence-package, test-infrastructure, radar]
modules: [.github, .pi/skills, scripts/radar, tests]
causal_links:
  - F20261028evpkg（证据化交付协议：Rollback 段 + 证据分层声明 + check-pr-evidence 机械闸 + B9，本方案 A 项与其同构延伸）
  - F20261009rdps（radar 脚本入库，本方案 C 项为其补确定性层回归）
  - F20260908pgrd（9/8 掘根讨论：固定清单退化成橡皮图章、B9 抽样复跑的教训来源）
---

# 复现对照栏位（A）+ radar fixture 回归（C）· 双评审修订版

> 意图锚点（chat，2026-11-03）：搭档提出「你们海獭写代码的质量到底如何」三层关切（整洁准确 / 方向正确 / 全局思维不打补丁）；经 Momentic 讨论收敛为 A、C 两个落地项，搭档拍板「你把 ac 深入分析下出个方案」。B 项（检视质量双指标）搭档拍板「既然是给人，那就不做，也不计 issue」。
>
> 评审与拍板记录（2026-11-03）：格物（GLM）裁决方向【保留】、凯米（Kimi）裁决方向【调整】，共识=A/C 保留 + 边界声明必补。搭档卡回执拍板「都做——A/C 修订开工 + 方向/全局层案例回看并行」。

## 边界声明（双评审共同要求，置于方案之首）

搭档的质量关切三层：①代码整洁准确 ②方向是否正确 ③不打补丁有全局思维。**本方案只直接回应①层**（A：修复可验证性）**与外围测试基建**（C）。②③层本次**不加任何新机制**，由既有机制承担：设计时刻「该不该存在」对抗提问（2026-09-08 落地）、每日全局回看、对抗审视维度。

**既有机制存在 ≠ 有效**（凯米观点，采纳）——因此拍板「都做」的另一条腿是并行启动「方向/全局层案例回看」（见末节）：抽近期真实 PR 重建「当时该不该做」的判断，摸既有机制的命中与漏检，拿到有效性证据再决定②③层要不要补机制。**在回看结论出来之前，不得以「既有机制覆盖」为由宣称三层都有着落。**

## 背景

Momentic（AI QA agent，HN 2026-11-02）的启示按「验证物证化 / 验收资产进 repo / 质量活动双指标」三条对照本仓现状，其中两条可落地：

- **A 的现状缺口**：「bugfix PR 必附失败用例证据」硬规则已存在（worktree-isolation SKILL.md:71：修复前失败输出 + 修复后通过输出，两者均不可行时附豁免记录），但它是 skill 文本里的孤规则——PR 模板没有对应栏位，B9 证据包核验不查它，机械闸（check-pr-evidence）不管它。2026-11-03 抽样 2 个修复类 PR：#1741 证据链齐全合规，#1732（标题含 [BugFix]）全文无「复现/失败用例/修复前」任何字样仍合入。规则存在但执行两张皮（小样本 n=2，仅作例证不作统计）。
- **C 的现状缺口**：radar 三件套入库于 F20261009rdps，tests/ 零覆盖。scan.mjs 的 HN 粗筛正则与过滤规则是分拣质量的第一道闸，README 明示「改动需同步」= 已知会改；改了没有回归 = 分拣质量漂移只能靠人眼发现。立项理由是「每日定时依赖 + 当前零行为测试 + 补测成本低」（凯米修正：不以「高频改动」立论，git 历史只有迁移提交）。

## 双评审修订记录（2026-11-03，采纳七条）

1. **边界声明**（上节）——两位一致要求，L2 呈报义务。
2. **CI 无圈定问题**：tests/scripts/ 由 `npm test`（vitest run 全量）自动覆盖（ci.yml:140「Run tests: npm test」、package.json:18），**删除**原方案「ci.yml 加一行」（凯米发现，大獭已核实）。
3. **锚点纠错**：review-dimensions.md 只有 B1-B4 详节、无 B9（:5-74），原写「B9 行同步」应为「**新增 B9 小节**」（两獭同报，大獭已核实）。
4. **豁免出口补回**：现行硬规则允许「测试与最小脚本均不可行时附豁免理由一句」，原方案三行硬必填丢了它，是规则倒退——保留「豁免 + 理由 + 检视核对」（凯米发现）。
5. **非修复类省略**：不填「不适用」占位行，直接不写子块——少一行噪音（格物发现）。
6. **复现检查分工 + 判别力三查**：B9 管证据真伪与判别力，B3 管真跑复现（凯米发现）。判别力三查（#1741 死断言教训：证据齐全≠修复正确）：修复前确实因目标 bug 失败（非任意报错）；修复过程没有改弱原失败用例；修复后断言真正判别目标行为（非永不命中的死代码）。
7. **复现证据放 Verification 子块而非新增顶层节**（凯米）——证据面收敛：模板已同时存在 Verification、证据分层声明两处证据面，再开顶层节必混填。分节边界：Verification 子块=失败用例证据链（复现路径本体）；「证据分层声明」只管机器锚点/agent 陈述分层，不放证据本体（回应格物「边界写清」）。

## 目标

- **T1（A）**：修复类交付的失败用例证据从 skill 文本硬规则升级为模板可见子块 + B9 判别力核对，复核者拿到 PR 即可复跑复现路径；证据要「有判别力」而不只是「有」。
- **T2（C）**：radar 确定性层建 fixture 回归——固定输入 → 期望输出，机器可验；改抓取/过滤/排序逻辑时一条命令确认没漂。

## 非目标

1. **不做检视质量双指标**（B）：搭档拍板不做、不计 issue。
2. **不给 LLM 分拣层建 fixture**：README ②③层规则是 LLM 判定层，无确定性期望输出；回归只覆盖 scan.mjs 确定性抓取层。
3. **不动 check-pr-evidence 机械闸**：首期不为复现证据新增自动守卫（论证见取舍 1）。
4. **不覆盖 fetch_anthropic.py**：Python 侧需引入 pytest 基建，试点不铺开。
5. **本 PR 不含案例回看**：回看是并行独立工作项，产出单独呈报，不混入本 PR。

## 方案设计

### A. 失败用例证据子块（Verification 内）

1. **`.github/pull_request_template.md`**：Verification 节内新增「**失败用例证据（bugfix）**」子块：
   - **修复前现象**：命令 + 输出摘录（事故/错误形态原样贴）
   - **复现步骤**：编号步骤（最小复现路径）
   - **修复后对照**：同一命令的修复后输出
   - **豁免出口**：测试与最小脚本均不可行时，写一句豁免理由（沿用现行硬规则口径）
   - **非修复类不写本子块**（省略，不填「不适用」占位）
2. **`.pi/skills/worktree-isolation/SKILL.md`（:71 区域）**：硬规则指认模板子块（「写进 PR 模板 Verification 节『失败用例证据』子块」），保留豁免出口原文，消除规则与模板两张皮。
3. **`.pi/skills/adversarial-review/SKILL.md` B9 行 + `references/review-dimensions.md` 新增 B9 小节**：核对项——修复类缺失败用例证据子块 = 严重发现；**判别力三查**（修复前确实因目标 bug 失败 / 用例未被改弱 / 断言真有判别力）；**抽样复跑 1-2 条复现步骤**，环境自包含的步骤优先复跑，需重建现场的降级为「复现步骤与 diff 逻辑一致性核对」并显式记录降级。
4. **B3 分工**：真跑复现归 B3 端到端验证维度；重环境降级口径同上。B9 与 B3 不重复计账。
5. **不加机械闸**（首期取舍，论证收敛）：复现证据的真实性与判别力是语义判定，机械闸只能查存在性——「存在即合规」正是橡皮图章风险（2026-09-08 教训）。凯米的保留意见采纳为论证收敛：check-pr-evidence 已示范「机械查结构、真实性交 B9」的分层（check-pr-evidence.mjs:5-12），故不把机械存在性检查一概否定——首期不加的理由是**控制首期成本、先观察 B9 漏检率**，观察窗后若「填了就算数」普遍，再议结构性机械检查。

### B. （不做）

搭档已否，不展开。

### C. radar 确定性层 fixture 回归

1. **抽零副作用纯函数到 `scripts/radar/scan-lib.mjs`**：过滤（HN_KEYWORDS 粗筛）、排序、slug 提取去重、输出 JSON 组装、stdout 摘要行格式——纯函数模块零副作用；scan.mjs 只剩网络+文件 IO + main()。**不采用「scan.mjs 内 export」方案**：该文件 import 即建目录/发网络请求/写文件（scan.mjs:83-97 顶层副作用），测试直接 import 会触发真实副作用（凯米发现）。重构是机械搬移，不改任何输出字节。
2. **`tests/scripts/radar-scan.test.ts` + `tests/fixtures/radar/`**：录制真实响应样例做输入 fixture，断言五类：假 AI 过滤命中/漏杀、分数降序排序、slug 提取去重、raw JSON schema、stdout 摘要行格式（**保留**——README:25-26 明示 stdout 供 LLM 分拣层直接消费，是跨层契约；不因「展示层」降级，凯米反驳格物，采纳。但只做关键行格式断言，不做全文快照）。
3. **fixture 期望值独立编写**：期望输出由输入与分拣规则人工推导写定，**禁止**从当前实现批量生成再由同一实现自证——那是锁现状不锁正确（凯米发现）。补一条轻集成用例：main() 接线（纯函数被 main 真实调用）或网络异常路径。
4. **不改 ci.yml**：vitest 全量已覆盖 tests/（见修订记录 2）。
5. **重构验证（硬约束）**：同 fixture 输入重构前后输出逐字节一致 + 真实跑一次 scan.mjs 与 2026-11-03 raw 样本对照结构一致（scan.mjs 是每日 8:30 雷达依赖，惊扰定时任务是最大风险）。

## 影响范围

| 面 | 影响 |
|---|---|
| PR 流程 | 修复类 PR 的 Verification 多一个子块（三行 + 豁免出口）；非修复类无感 |
| 检视流程 | B9 多判别力三查 + 抽样复跑（分级降级）；B3 承接真跑复现 |
| radar 定时任务 | scan.mjs 重构，运行行为零变更（fixture 回归即其保障） |
| CI | 无改动 |
| 历史数据 | 无 |

## 风险与约束

- **A 的橡皮图章风险**：填了假复现步骤。缓解：B9 判别力三查 + 抽样复跑（含降级口径）；显式标半机械+异体审，不假称托底。
- **C 重构惊扰定时任务**：机械搬移 + fixture 逐字节对照 + 真实跑一次对照；不顺手改行为。
- **爆炸半径归档（R8 锚点，只填值不改档）**：变更规模=多文件（约 6 个）；路径杠杆=skill 文件属高杠杆行为面（A 项）；可逆性=git 可回滚；影响面=单仓可隔离。归档结论：L1（PR + 对抗审视），A 项触 skill 文件走完整对抗审视，检视獭核对归档与锚点一致。

## 不兼容更新

无。模板子块对历史 PR 无影响；scan.mjs 承诺输出不变。

## 设计取舍

| # | 取舍点 | 选项 | 决定 | 理由 |
|---|---|---|---|---|
| 1 | 复现证据的检查方式 | 机械闸 vs 异体审 | 首期异体审（B9 判别力三查+抽样复跑），机械存在性检查留观察窗后再议 | 语义真实性与判别力机器查不出；机械闸只查存在性会催生「填了就算数」（2026-09-08 教训）；但不一概否定结构检查（凯米保留意见采纳，论证收敛为首期成本取舍） |
| 2 | 证据放置 | 新增顶层节 vs Verification 子块 | Verification 子块 | 证据面收敛，避免三处证据面混填（凯米）；与现行 skill:71 口径一致 |
| 3 | 适用范围 | 全部 PR vs 仅修复类 | 修复类（非修复类省略子块） | 需求锚点=修复复核成本；省略优于「不适用」占位（格物） |
| 4 | C 试点对象 | scan.mjs vs fetch_anthropic.py | scan.mjs 先行 | TS+vitest 基建零新增；Python 侧需 pytest 另立；试点范式意义大于本体 |
| 5 | C 结构 | scan.mjs 内 export vs 独立零副作用 lib | 独立 lib | scan.mjs 顶层副作用，import 即触发真实网络与写盘（凯米） |
| 6 | fixture 期望来源 | 实现导出 vs 独立编写 | 独立编写 | 同实现自证只锁现状不锁正确（凯米） |

## 机制识别检查点

命中偏严清单边缘项「消息格式（PR body 新增结构化子块）」→ 四问 + 准入三问作答（C 项为测试，不涉机制）：

**四问**：①谁需要它——检视獭与复核者（搭档深潜修复类 PR 时）；②失败后果——可感知（复核仍需逆向拼复现路径，现状原样）；③后续机制——可能催生「填了就算数」，用 B9 判别力三查 + 抽样复跑对冲，观察窗后复核漏检率；④退役条件——若连续 20 个修复类 PR 的复现证据均为无人复核的摆设（复跑全虚/判别力三查全过但事后发现假证据），删子块退回 skill 文本。
**准入三问**：①决策者没变——验收判断仍在检视獭与搭档，子块只是证据供给；②半机械+异体审（显式标注）；③深潜成本降——复核者拿到即用的复现路径。

## 验证

- **A**：模板子块三行结构+豁免出口渲染自查；skill/维度文档三处口径一致（worktree-isolation:71 指认、B9 核对项、review-dimensions.md 新增 B9 小节）；以实现 PR 的对抗审视核对。
- **C**：`npx vitest run tests/scripts/radar-scan.test.ts` 绿（CI 全量测试自动覆盖）；重构前后同 fixture 输出逐字节一致；真实跑 scan.mjs 与 2026-11-03 raw 样本结构对照。
- **Acceptance Test（最终验收断言）**：
  1. PR 模板 Verification 节含「失败用例证据（bugfix）」子块（三行 + 豁免出口），非修复类省略；worktree-isolation:71 指认该子块；
  2. B9 含判别力三查 + 抽样复跑（含降级口径），review-dimensions.md 有 B9 小节，B3 承接真跑复现；
  3. radar-scan 测试覆盖过滤/排序/slug/schema/stdout 五类断言 + 一条 main 接线或异常路径用例，期望值独立编写；
  4. scan.mjs 重构后真实运行输出结构与重构前一致。

## 改动范围

| 文件 | 动作 | 内容 |
|---|---|---|
| .github/pull_request_template.md | 修改 | Verification 节加「失败用例证据（bugfix）」子块（三行+豁免出口） |
| .pi/skills/worktree-isolation/SKILL.md | 修改 | :71 硬规则指认模板子块（保留豁免出口） |
| .pi/skills/adversarial-review/SKILL.md | 修改 | B9 行补判别力三查 + 抽样复跑（分级降级） |
| .pi/skills/adversarial-review/references/review-dimensions.md | 修改 | **新增 B9 小节**（非行同步） |
| scripts/radar/scan-lib.mjs | 新增 | 零副作用纯函数（过滤/排序/slug/组装/stdout 格式） |
| scripts/radar/scan.mjs | 重构 | 只剩网络+文件 IO+main，行为零变更 |
| tests/scripts/radar-scan.test.ts | 新增 | fixture 回归（期望独立编写）+ 一条接线/异常用例 |
| tests/fixtures/radar/* | 新增 | 录制响应样例 |

## 实现记录

- A：PR 模板 Verification 新增「失败用例证据（bugfix）」子块；worktree-isolation 硬规则指认该子块并保留豁免出口；adversarial-review B9 与 review-dimensions.md 新增小节对齐判别力三查、抽样复跑及 B3 分工。
- C：`scan-lib.mjs` 承接零副作用纯函数，`scan.mjs` 保留网络/文件 IO 与 main；新增三源录制 fixture、9 条用例（含子进程离线 main 接线与 stdout 逐字节断言），期望从输入和 README 规则独立推导。
- 验证记录见下方「实现自检（2026-11-03）」，命令输出与 PR 机器锚点随交付更新。

## 实现自检（2026-11-03）

| 场景 | 操作 | 预期结果 |
|---|---|---|
| 确定性单测 | `npx vitest run tests/scripts/radar-scan.test.ts` | 全部通过，覆盖过滤命中/漏杀、排序、slug 去重、raw schema、stdout 与 main 接线 |
| 离线重构对照 | 同一三源 fixture、固定时钟分别驱动重构前后 `scan.mjs` | sources JSON 逐字节一致；stdout 仅输出目录不同，归一化后逐字节一致 |
| 真实抓取 | `node scripts/radar/scan.mjs /tmp/radar-verify` | 成功写 `/tmp/radar-verify/raw/2026-11-03.json`；与对话工作区 2026-11-03 raw 样本顶层/源/条目字段结构一致（条数随实时源变化） |
| 最简实现检查 | 复用 Node 内置 fetch/fs 与 vitest，不新增依赖 | 已过最简检查 |
| 负面向验收 | 检查本次是否破坏旧契约/绕过既有保护 | 不改过滤规则、抓取顺序、raw 字段或 stdout 格式；不新增机械闸，不绕过 check-pr-evidence；唯一代码结构变化为纯函数抽离 |
| 锚点重放评审 | 本次为半机械结构文档 + 检视核对条款，无 LLM 场景新语义可重放 | 走异体对抗审视核对触发语义，不声称已跑异体锚点评审 |

Golden Gate：按 `verify_by=behavior_check` 执行并记录结果，不豁免。

### 验证结果（实现者自报）

- `npx vitest run tests/scripts/radar-scan.test.ts`：1 file / 9 tests 全通过。
- `npm run lint`、`npm run lint:skills`、`npm run lint:tests`、`npm run lint:docs`、`npm run lint:intent`：exit 0；intent 本特性存在率与 verify_by 率均 100%。skills/docs/intent 输出含存量警告，本特性无 error。
- 离线同 fixture 双跑：`sources JSON: byte-identical`；stdout 在输出目录归一化后 `diff` 无输出（exit 0）。
- 真实抓取：写 `/tmp/radar-verify/raw/2026-11-03.json`；HN 12 / GitHub 30 / Anthropic 10。根与三源 key、HN/Anthropic 条目结构与 2026-11-03 样本一致；GitHub 当次有 30 条，字段为 `created/desc/repo/stars/topic`（早间样本 items 为空，不能据空数组比较条目字段）。

## 并行工作项：方向/全局层案例回看（不在本 PR 内）

凯米提案、拍板「都做」采纳：抽近期真实 PR（含 [Design]/[BugFix]），对每个独立重建「当时该不该做这个改动」的判断（需求意图、根因、被否方案、相邻调用方、后续补丁），核对既有机制（存在性对抗提问、每日全局回看、对抗审视维度）当时抓到了什么、漏了什么，产出**有效性证据矩阵**（案例 × 机制命中/漏检）。结论决定②③层是否补机制——**只摸底，不预设「必须补」**。产出单独呈报搭档。
