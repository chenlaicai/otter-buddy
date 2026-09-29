---
id: F20260929dbmb
title: 时间炸弹测试存量清扫与收窄版扫描器重生
date: 2026-09-29
change_type: fix
capability_test: "n/a: 测试写法修正 + 静态扫描工具链（verify_by=static_only：扫描器自身 12 用例 + 受影响测试 44 用例全绿 + lint exit 0）"
created_in_conversation: d7377cfd-8497-4338-9fb5-366967ffe87e
summary: 修 #1173 全仓时间炸弹存量清扫（4 处真炸弹改相对日期，E2 扫描器自证发现 2 处漏网）+ B1 收窄版扫描器重生（E1 校验函数 + E2 窗口 API error 级，W1 块共现 warning 基线守恒 12≤14）
tags: [test, date-validation, static-analysis, ci]
modules: [tests/api/rhi-api.test.ts, tests/usecases/health/health-snapshot-repository.test.ts, scripts/lint-date-bombs.mjs, scripts/lint-date-bombs.d.mts, tests/scripts/lint-date-bombs.test.ts, package.json, .githooks/pre-commit, .github/workflows/ci.yml]
closes: 1173
intent:
  problem: "#1173 扫描器退役次日 rhi-api 即被存量炸弹引爆（#1165 CI 红），证明规范-only 管不住存量与漏写；全仓 118 文件含 ISO 日期、28 文件与真实时钟共现，真炸弹藏其中需逐个判定"
  expected_effect: "存量真炸弹清零（改相对日期构造）；收窄版扫描器 v2 重生——只报高危组合不刷屏，E1/E2 error 阻断 + W1 基线守恒管增量；pre-commit + CI 双挂载"
  verify_by:
    type: static_only
causal_links:
  - rel: supersedes
    target: F20260918da41
    note: "退役决策被 9/25 #1165 CI 红反例推翻——退役时的清扫只做了 scheduler 一个文件，全仓存量未清；本 PR 按收窄策略重生"
  - rel: relates-to
    target: F20260915dabm
    note: "v1 扫描器（873 条 warning 噪音）的收窄改造版：主防线 E1 原样保留，辅助面从全量 ISO 改为 it 块共现 + 基线守恒"
---

# 时间炸弹测试存量清扫与收窄版扫描器重生

## 背景

### #1173 现象与历史脉络

- 9/23 #931 修复时退役了 lint-date-bombs 扫描器（F20260918da41），理由「正确性靠写法保证」——但退役清扫只做了 scheduler-service.test.ts 一个文件，全仓存量未清
- 9/25 退役次日，PR #1165 CI 被 `rhi-api.test.ts > trends` 存量炸弹引爆（硬编码 2026-08-26/27 滑出 30 天窗口）——「写法规范管新增，管不住存量」的实证
- issue #1173 立 P1：A 存量清扫（30 高危文件逐一判定）+ B 防线决策（B1 收窄扫描器重生 vs B2 维持规范-only）

### 全仓扫描与逐文件判定（A 部分）

粗扫（两轮）：118 个测试文件含 ISO 日期字面量，其中 28 个同时含真实时钟调用（`Date.now()`/无参 `new Date()`），±10 行近邻共现 8 文件、±40 行放宽 14 文件。逐文件人工判定结论：

| 判定 | 形态 | 文件 |
|---|---|---|
| 真炸弹（修复） | 窗口语义 API + 硬编码日期滑出窗口 | rhi-api ×3、health-snapshot-repo ×1 |
| 安全-冻结时钟 | CLOCK_SNAPSHOT 显式快照（#605 正确设计） | rhi-scan-worker |
| 安全-显式注入 | `vi.setSystemTime` / `scanOnce(NOW)` / mock now 参数 | scheduler-service、rhi-signal-aging-worker、validate-commit-date |
| 安全-mock 内部相对 | mock 数据间相对比较，不涉真实时钟 | pending-restart、dispatch-turn-loop、guard-bounce、dispatch-chain-engine |
| 安全-错误字符串 | 429 消息里的日期仅作正则匹配对象 | circuit-retry、first-dumb-detection |
| 安全-纯 fixture | 日期只是数据，不参与计算 | healing-batch、manage-conversation、restart-flow 等 |

真炸弹明细（4 处）：

1. **rhi-api.test.ts L276**：`d1="2026-08-28"/d2="2026-08-29"`，costOutput 90 天窗 series 用例——引爆日 2026-11-25
2. **rhi-api.test.ts L434**：`d1="2026-09-12"/d2="2026-09-13"`，默认 30 天窗 invokeStats 用例——**引爆日 2026-10-12（清扫时仅剩 13 天）**
3. **rhi-api.test.ts L89**：overview 用例硬编码 2026-08-25 + 断言锁 `snapshotDate === "2026-08-25"`（findLatestByMetricKey 按 snapshot_date DESC 取最新，语义随滑出退化）
4. **health-snapshot-repository.test.ts L14**：describe 级共享 `day="2026-08-25"`，其中 deleteOlderThan 用例断言「day 不被删」——被测端 `new Date()` 算 90 天 cutoff，day 滑出后断言翻转，引爆日 2026-11-23

