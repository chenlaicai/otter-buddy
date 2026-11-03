---
id: F20261103repro
title: 复现对照栏位（A）+ radar 确定性层 fixture 回归（C）——Momentic 启示落地方案
summary: A 把既有「bugfix 失败用例证据」硬规则从 skill 文本升级为 PR 模板「复现对照」栏位 + B9 核对项（半机械+异体审，不加机械闸）；C 给 radar 确定性抓取层 scan.mjs 抽纯函数并建 fixture 回归（过滤/排序/slug 提取/输出 schema），定时任务脚本改动一条命令可验。B（检视质量双指标）搭档已否，不做不计 issue。
change_type: prompt
capability_test: "n/a：模板/skill 文档与确定性脚本测试，无 LLM 行为面改动"
created_in_conversation: 98bd9fdd-8e28-4de8-b782-b59f46e733dd
created_at: 2026-11-03
tags: [requirement, evidence-package, test-infrastructure, radar]
modules: [.github, .pi/skills, scripts/radar, tests]
causal_links:
  - F20261028evpkg（证据化交付协议：Rollback 段 + 证据分层声明 + check-pr-evidence 机械闸 + B9，本方案 A 项与其同构延伸）
  - F20261009rdps（radar 脚本入库，本方案 C 项为其补确定性层回归）
---

# 复现对照栏位（A）+ radar fixture 回归（C）

> 意图锚点（chat，2026-11-03）：搭档提出「你们海獭写代码的质量到底如何」三维度关切（整洁准确 / 方向正确 / 全局思维）；经 Momentic 讨论收敛为 A、C 两个落地项，搭档拍板「你把 ac 深入分析下出个方案」。B 项（检视质量双指标）搭档拍板「既然是给人，那就不做，也不计 issue」。

## 背景

Momentic（AI QA agent，HN 2026-11-02）的启示按「验证物证化 / 验收资产进 repo / 质量活动双指标」三条对照本仓现状，其中两条可落地：

- **A 的现状缺口**：「bugfix PR 必附失败用例证据」硬规则已存在（worktree-isolation SKILL.md 步骤 4：修复前失败输出 + 修复后通过输出，两者均不可行时附豁免记录），但它是 skill 文本里的孤规则——PR 模板没有对应栏位，B9 证据包核验不查它，机械闸（check-pr-evidence）不管它。2026-11-03 抽样 2 个修复类 PR：#1741 完整合规（失败用例证据链齐全），#1732（标题含 [BugFix]）全文无「复现/失败用例/修复前」任何字样仍合入。规则存在但执行两张皮（小样本 n=2，仅作例证不作统计）。
- **C 的现状缺口**：radar 三件套（scan.mjs / fetch_anthropic.py / README.md）入库于 F20261009rdps，tests/ 零覆盖（2026-11-03 grep 确认仅 dispatch-chain 测试的字符串字面量提及 scan.mjs）。scan.mjs 的 HN 粗筛正则与过滤规则是分拣质量的第一道闸，README 明示「改动需同步」= 已知会改；改了没有回归 = 分拣质量漂移只能靠人眼发现。

记忆检索对照（先找反对）：2026-09-08「掘根独立意见：抵抗补丁叠加」结论——固定检查清单会退化成橡皮图章，真正有阻力的是不可预测的追问深度；2026-10-28 audit 框架讨论——自动审计帮搭档深潜被否，方向是降低深潜成本。这两条直接塑造了 A 的取舍 1（不加机械闸、不做样板文章）与四问①（深潜成本）。

## 目标

- **T1（A）**：修复类交付的「复现对照」从 skill 文本硬规则升级为 PR 模板可见栏位 + B9 核对项，复核者拿到 PR 即可复跑复现步骤，不用逆向拼路径。
- **T2（C）**：radar 确定性层（scan.mjs）建 fixture 回归——固定输入 → 期望输出，机器可验；改抓取/过滤/排序逻辑时一条命令确认没漂。

## 非目标

