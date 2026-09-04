---
id: F20260904rclp
title: RHI 信号闭环最后一公里：日报 prompt 处置硬规则 + 同步脚本测试补齐
summary: |
  #406 改造 + #430 测试补齐，打包交付。#406：每日健康检查 prompt 新增「RHI 信号处置段」——
  critical 信号逐条三选一处置（开 issue/并入既有/明确不处置附理由），M+K+L=N 闭环自检，
  把「看见信号」升级为「处置信号」，补上 RHI 管道（采集→指标→信号→日报已通）缺失的
  最后一段（信号→改进动作）。#430：update-scheduled-task-body.mjs（prompt git 化落库脚本）
  补 13 个测试（dynamic 防护判定/direct path 去 frontmatter/跳过不落库/逐字节一致），
  脚本最小改造支持函数导出与 --tpl-dir 注入。改造后立即对账落库，明晨 9:00 日报生效。
change_type: prompt
capability_test: "n/a: prompt 文本变更由每日健康检查任务消费（明晨 9:00 首跑验证），脚本侧行为由 tests/scripts/update-scheduled-task-body.test.ts 13 用例锁定"
intent:
  problem: "RHI 信号被日报看见但无人处置（behavior_defect 4 条 warning 挂起、无信号触发的 issue），闭环断在最后一公里；落库脚本 #428 改动无测试保护"
  expected_effect: "每日健康检查产出含「critical N → 开 issue M / 并入 K / 不处置 L」处置段且 M+K+L=N 守恒；脚本四类行为（dynamic 防护/direct path 去 frontmatter/跳过不落库/逐字节一致）由 13 用例锁定"
  verify_by:
    type: capability_test
    effect_window: 1d
created: 2026-09-04
created_in_conversation: e9b71eec-679e-4380-947d-8e641c4b90d5
tags: [rhi, signal-closed-loop, daily-review, prompt-infra, test-coverage]
modules: [prompts/scheduled/daily-health-check.md, scripts/update-scheduled-task-body.mjs]
issue: [406, 430]
---

## 背景

两条线索在 2026-09-04 的 issue 清仓（55 条从古到今逐批处理）中交汇：

1. **#406（RHI 信号→改进闭环，8/24 立）**：搭档追问「咋没人消费」促使数据核查——RHI 管道本身活着（signals 表 220 条持续产出、9:00 日报 prompt 已接入信号源），但断在最后一段：信号被「看见」（日报引用）却没有「被处置」（behavior_defect 4 条 warning 无处置、全仓无一条 daily-review issue 由 RHI 信号触发）。原 issue 的完整方案（信号-动作映射表 + 效果回验）是重工程，搭档拍板走最小可行改造：日报 prompt 加处置硬规则，跑起来再看要不要建映射表。
2. **#430（同步脚本测试，8/25 立）**：update-scheduled-task-body.mjs 在 #428（F20260825sphg）改了两处重要逻辑（dynamic 模板防护、direct path 去 frontmatter）但零测试。#406 改造恰好依赖此脚本落库——测试先行再改 prompt，顺序反了就是裸奔。搭档拍板两 issue 打包一个 PR。

## 改动

### 1. #406：日报 prompt 处置硬规则（prompts/scheduled/daily-health-check.md）

在数据源段之后新增「RHI 信号处置段（#406 闭环硬规则）」：

- critical 信号逐条列出（信号 ID/类型/严重度/指向），**逐条三选一处置，不许留空**：开 issue（body 含信号 ID+数据锚点）/ 并入既有 issue（注明编号+优先级判断）/ 明确不处置（附判断理由——「不处置」必须是结论不能是沉默）
- warning 信号扫视：同类型 ≥5 条指向同一模块按 critical 处理；零散 warning 汇总一行
- **闭环自检（M+K+L=N）**：日报结尾确认处置数守恒，数字对不上 = 有信号被沉默跳过，补查
- 硬门禁清单同步加第 8 项（RHI 信号处置）

