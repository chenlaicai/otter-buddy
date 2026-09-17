---
id: F20260917pbgg
title: 定时任务 prompt 体积预算闸：写入拦截 + 存量出清 + review 维度补盲
doc_type: feature
change_type: feature
summary: |
  issue #1030 重大事故根治：daily-health-check.md 23 天增长 4.6 倍（4479B→20607B，
  18 次 PR 纯加法），超出 scheduled_tasks.body CHECK 约束（length<=10000），同步
  失败静默降级，DB 跑三周旧版。根因：修 bug 默认往 prompt 加规则的纯加法沉淀 +
  lint/CI/review 三层均无体积维度 + 防线在 DB 写入末端且哑。根治四层：写入闸
  （lint-prompt-size.mjs 进 CI）+ 存量出清（20563B→9163B，-55%）+ 对账降噪改响
  （failed 明细 + error 日志）+ review checklist 补 B8 体积维度。核心认知：bug
  的本质不是文件太大，是系统没有控制自己变大的能力。
capability_test: tests/scripts/lint-prompt-size.test.ts
created_in_conversation: 325ef7b7-8e42-4edc-9abf-eae8f332a2c4
tags: [prompt, scheduler, governance, entropy-reduction, ci]
modules: [scripts/, prompts/scheduled/, src/usecases/scheduler/, .pi/skills/adversarial-review/, .github/workflows/]
intent:
  problem: "定时任务 prompt 模板纯加法增长无任何拦截（lint/CI/review 三层无体积维度），超 DB CHECK 后同步静默失败，git 真相源与运行时副本脱钩无人察觉"
  expected_effect: "任何使 prompts/scheduled/*.md 超 10000B（或 frontmatter budget_bytes 声明值）的 PR 在 CI 被拦截；对账同步失败以 error 级日志显式暴露；检视獭对触及模板的 diff 主动查体积增量"
  verify_by:
    type: behavior_check
---

# 定时任务 prompt 体积预算闸（issue #1030 根治）

## 背景：事故时间线

- 8/25：daily-health-check.md 4479B（RHI Phase 2 时点）
- 9/16-9/17：两天 6 个 PR（#983/#1009/#1021/#1024/#1026/#1027）各加一节规则 → 20607B
- 9/17：搭档发现 issue #1030——同步脚本 SqliteError: CHECK constraint failed，
  启动对账单项降级 warn 跳过，DB 仍跑 7782B 三周前旧版
- 搭档定性：重大事故。「这个长内容就是一个严重 bug」「你还想着去放宽约束？」——
  放宽 CHECK 被明确否决，本方案不含任何约束放宽

## 根因（大獭分析 × Kimi 异体对抗审视收敛）

| 层 | 结论 | 锚点 |
|---|---|---|
| 直接根因 | 18 次 PR 纯加法 +185/-24，无预算约束；DB CHECK 是唯一防线但末端且哑 | git log --numstat 实测 |
| 机制根因 | 修 bug 默认落点「往 prompt 加一段」（阻力最小，加规则=claim 修复完成） | 6 PR 各自加节的提交史 |
| 架构根因 | 教训三重固化（SYSTEM.md/skill/prompt 各自堆积），prompt 模板无增长纪律监管 | Kimi 报告 ①（数据已修正：重复度实测低于大獭初判） |
| 漏因 1 | review checklist 无体积维度——6 PR 全经过完整对抗审视但无人拦，是维度缺失不是失职 | Kimi 报告（grep adversarial-review 无体积检查项） |
| 漏因 2 | lint/CI 层零护栏 | grep scripts/lint-*.mjs 无体积检查 |
| 漏因 3 | 写入者不知道总体积（无反馈回路） | — |
| 放大器 | restartBeforeInvoke=true 每日全新 session，1 万字注入零上下文大脑 | ensure-daily-review-scheduler.ts:162 |

## 方案：四层防线

### 层A 写入闸（防增量）

