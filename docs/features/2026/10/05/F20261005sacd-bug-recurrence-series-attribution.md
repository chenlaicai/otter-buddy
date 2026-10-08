---
id: F20261005sacd
title: bug_recurrence 系列归因分级 + 载体排除补全（#1012 修法 c）
summary: severity 分级（同系列 critical / 跨特性分散 warning）+ migration/schema 入载体排除 + lint 本期分母修复 + 日检 golden 对账——告警从一刀切 critical 恢复区分度
change_type: fix
capability_test: "n/a: 确定性检测逻辑（无 LLM 行为面），7 新增用例含系列归因三形态 + 载体排除边界 + 39 既有回归全过"
intent:
  problem: "bug_recurrence 信号 43% 是口径盲区（测试/bootstrap/schema 载体混入 critical），30% 真腐烂（bash 守卫 12 连败/恢复机制三次推翻/压缩链路 5 连「根治」）与 26% 热点活跃假象同报 critical，告警失去区分度——搭档无法从 23 条 critical 里看出哪 7 条是真烂（归因报告：工作区 issue-1012-归因分析.md）。#1259 口径修订 10/1 合入但服务未重启从未生效，23 条按旧口径刷数。"
  expected_effect: "新触发信号：跨 issue 分散形态降 warning；migration/schema 载体不触发；同 issue 主体严格过半报 critical（#1160 五连形态）。**能力边界（delta r1 D1 裁决 b）**：集群爆发形态（每次修复开新 issue 号，如 bash 守卫 21 修 28 个号全计数 1）机械判据判 warning——该形态靠专项 issue 兜底（守卫宪法 #1260 在途），不试图用 token 相似度等启发式覆盖。存量 23 条处置：dismiss 10 盲区 + 4 专项 issue 立项。"
  verify_by:
    type: capability_test
created_in_conversation: 3241317b-99d6-4d78-9248-ff208a7461bc
tags: [health, signal, bug-recurrence, 系列归因, 载体排除]
modules: [src/usecases/health, scripts, prompts/scheduled]
---

# bug_recurrence 系列归因分级 + 载体排除补全（#1012 修法 c）

## 背景

#1012 根因分析（归因分析獭-1012，2026-10-05，23 条 open critical 全量逐条过）：

- **真腐烂 7 条（30%）**：bash-safety-guard 窗口内 12 修（误拦↔绕过对抗失控）、web index.tsx 10 修（右栏状态一周「根治」3 次）、恢复机制三件套（#812→#817→#994→#1015 三次推翻）、压缩-交接链路 5 连修（每次宣告「根治」）
- **热点活跃 6 条（26%）**：orchestrator/scheduler-service 等修的全是不同 bug，「复发」是高迭代密度假象
- **口径盲区 10 条（43%）**：测试 5 + bootstrap 1（#1259 已排待生效）+ migration/schema 4 条新发现漏排
- **前置实锤**：#1259 口径修订从未生效——服务 dist 构建于 9/30 09:44 早于 #1259 合入（10/1 22:27），isNonLogicCarrier 在 dist 中出现 0 次。不重启服务，dismiss 后旧口径会重新刷出来

## 修法决策（归因报告三选项评估）

- **a 动态阈值**：治量不治准——2% 线会把 3 次的真腐烂（恢复机制）误杀，且阈值随活跃度漂移。降为 warning 档兜底
- **b LOC 归一化**：方向反，否决——真腐烂集中在大文件（guard/index.tsx），归一化 = 系统性漏报
- **c 系列归因分级（采）**：detect-signals.ts:174 注释本就预留此方向。commit message 的 issue 引用集合（#1160 出现在 5 个 commit 是现成根因关联，零 NLP）聚修复系列，分级而非过滤

## 设计取舍（机制预算四问，动手前判定）

命中机制识别检查点（改既有检测器触发语义 = 修法①②混合，不新增机制）：

1. **这机制解决什么问题**：critical 一刀切让 43% 载体噪声 + 26% 热点假象混进主警报区，告警失去区分度
2. **最少代码实现**：不新建归因引擎——复用已解析的 `parsed.featureId`（零新增解析逻辑），改动集中在 `detect-signals.ts` 一个文件 + 载体正则一处 + 判据函数一个
3. **后续机制**：无。分级数据（特性链清单）进 evidence 文案，日检对账消费
4. **退役条件**：归因复核 23 条样本（本 PR 完成后由归因獭复核）若分级准确率 <80% 则回退本判据

## 变更内容

### 1. 系列归因分级（detect-signals.ts）

