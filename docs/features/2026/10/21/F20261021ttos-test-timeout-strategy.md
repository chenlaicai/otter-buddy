---
id: F20261021ttos
title: testTimeout 策略统一：重成本用例显式宽窗判据 + 四种宽窗形态收编
summary: 全仓测试宽窗写法四种并存收敛为两种（文件级 vi.setConfig / 用例级对象形），判据成文（结构性重活或常态 >2s 即显式宽窗），数值按余量原则 20s 起步，同根因吸收 #1366 flaky 四件套。
change_type: fix
capability_test: "n/a: 纯 A 类测试配置策略改动，无 LLM 参与行为"
intent:
  problem: "vitest 默认 5s testTimeout 顶不住重成本用例（全量并发下 P99 翻倍即顶线，flaky 四件套实证）；且全仓宽窗写法四种并存（文件级 setConfig / jest 三参形 / 对象形 / 移出计时窗），无统一判据，新增重成本用例无据可依"
  expected_effect: "重成本用例（结构性重活或常态 >2s）全部显式宽窗，全量并发下四件套零复现；宽窗形态收敛为两种，新增写法有判据可依；全局默认 5s 不动，快用例仍快死、真挂不被掩盖"
  verify_by:
    type: behavior_check
created_in_conversation: a9260c50-cef6-412e-a0b4-282287a13103
created_at: 2026-10-21
from:
  - F20261019fito
tags: [tests, flaky, testTimeout, tech-debt]
modules: [tests, .pi/skills/code-implementation/references/testing-rules.md]
---

# testTimeout 策略统一（#1555，吸收 #1366）

## 背景与排查结论

vitest 默认 testTimeout=5s，重成本用例在全量并发负载下 P99 翻倍即顶线（#1366 实证：四件套单跑 1-3s、全量下间歇性 `Test timed out in 5000ms`，检视獭独立复跑两轮复现）。同型已实证两例（guard-intercept-classify 首载、build-app 全栈装配），#1555 要求统一评估策略。

**排查实证（全量 6567 用例耗时采样，2026-10-21）**：

- 全仓宽窗写法**四种并存**：① `vi.setConfig({ testTimeout })` 文件级（ensure-hooks、halt-injection-wiring）② jest 三参形 `it(name, fn, timeout)`（game-harness-tools 5 处）③ `{ timeout }` 对象用例级（mahjong proxy 3 处）④ 移出计时窗（F20261019fito 修法）——「策略不统一」实锤
- 常态耗时分布：超 2s 用例 36 个、超 3s 18 个、超 5s 3 个（game-harness 6.02s、mahjong proxy 5.16s、attachment-api 5.01s 贴线）
- 贴线风险面（3-5s，负载下顶线风险）：ensure-hooks 族、cursor-zero-guard、build-app、halt-injection、cost-output-collector、lint-historical-docs-final 等

## 方案取舍（issue 三候选 → 定 b）

| 候选 | 判定 | 理由 |
|---|---|---|
| a) 全局 testTimeout 调宽 | 弃 | 拖慢真挂用例发现速度，一刀切 |
| b) 重成本用例显式宽窗 | **采纳** | 面小、声明式、可增量维护；判据成文后新增用例有据可依 |
| c) 逐例治本（首载移出/装配提速） | 弃（保留为个例手段） | 工程量大收益边际；F20261019fito 已示范该修法适用场景 |

**判据（重成本用例定义，已同步 testing-rules.md）**：用例满足其一即显式宽窗——① 结构性重活（临时 git 仓库、spawn 子进程、真 sqlite 全栈装配、Playwright 真浏览器、整场模拟、全仓扫描）；② 常态耗时 >2s（全量实测）。

**形态统一**：整文件结构性重活 → 文件级 `vi.setConfig({ testTimeout })`（新增用例自动继承）；文件内单点重用例 → 用例级对象形 `it(name, { timeout }, fn)`。三参形收编删除。

**数值余量原则**：默认 20_000（常态 3-4 倍余量）；浏览器/长模拟类常态 >5s 的重波动用例按常态 4-5 倍给（game-harness-tools 30_000——初版推「统一 20s」被实测打脸：`__loadState` 全量负载下 P99 冲 26.6s，降值反而制造新 flaky，恢复 30s 并把「统一值」改为「余量原则」）。全局默认 5s 不动：快用例快死，真挂发现快。

**同根因吸收 #1366**（flaky 四件套 = 本单子集）：build-app 健康端点（本 PR 单点宽窗）、lint-historical-docs-final（本 PR 文件级宽窗）、cost-output-collector（本 PR 单点宽窗）、guard-intercept-classify（F20261019fito 已修，不在本 PR 重复处理）。

## 机制判定（修法决策树）

机制识别检查点七项**全部未命中**（不新增配置字段/状态生命周期/定时任务/信号格式/持久化/被记住的决策分支/跨模块调用——仅在 vitest 既有 testTimeout 能力内统一用法）→ 走修法决策树①（既有语义内修），Modification-Class: **narrow-fix**。

## 改动清单（新设 13 处 + 形态收编 25 处，检视后终态）

**A. 新设宽窗（原本无窗，13 处）**：
- 文件级 `vi.setConfig({ testTimeout })` 6：lint-historical-docs-final / -cibase / -linkfix / -rename / lint-historical-docs（临时 git 仓库族，20_000）、web-mahjong/page-visual（Playwright，20_000）
- 用例级 `{ timeout: 20_000 }` 7：build-app > 健康端点（#1366+#1555 双实证 flaky）、attachment-api > R2 竞态回归（常态 5.01s 贴线）、cursor-zero-guard > ③ pushCursorOnStartup、cost-output-collector > collectFdocCounts（#1366 四件套）、search-memory > detail_level=snippet、api/mahjong > 三麻将局、room-report-chat > isSeated