设计取舍：不建信号-动作映射表（原 #406 方案的完整工程）——先用 prompt 硬规则验证「处置」这个动作本身能不能日日发生，两周有数据后再决定映射表是否值得建。

### 2. #430：脚本测试补齐（tests/scripts/update-scheduled-task-body.test.ts，13 用例）

| 组 | 用例 | 锁定的行为 |
|---|---|---|
| isDynamicTemplate（7） | 裸 true / false / 无字段 / 带引号 "true" / 行尾注释 / 无 frontmatter / 其他字段含 dynamic 字样不误判 | dynamic 防护判定（#416 语义） |
| loadTemplate（4） | direct path 去 frontmatter（#428 bug 回归锁）/ 无 frontmatter 全文 / 扫描分支匹配 / 无匹配返回 null | 模板解析三分支 |
| 集成（2） | 静态模板落库逐字节一致 + 幂等 / dynamic 跳过 exit 0 且 DB 占位符不被覆盖 | 子进程级端到端 |

**顺手修复（测试暴露的真 bug）**：isDynamicTemplate 原正则 `/^dynamic:\s*true\s*$/m` 不匹配 `dynamic: "true"`（带引号）和行尾注释形态——#430 issue 列举的用例此前实际不通过。改为 `/^dynamic:\s*['"]?true['"]?\s*(?:#.*)?$/m`。语义偏保守（宁可多跳过不误写库），安全侧正确。

### 3. 脚本最小改造（scripts/update-scheduled-task-body.mjs）

- `isDynamicTemplate` / `loadTemplate` 加 export（函数级测试用）；`loadTemplate` 的 dir 参数化
- `main()` 加直接执行守卫（import.meta.url vs pathToFileURL(argv[1])）——import 时不跑 main
- `--tpl-dir` 参数：测试注入临时模板目录，生产默认仍为仓内 prompts/scheduled（不变）
- 改动原则：只加测试性接口，零行为变更（生产路径默认值全部原样）

## 验证

1. 脚本测试 13/13 绿（npx vitest run tests/scripts/update-scheduled-task-body.test.ts）
2. 真实对账落库成功：`node scripts/update-scheduled-task-body.mjs --name "每日对话健康检查" --db <主仓 DB>` → body 已更新 ← worktree 模板；DB 内「RHI 信号处置段」存在（grep 命中）——明晨 9:00 首跑即用新版
3. tsc --noEmit 0 error（脚本为 .mjs 无类型影响；测试文件过 tsc）
4. **最简实现检查**：已过——prompt 段是纯文本追加；脚本仅 export + 参数化 + 守卫三处测试性接口，无新依赖（execFileSync/tempdir 全 stdlib）
5. 全量回归：见 PR CI（scripts 域测试 + prompt 无代码耦合面）

## 生效路径与观察点

- 明晨 9:00「每日对话健康检查」用新版 prompt（DB 已落库）
- **首周观察**：日报是否真产出「critical N → 开 issue M / 并入 K / 不处置 L」段；M+K+L=N 自检是否被遵守
- 两周后决策点：处置动作稳定发生 → 考虑 #406 原方案的映射表/效果回验要不要立项；仍空转 → prompt 硬规则也不够，需要上机制（如信号处置专用任务）

## 关联

- Issue: [#406](https://github.com/chenlaicai/otter-buddy/issues/406)（Fixes）、[#430](https://github.com/chenlaicai/otter-buddy/issues/430)（Fixes）
- 上游：F20260825rweb（RHI Phase 2，信号接入日报）、F20260825sphg（#428，脚本 git 化——本次补测试的对象）
- 兄弟：#405（已关闭，行为层指标留召回口）、#407（已关闭，元监控留召回口）——本 PR 是 RHI Phase 3 三子里唯一走「先跑通闭环」路径的
- 配套：#784（prompt 启动对账）——本次手动对账落库是该机制的又一次实践