1. **不做检视质量双指标**（B）：搭档 2026-11-03 拍板不做、不计 issue（原话「既然是给人，那就不做，也不计issue」）。
2. **不给 LLM 分拣层建 fixture**：README ②③层规则是 LLM 判定层，无确定性期望输出；回归只覆盖 scan.mjs 确定性抓取层（网络 IO 之外的逻辑）。
3. **不动 check-pr-evidence 机械闸**：不为复现对照新增自动守卫（见取舍 1）。
4. **不覆盖 fetch_anthropic.py**：Python 侧需引入 pytest 基建，试点不铺开；看 scan.mjs 试点效果再议。

## 未决问题

无阻塞未决。一个默认值供搭档否决：复现对照适用范围取「修复类必填、非修复类填『不适用』」而非「凡行为变更都建议」——需求锚点是修复复核成本，全量必填制造模板噪音。

## 方案设计

### A. 复现对照栏位

1. **`.github/pull_request_template.md`**：Verification checklist 之后新增「## 复现对照」节，固定三行结构：
   - **修复前现象**：命令 + 输出摘录（事故/错误形态原样贴）
   - **复现步骤**：编号步骤（最小复现路径，来自 troubleshooting 步骤 5a 的固化产物）
   - **修复后对照**：同一命令的修复后输出
   - 非修复类交付填「不适用：非修复类」。
2. **`.pi/skills/worktree-isolation/SKILL.md`**：步骤 4 硬规则指认模板栏位（写进 PR 模板「复现对照」节），消除规则与模板两张皮。
3. **`.pi/skills/adversarial-review/SKILL.md` + `references/review-dimensions.md`**：B9 补核对项——修复类交付缺复现对照节或三行与 diff 不符 = 严重发现；**抽样复跑 1-2 条复现步骤**（与 B9 现有「抽样点开机器锚点复验」同构）。语义真实性不进机械闸，标「半机械+异体审」。
4. **不加机械闸**（显式决策）：复现对照的真实性是语义判定（假复现步骤机器查不出），机械闸只能查节存在性，只会催生「填了就算数」的合规假象——正撞 9/8 教训。存在性检查的托底价值低于橡皮图章成本。

### B. （不做）

搭档已否，不展开。

### C. radar 确定性层 fixture 回归

1. **scan.mjs 抽纯函数（行为零变更重构）**：过滤（HN_KEYWORDS 粗筛/剔蹭热点）、排序、slug 提取去重、输出 JSON 组装、stdout 摘要格式——抽为可导出纯函数（scan.mjs 内 export 或薄 lib），main() 只剩网络+文件 IO。重构是机械搬移，不改任何输出字节。
2. **`tests/scripts/radar-scan.test.ts` + `tests/fixtures/radar/`**：录制真实响应样例（HN 列表含蹭热点假 AI 样例、GitHub 样例、Anthropic slug HTML 片段）做输入 fixture，断言：假 AI 过滤命中/漏杀、分数降序排序、slug 提取去重、raw JSON schema、stdout 摘要行格式。测试框架用既有 vitest，测试落 tests/scripts/ 与 check-pr-evidence.test.ts 同层。
3. **CI 圈定**：ci.yml 的 vitest 步骤按目录圈定（现状圈 tests/guard/ 等）；实现时把新测试文件加进既有 vitest 步骤的圈定列表（一行改动），细节实现时确认。
4. **重构验证**：同 fixture 输入重构前后输出逐字节一致 + 真实跑一次 scan.mjs 与 11-03 已有 raw 样本对照结构一致（定时任务脚本惊扰是最大风险，行为零变更 + 对照是硬约束）。

## 影响范围

| 面 | 影响 |
|---|---|
| PR 流程 | 所有 PR 可见新栏位；修复类 PR 多三行必填 |
| 检视流程 | B9 多一条核对项 + 抽样复跑 |
| radar 定时任务 | scan.mjs 重构，运行行为零变更（fixture 回归即其保障） |
| CI | vitest 圈定列表一行 |
| 历史数据 | 无（模板与测试均不影响存量） |

## 风险与约束