其中 3、4 两处是 **E2 扫描器跑通后自证发现**（人工判定轮漏掉）——扫描器价值的首个闭环证据。

## 方案设计

### A. 存量清扫（narrow-fix：改相对日期构造）

4 处真炸弹统一改 `new Date(Date.now() - N*86400000).toISOString().slice(0, 10)`（对齐 #1165 trends 修复写法），断言用同一变量。附带判定语义保留：

- rhi-api invokeStats 用例的「取最新日不被旧值污染」语义由 d1(旧) < d2(新) 相对关系保留
- snapshot-repo 跨日用例的 fixture 排序锚点（"2026-08-24" vs day）加 `// date-literal: fixture-relative` 豁免注释（纯 fixture 内部比较，不涉真实时钟）

### B. 收窄版扫描器 v2 重生（B1 方案）

三层检测，只扫 `tests/` 下 `*.test.ts|spec.ts`：

| 层级 | 检测 | 严重度 | 依据 |
|---|---|---|---|
| E1 | 日期校验函数（validateCommitDate/CLI 形态）+ 硬编码 FID + 无 now 注入 | error | v1 主防线原样保留（#541/#544 形态，精度实证） |
| E2 | 窗口写入 API（replaceForDate）收到 ISO 字面量或字面量绑定变量 | error | **v2 新增**：#1165 + #1173 四处真炸弹的共同形态 |
| W1 | it 块内非注释 ISO 字面量与真实时钟调用共现 | warning（基线守恒） | 炸弹必然共现、共现不必然炸弹——按块收窄后误报面从 873 → 12 条 |

关键设计决策：

- **W1 基线守恒（只减不增）**：`W1_BASELINE = 14` 固化在脚本里（当前实测 12），CI 无状态所以基线必须自持。增量零容忍，存量随触碰自然消化，消除了的块手动下调基线
- **E2 窗口 API 白名单**：`WINDOW_APIS = ['replaceForDate']`——宁可窄不可宽，新炸弹形态实证后扩展（避免 v1 的「先全量后收窄」覆辙）
- **豁免注释双语义**：`// date-literal: explicit-now`（v1 语义，E1 场景）+ `// date-literal: fixture-relative`（v2 新增，E2/W1 的 fixture 内部相对场景），行内或上一行均可
- **it 块切片**：遇 `it(`/`test(` 开新块，以缩进 ≤ it 行的 `});` 结束——简化策略，误切只放大窗口不漏检

挂载：package.json `lint:date-bombs` script + `.githooks/pre-commit`（npm run lint:date-bombs）+ CI fast lint gates 步骤。

## 验证

- 扫描器自身单测 12/12 通过（E1 正反 ×4、E2 正反 ×4、W1 正反 ×3、基线自检 ×1）
- 受影响测试：rhi-api + health-snapshot-repository 共 44/44 通过
- 全仓扫描 exit 0：errors=0、warnings=12 ≤ 基线 14
- `node scripts/lint-date-bombs.mjs --verbose` 输出的 12 条 W1 逐条人工判定为安全形态（scheduler 冻结时钟 5、pending-restart mock 内部相对 3、dispatch-turn-loop mock 回显 3、cron-parser fake timer 1——注：cron-parser 的 vi.setSystemTime 行本身是安全形态，共现由同块其他行触发，判定为可豁免候选）

## 影响范围

- 全仓测试时间语义防线从「规范-only」恢复为「规范 + 静态扫描」双层
- 新增炸弹形态（窗口 API 族）会被 E2 在 CI 拦截
- 12 条 W1 存量 warning 不阻断，随文件触碰逐步消除后下调基线

## 机制识别检查点（Modification-Class: mechanism-addition 依据）

按 commit-convention 四问自答（#1206 检视 S1 处置补全）：

1. **谁需要知道这是机制**：后续给测试窗口类 API（replaceForDate 族）新增断言用例的作者——E2 白名单扩展窗口在此；负责 CI 稳定性的维护者——W1 基线棘轮只减不增，新增共现块会顶红 CI。
2. **没识别出的失败后果**：新窗口 API 写入面逃逸 E2 白名单 → #1165 同型炸弹落地不被拦；W1 基线被无脑上调 → 棘轮失效回退到 v1 噪音态。
3. **后续机制**：新窗口 API 实证炸弹形态后扩展 `WINDOW_APIS`（宁可窄不可宽）；共现块消除（改相对构造或豁免注释）后手动下调 `W1_BASELINE`。
4. **退役条件**：若未来测试基础设施统一走显式时钟注入（如全局 fake timer 强制），静态扫描的检测面归零，可再退役——但需有比「噪音」更强的理由（v1 退役教训：存量未清就退役，次日即引爆）。

## 与退役决策的关系（决策修正记录）

F20260918da41 的退役理由（949 条 warning 噪音 + 维护成本倒挂）在本 PR 被部分推翻：**问题不在「要不要静态防线」而在「扫描面不收窄」**。v2 用「只报高危组合 + 基线守恒」回应了原退役理由的两个痛点——噪音（873→12）与误报（error 级只锁两种实证形态）。issue #1173 搭档倾向 B1，本 PR 落地 B1。