- `BugfixFileEntry` 新增 `featureIds: Set<string>`——窗口内 bugfix commit 的 featureId 集（系列归因数据源）
- `classifyRecurrenceSeverity` 新判据：
  - `featureIds.size >= 2`（跨特性分散明证）→ **warning**（热点活跃假象）
  - `featureIds.size < 2` 且事件数达阈 → **critical**（同系列或无锚点默认）
  - 未达阈 → 不出信号
- **设计纠错（测试抓到的）**：初版用 `max(featureIds.size, prs.size)` 当系列判据——squash 流下 PR 号恒唯一，分散修复的 prs.size 也达阈，max 把 warning 分支吞掉。改为 featureIds ≥ 2 是分散明证的直接判据
- evidence 文案追加特性链清单（`特性链 F20260920aaaa, F20260920bbbb（2 链）`）——severity 判据可见可复核

### 2. 载体排除补全（isNonLogicCarrier）

- `migration.ts` / `schema.ts` 入非逻辑载体——schema 演进 N 修 = N 个独立演进，被动累加非同一根因反复（归因报告口径盲区 10 条中 4 条是它们）
- 正则限定 `src/frameworks/db/` 前缀或仓库根，不误伤同名业务文件

### 3. lint 本期分母修复（lint-intent.mjs，#1067 顺手项）

- `git diff --name-only origin/main` 加 `--diff-filter=AR`——只取新增/改名，纯删除/纯内容修改不算本期分母
- 修复前：main 上跑会把全量历史删除/修改文档算进本期分母（「本期判定 1/246 = 0%」假象）；修复后 main 上本期判定 0/0

### 4. 日检 golden 对账（daily-health-check.md，#1067 软曝光方向）

- 止损线检查节新增「golden 执行对账」：每日对账近 24h 合入软代码 PR × golden-results.jsonl 记录，缺记录/fail 悬置/pending 超 72h → 开 issue
- **不阻断合入，只对账曝光**（搭档决策：bash 守卫硬拦事故教训在前——硬闸门拦人一两天是实证，软曝光+对账驱动）

## 不在本 PR 范围

- **存量 23 条处置**（dismiss 10 条 + 4 专项 issue）：需搭档重启服务让 #1259 生效后执行，否则 dismiss 后旧口径重新刷出
- **分键 file_path 唯一化**：归因报告建议但存量 23 条中无 module 裂分实例，收益存疑，留后续复核
- **#1067 硬闸门化**：搭档否决（「硬闸会担心过分死板限制，bash 问题是实锤」）

## 验证

- 新增 7 用例全过（系列归因三形态 + 载体排除边界 + 混合场景）
- 既有 39 回归全过（含 #1214 去重/载体排除/weixin 回归锚/delta D1 barrel 边界）
- 全量 315 文件 4523 测试全绿
- lint:intent 0 error；lint 本期分母修复实测 0/0（main 上不再虚报）
- **最简实现检查**：已过——复用 parsed.featureId 零新增解析、不建归因引擎、改动集中单文件

## 自检

- 负面向验收：本次变更**放宽**了 bug_recurrence 触发面（部分原 critical 降 warning）——风险是真腐烂被降档漏报。缓释：同系列形态（featureIds ≤ 1）仍 critical；warning 信号仍出可观察；归因复核验证断言兜底
- 废弃资源：无（纯检测逻辑改动，无旧路径/配置迁移）

## Delta r1 处置记录（D1/D2/D3，2026-10-08 大獭接手）

- **D1（判据真实有效性）裁决：b 路线**。独立复核实测坐实检视数据：bash-safety-guard.ts 30 天窗 21 修、28 个 issue/PR 号全部计数 1——集群爆发形态在 issue 引用判据下全降 warning。a 路线（token 相似度辅判）引入调参成本与误报面，弃。处置：①expected_effect 如实声明能力边界（见 frontmatter）；②新增「存量信号回放」测试组——用生产真实 message 固化两类形态的判定行为（集群爆发→warning / #1160 五连→critical / 混合主体过半→critical），堵死「测试构造形态 ≠ 生产形态」偏差（检视连续两轮点名的模式）。
- **D2（intent 未同步换锚）**：expected_effect 原文「同特性链反复修仍报 critical」是 r0 FID 判据表述，已随 D1 一并改写为 issue 引用判据 + 能力边界声明。
- **D3（rebase）**：已 rebase 到 main 614a6a61（含 #1317），daily-health-check.md 冲突按仲裁解决——#1317 精简版为基底 + 保留 golden 对账段 + 恢复限定语（非 RHI DB / 时间差<30天 / regression-verify 跳过），体积出清至预算内（增量纪律）。
- **建议 5（golden 豁免措辞）**：PR body 同步修订（见 PR 描述）。