**B. 形态收编（原有窗改形态，25 处）**：
- game-harness-tools：5 处三参（30000×3 / 15000×2）→ 文件级 30_000
- 用例级三参 → 对象形（数值保留）20：budget-guard 4（5_000-10_000）、unified-handoff 1（10_000）、guard-touchstone-exam 3（60_000，含放行池用例冲突归一——初版误叠加 20_000 对象形与存量 60_000 三参双窗，归一为 60_000）、scheduler-service 7（15_000-20_000）、web-mahjong 5（60_000-120_000）

**C. 检视修正回滚（1 处）**：server-addrinuse.test.ts——初版误把 `vi.waitFor` 轮询窗尾参（3_000）当 it 三参收编，破坏两处语义（轮询窗 3s→缺省 1s、it 窗 5s→3s 收紧），检视獭以基线实证逮住，整文件回滚基线（该文件本无可收编项）

**不动**：hook 尾数值参（beforeAll 等，vitest 无 options 形态）、tests/capability/ 三参（B 类独立域，公式化数值）、guard-intercept-classify（#1549 已修）

**规范同步**：`.pi/skills/code-implementation/references/testing-rules.md` 新增「重成本用例超时策略」判据段（判据不成文则下一个写测试的獭无据可依，当场自检义务）。

## 验收标准（断言化）

| 场景 | 操作 | 预期结果 |
|---|---|---|
| 窗生效（文件级） | `npx vitest run tests/lint-historical-docs-final.test.ts --testTimeout=1` | 5/5 passed（文件级 setConfig 覆盖 CLI 1ms） |
| 窗生效（用例级） | `npx vitest run tests/app/build-app.test.ts --testTimeout=1` | 带窗用例「健康端点」passed；非窗用例被 1ms 线杀（双向证明） |
| 回归 | 全量 ×3 连续跑 | 410 文件全过、四件套零超时复现 |
| 形态收敛 | python 块起点判定（排除 hook 尾/capability）：A 类 `it/test` 三参形残留 | 零命中 |

## 验证（Verification）

- **牙齿自证三连**（恒真断言防线）：`--testTimeout=1` 极限线下——build-app 非窗用例 14ms/3ms/2ms 被杀 ✓ + 带窗「健康端点」存活 ✓ + lint-historical-docs-final 5/5 全活 ✓，双向证明参数真被压上且显式窗真覆盖（优先级：用例级 > 文件级 > CLI/默认）
- **三轮全量**（2026-10-21 13:42-13:44，收编后终态）：410 文件 / 6561 passed | 6 skipped 全绿 ×3、timed out errors 0——四件套零复现。**诚实口径**：三连为 vitest transform 缓存热跑（~60s/轮），负载强度低于 #1366 现场（冷跑 5039 用例），零复现作回归验证（改动未破坏既有行为）而非 flaky 根治的充分证明；有效性主要由牙齿自证 + 余量数值承担
- **失败证据口径**：本次修复前全量 0 failed（间歇性 flaky 未复现，与 #1366「单跑均绿、整批复跑也绿」现场一致），不伪造「修复前必红」；失败证据引用 #1366 现场记录（PR #1361 期间三轮全量 2-4 个失败 + 检视獭两轮独立复现）
- **过程教训（三处，均被验收/检视逮住）**：① room-report-chat 单点插入截断签名致注释吞掉 `async () => {`，transform 炸 3 轮——批量 patch 必须匹配完整签名；② 数值「统一 20s」推过头降了 game 的 30s，`__loadState` 负载 P99 冲 26.6s 打脸——统一的是判据与形态，数值按余量原则不搞一刀切；③ server-addrinuse 的 `vi.waitFor` 轮询窗尾参被甄别脚本误判为 it 三参收编（收紧方向违反放宽声明）——检视獭基线实证逮住后回滚，甄别脚本「向上找 it(` 行」不校验尾参归属是坑
- **Golden Gate / 锚点重放**：已真跑记录（2026-10-21，`npx vitest run --config vitest.capability.config.ts tests/capability/golden/golden.capability.test.ts`）：**8/10 场景 passed、2 failed**（b5-yield-requires-delta-review 0/3、date-before-feature-id 1/3）——两项均 LLM 行为面，与本 PR 零因果路径（diff 不含 prompt 面，超时参数无法改变工具选择/yield 目标），无历史 green 基线可对照；完整逐场景记录与归因见 PR #1598 body「Golden Gate」节（gate 全程日志随 PR 留证）。初版曾写「n/a、无锚点重放对象」，经检视（delta-2 建议 4）改为本记录指针——skill 层 reference 改动按严格口径属软代码面，真跑记录比豁免声明更硬
- **最简检查**：已过——纯测试配置参数调整（vitest 既有能力），无新依赖/新文件/新机制；比「全局调宽」（1 行）多出的判据与清单是 issue 要求的「面小」代价，值得
- **pre-existing 声明**：无（三轮全量 0 failed，无既有失败）

## 影响范围

- 测试层新设 13 + 形态收编 25（+ 误收编回滚 1）+ testing-rules.md 1 段；产品代码零改动
- 全局默认 5s 不变，非清单用例行为零变化
- #1366 随本 PR 合入关闭（同根因聚合）；#1555 关闭