- **A 的橡皮图章风险**：填了假复现步骤。缓解：B9 抽样复跑；这是半机械+异体审的已知边界，显式标注不假称托底。
- **C 重构惊扰定时任务**：每日 8:30 AI 雷达依赖 scan.mjs。缓解：机械搬移 + fixture 逐字节对照 + 真实跑一次对照；不顺手改行为。
- **爆炸半径归档（R8 锚点，只填值不改档）**：变更规模=多文件（约 6-7 个）；路径杠杆=skill 文件属高杠杆行为面（A 项）；可逆性=git 可回滚；影响面=单仓可隔离。归档结论：L1（PR + 对抗审视），其中 A 项触 skill 文件按升档锚点在实现 PR 走完整对抗审视（检视獭核对归档与锚点一致）。

## 不兼容更新

无。模板新增节不影响历史 PR；scan.mjs 承诺输出不变。

## 设计取舍

| # | 取舍点 | 选项 | 决定 | 理由 |
|---|---|---|---|---|
| 1 | 复现对照的检查方式 | 机械闸 vs 异体审 | 异体审（B9 抽样复跑）+ 模板栏位 | 语义真实性机器查不出，机械闸只查存在性会催生合规假象（9/8：固定检查点被合规答案糊弄）；显式标半机械+异体审 |
| 2 | 适用范围 | 全部 PR vs 仅修复类 | 修复类必填，其余填「不适用」 | 需求锚点=修复复核成本；全量必填制造模板噪音 |
| 3 | C 试点对象 | scan.mjs vs fetch_anthropic.py vs 全管线 | scan.mjs 先行 | TS+vitest 基建零新增；Python 侧需 pytest 另立；scan.mjs 的粗筛正则 README 明示会改，回归价值最高 |
| 4 | C 结构 | 测试里 mock 网络 vs 抽纯函数 | 抽纯函数 + 录制 fixture | 纯函数直接可测，避免网络 mock 框架；fixture 是录制的真实响应，语义保真 |

## 机制识别检查点

命中偏严清单边缘项「消息格式（PR body 新增结构化节）」→ 四问 + 准入三问作答（C 项为测试，不涉机制）：

**四问**：①谁需要它——检视獭与复核者（搭档深潜修复类 PR 时）；②失败后果——可感知（复核仍需逆向拼复现步骤，现状原样）；③后续机制——可能催生「填了就算数」，用 B9 抽样复跑对冲；④退役条件——若连续观察 20 个修复类 PR 的复现对照均为无人复核的摆设（复跑全虚），删节退回 skill 文本。
**准入三问**：①决策者没变——验收判断仍在检视獭与搭档，栏位只是证据供给；②半机械+异体审（显式标注，不假称机械托底）；③深潜成本降——复核者拿到即用的复现步骤，不必逆向拼路径。

## 验证

- **A**：模板三行结构渲染自查 + skill/维度文档三处口径一致；文档面无自动化，以实现 PR 的对抗审视核对。
- **C**：`npx vitest run tests/scripts/radar-scan.test.ts` 绿；重构前后同 fixture 输出逐字节一致；真实跑 scan.mjs 与 11-03 raw 样本结构对照。
- **Acceptance Test（最终验收断言）**：
  1. 新建测试 PR 选修复类时，模板「复现对照」节三行结构可见且 worktree-isolation 硬规则指认该栏位；
  2. B9 核对项含「修复类缺复现对照 = 严重发现」与「抽样复跑 1-2 条」；
  3. radar-scan 测试覆盖过滤/排序/slug/schema 四类断言且被 CI vitest 步骤圈定执行；
  4. scan.mjs 重构后真实运行输出结构与重构前一致。

## 改动范围

| 文件 | 动作 | 内容 |
|---|---|---|
| .github/pull_request_template.md | 修改 | 新增「复现对照」节（三行结构 + 不适用出口） |
| .pi/skills/worktree-isolation/SKILL.md | 修改 | 步骤 4 硬规则指认模板栏位 |
| .pi/skills/adversarial-review/SKILL.md | 修改 | B9 补复现对照核对项 |
| .pi/skills/adversarial-review/references/review-dimensions.md | 修改 | B9 行同步 |
| scripts/radar/scan.mjs | 重构 | 抽纯函数，行为零变更 |
| tests/scripts/radar-scan.test.ts | 新增 | fixture 回归 |
| tests/fixtures/radar/* | 新增 | 录制响应样例 |
| .github/workflows/ci.yml | 修改（若需） | vitest 圈定加一行 |