`scripts/lint-prompt-size.mjs`：
- prompts/scheduled/*.md 剥 frontmatter 后 body > 8000B 警告、> 10000B exit 1
- per-file override：frontmatter `budget_bytes: <n>` 显式声明更高预算（须特性文档记理由）
- 体积口径：UTF-8 字节（严于 sqlite length() 的字符口径——中文 1 字符 3 字节，
  字节闸收紧不会漏放任何超 DB 约束的文件，护栏取严侧）
- CI 接入：ci.yml fast lint gates 段 + package.json `lint:prompt-size` script

daily-health-check.md 挂 `budget_bytes: 9200`（低于全局 10000 留缓冲）。

### 层B 存量出清（20563B → 9236B，-55%）

出清三原则（源自 Kimi 逐节执行力评估：有效内容约 60%，1 万字里混了操作指令与
reviewer 论证材料）：
1. 与 SYSTEM.md 重复的通用规则 → 删正文留指针（「分析纪律」节 1104B → 298B）
2. 已被机制/lint 接管的规则叙述 → 压缩成要点+指针（止损线 1753B→588B、issue 规范 1603B→581B——详规收进 lint 脚本头注，机器执行侧为真相源）
3. 论证材料（教训现场叙述、业界依据引用）→ 剥离到本文档「出清明细」节

**出清明细**（被移出内容的唯一归宿，指针完整性的锚点）：

- **healing 信噪比 SQL 全文与 stale 排除口径**（#999 出厂内容）：
  ```sql
  SELECT status, COUNT(*) FROM healing_events WHERE resolved_at >= '<昨日 00:00>' GROUP BY status
  -- 人工 dismiss 判定（排除 stale 污染）：
  SELECT date(resolved_at), COUNT(*) FROM healing_events WHERE status='dismissed'
    AND julianday(resolved_at)-julianday(created_at) < 30
    AND resolved_at >= date('now','-14 days') GROUP BY date(resolved_at)
  ```
  口径要点：autoStaleDismiss 只清理 open 超 30 天事件（时间差必然 ≥30 天），人工
  dismiss 时间差任意——故时间差 <30 天的 dismissed 行 = 人工 dismiss（误报信号）；
  **不能按 resolution IS NULL 判定**——updateStatus 路径的人工 dismiss 不写
  resolution，生产库实证 5 条人工 dismissed 全 NULL，按 NULL 判会指标死亡。
- **异体核对依据**（#1000）：Red Queen GM 实测，同源评审器对 AI 产出接受率是人类的
  1.91 倍——同模型抽查者可能看不出那类编造（详证 F20260917htam）
- **止损线检查全节细则**（v6.3）：三条件判定、样本单位=PR 数、复审静默规则、
  复审判据（场景覆盖 vs 窗口 PR diff 相关性 / post_merge_fix_density 趋势旁证）、
  处置路径（golden 目录删除→capability test 承接→results.jsonl 归档→#579 关闭）
  ——详规 F20260902gact
- **#791 数据核查现场**：healing_events 查成 0 条实为废弃库 otter.db（结构完整
  schema 齐全但全表空），实际在用库有 245 条——错库假象会把核查滑向错误结论
- **#778 范围教训现场**：Echo agent 项目的 UX 反馈曾被误报为 daily-review issue
- **#352 能力边界声明教训**：声称「只能查当前对话」是错误的能力边界声明
- **#424 处置现场**：批量 resolve 漏 1 起，靠下一任务补上（覆盖核实步骤的由来）

### 层C review 维度补盲

- adversarial-review SKILL.md 基础维度表加 **B8 Prompt 体积预算**：diff 触及
  prompts/scheduled/*.md 且净增 >500B → 作者须申报等量出清或净增理由，未申报 =
  严重发现（修漏因 1：6 PR 连续合入无人拦截的直接原因）
- review-dimensions.md 加第 8 节详规
- 「B1-B7」引用同步改「B1-B8」

### 层D 对账降噪改响（修「防线哑」）

prompt-template-reconciler.ts：
- PromptReconcileResult 加 `failed: string[]` 字段
- 单任务写入失败仍降级跳过（不阻塞启动，#814 模式），但明细累计进 failed
- 汇总以 **error 级**打日志：「N 个任务 body 同步失败，DB 将跑旧版 prompt（需人工
  处置）」——git 真相源与 DB 副本脱钩必须可见
- 不落 healing event（Kimi 否决采纳：流程失败 ≠ 运行时异常，混入违反 #998 二维
  分账原则，制造信噪污染；CI 拦截 + error 日志已覆盖可观测性）

## 设计取舍

| 取舍 | 决策 | 替代方案 | 理由 |
|---|---|---|---|
| 防线位置 | CI lint（合入前拦截） | 只依赖 DB CHECK（写入时） | #1030 实证末端+哑防线无效；前移到 PR 阶段作者可感知 |
| 体积口径 | UTF-8 字节 | sqlite length() 字符口径 | 与 DB 约束同数字，字节≥字符恒成立，严侧不会漏放 |
| 超标处置 | 出清 + per-file override | 放宽 CHECK 到 12K | 搭档明确否决放宽；override 强制特性文档记理由，留审计轨迹 |
| 出清去向 | 本文档「出清明细」节 | 附录文件按需 read | 定时任务场景执行獭按需 read 无 skill 场景实证（Kimi 层1保留），指针进 git 可检索文档更可靠 |
| 指针可靠性 | 出清明细进特性文档 | 指 F 文档原文 | 实测 F20260917osnr 文档不含 SQL 细节（内容只存在于旧 prompt）——空指针已抓到并修正 |
| 对账失败暴露 | error 日志 + failed 字段 | healing event | #998 二维分账：流程失败不混运行时异常信道 |
| 循环引用 | lint 脚本为规范真相源 | prompt 节为源 | 机器执行侧单源；prompt 只留要点（F20260909sentr 模式） |

**机制识别检查点**（issue 驱动未经 RA）：净新增机制 = lint-prompt-size.mjs 一项
（frontmatter 新字段 budget_bytes 属其配置面）。机制预算四问：
① 谁需要它：所有往 prompts/scheduled/ 加规则的 PR 作者与检视者（CI 拦截的感知方）；
② 失败后果：闸门误拦（override 通道兜底）/闸门漏拦（字节口径严于 DB 约束，漏拦
窗口为空）；③ 后续机制：budget_bytes override 滥用 → B8 检视核对特性文档理由，
无理由可打回；④ 退役条件：若未来 body 改存模板路径指针（结构性方案），体积闸
随之退役。

## 验证

- [x] lint-prompt-size.mjs：超预算 exit 1 / 警告线提示 / frontmatter 剥离 / override
  生效 / 目录不可读 exit 2（tests/scripts/lint-prompt-size.test.ts 5 用例）
- [x] reconciler failed 字段 + error 级日志（prompt-template-reconciler.test.ts 16
  用例，含 #1030 两新增）
- [x] 出清后模板过闸：9163B（+宁降一级回补后仍在 9200B 内，lint 实测 PASS）
- [x] 指针完整性：出清明细内容与被删段落逐段核对（SQL/口径/依据无丢失）
- [x] 最简实现检查：lint 脚本 95 行无依赖，复用项目既有「exit code 约定
  （0/1/2）+ CI fast gates 接入 + tests/scripts 子进程测试」三惯例，无新框架
- [x] Golden Gate：a1 场景（verify-data-source-before-query）实测 fail，但 git stash -u 干净基线复跑同样 fail（该场景 9/7 后在 golden-results.jsonl 无 passed 记录）——pre-existing 声明附基线复跑证据（PR #1036 评论），独立排查待 golden 场景维护方跟进

## Discovered Issues

- 无新发现 issue（出清过程中的衍生问题均已在本 PR 内处理：lint-issue-labels 头注
  循环引用、F20260917osnr 空指针改指本文档）

## 后续动作

- PR 合入后：跑 `node scripts/update-scheduled-task-body.mjs --name "每日对话健康检查"`
  回写 DB（issue #1030 验证断言：DB body 与 git 模板一致）
- 观察一周：9/24 日报核对两件事——①「信噪比统计段」在新 prompt 下仍正常产出；
  ②指针消费的行为保真：分析纪律（SYSTEM.md A1 指针式）与 issue 规范（lint 头注指针式）
  是否被执行獭真实遵循（#1036 检视建议 4：指针式瘦身的执行力风险需落地核验，
  若 9/24 日报出现「跳过双源验证」或「标签不合规范」行为回退，指针形态需复审）
