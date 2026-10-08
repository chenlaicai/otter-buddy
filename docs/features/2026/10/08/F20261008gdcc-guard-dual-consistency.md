---
id: F20261008gdcc
title: bash 守卫 P1 治理——双链一致性测试（parseOk 强制双跑）+ guard_intercept replay 固化自动化
summary: guard-mechanism-review 建议项 3/4 落地：①同一命令强制 parseOk=true/false 双跑断言判定一致（vi.mock 切换零生产改动，cd 豁免族 + one-liner 豁免族 9 例，revert #1360 修复实测 3 例红）——S1 类割裂从生产现场前移到 CI；②scripts/generate-guard-replay.mjs 候选生成器（按日筛选/反查/去重/脱敏，期望值人工裁决不机械生成）+ daily-health-check 固化段，把「修复-回归循环」（#1207→#1304、#1170→#1360）的原料从人工翻台账变成每日自动供给
type: Enhancement
date: 2026-10-08
capability_test: "n/a: 测试治理基座与运维脚本，验证走单测（dual-consistency 9 例 + 脚本单测 5 例）与实测探针（revert 红已验证），无独立 LLM 能力面"
intent:
  problem: "守卫 V1/V2 双判定链独立演化，「修复只落一侧」的复发循环已两次实证（#1207→#1304、#1170→#1360）且无 CI 级防线——S1 类割裂只能靠生产误拦数日后人工归因；误拦现场固化靠人工翻 healing 台账手写用例，9/28 replay 之后无补充机制，不固化就重演"
  expected_effect: "同一命令 parseOk 双跑判定不一致时 CI 红灯（revert #1360 修复实测 3 例红，恢复后全绿）；daily-health-check 每日产出 guard_intercept replay 候选并裁决固化，误拦现场从人工翻台账变为每日自动供给"
  verify_by:
    type: behavior_check
created_in_conversation: 7b41e085-5c21-4bd1-adfe-dc3ef051753d
---

# bash 守卫 P1 治理：双链一致性测试 + replay 固化自动化

## 背景

#1360（F20261008gduc）修复了 S1 双链割裂（V1 兜底链 `\|` 误杀 `||` 豁免）与 S2 熔断放大，但机制审视（guard-mechanism-review.md，2026-10-08）指出结构性风险仍在：**V1/V2 双判定链独立演化，「修复只落一侧」的复发循环**（#1207→#1304、#1170→#1360 两次实证）没有 CI 级防线；误拦现场的固化靠人工翻 healing 台账手写用例，9/28 replay（guard-v2-real-replay.test.ts）之后再无补充机制。

本特性落地审视报告的 P1 治理项 3/4（项 5 写落点静态求值器建议独立方案，对应 issue #1363，不进本批）。

## 方案设计

### 项 3：双链一致性测试（tests/frameworks/agent/guard-dual-chain-consistency.test.ts）

**机制识别检查点判定**（troubleshooting 修法决策树前置清单，逐项过）：

| 检查项 | 判定 | 依据 |
|---|---|---|
| 新增配置字段/枚举/开关 | **否** | 用 vitest `vi.mock` 切换 `modelParseOk` 返回值实现「强制 parseOk」，零生产代码改动 |
| 新增状态生命周期/定时任务/后台进程 | 否 | 项 4 固化段挂在既有 daily-health-check 职责内（prompt 段新增，非新定时任务）；候选 JSON 是每次运行的一次性产物（data/ 未入 git），非持久化决策存储 |
| 新增信号类型/消息格式/持久化 | 否 | 脚本只读 healing_events 既有表，无新表新字段 |
| 新增决策分支（结果被记住） | 否 | verdict 是人工填写的临时字段，不回流任何存储 |
| 新增跨模块调用路径 | 否 | 测试→guard-model-judge 的 mock 引用是测试面非生产路径；脚本→sqlite 是既有数据消费面（与 daily-health-check 同源纪律） |
| 结论 | **narrow-fix（测试/运维侧）** | 不动守卫本体，不扩机制面；命中项均不涉净新增机制 |

**核心机制**：守卫入口 `checkBashCommandSafety`（bash-safety-guard.ts:1923）按 `modelParseOk` 双链路由——true 走 V2 模型链（guard-model-judge 段级语义），false 走 V1 文本兜底链。测试对同一命令**强制双跑**（mock 切换），断言：

1. **一致性面**：`V1 判定 === V2 判定`（判定归一为 ALLOW/BLOCK，不比对拦截文案——双链文案本就不同源）
2. **期望值面**：以主链（V2）语义为准断言期望值

**设计取舍**：

- **为什么判定一致而非语义一致**：V1/V2 内部实现语义允许不同（V1 是保守兜底），但**用户可见结论**不允许随解析器成败翻转——S1 的生产形态正是「多行载荷 parseOk=false 落 V1 被误拦，单行 parseOk=true 走 V2 放行」。一致性测试钉的是用户可感知面，不锁死双链内部演进空间。
- **为什么 vi.mock 而非重构注入**：重构守卫入口传 parse 函数是机制改动（与 gduc「不扩面」结论冲突）；vi.mock 零生产改动，代价是 mock 路径与被测模块内部 import 对齐（`@frameworks/agent/guard-model-judge`，vitest alias 解析后匹配，实测探针验证可行）。
- **已知灰区的处理**：`cd WT && node -e 写主仓绝对路径` 形态当前双链一致 ALLOW（issue #1363 灰区，独立收紧）——用例按现状钉 ALLOW 并注明「#1363 落地后改 BLOCK」。钉「一致」仍有防御价值：若未来只收紧一侧，割裂红灯强制双链同步。

**覆盖**（9 例）：cd 豁免族 6 例（`||` 备用链多行/单行/python 形态、只读对照、真管道负门 BLOCK、无 cd 写主仓 BLOCK）+ one-liner 豁免族 3 例（只读 `&&` 链、写主仓载荷灰区、`$()` 命令替换天然 parseOk=false 形态）。

**revert 自证**：换回 #1360 前的守卫文件（33907ccc 版本）实测 **3 例红**（`||` 备用链三形态全部 V1 BLOCK / V2 ALLOW 割裂红灯），恢复后 9 例全绿——S1 类回归从「生产误拦数日后人工归因」前移为「CI 一发红」。

### 项 4：guard_intercept replay 固化自动化

**组成**：

1. `scripts/generate-guard-replay.mjs`：better-sqlite3 只读直查 healing_events（`error_type='guard_intercept'` + 昨日窗口，context.ruleId 存在的结构化事件——#1360 数据源口径），导出候选 JSON：commandHead 从 context 取、缺失时从 description `（命令前缀：…）` 反查；引号值段脱敏（保守近似）；ruleId+命令头去重。**不做的事**：期望值裁决——机械生成会把误拦钉成规范（误拦样本默认 BLOCK = 把误拦固化），裁决必须人工/獭审（verdict: ALLOW/BLOCK/SKIP + 理由）。
2. `prompts/scheduled/daily-health-check.md` 新增「守卫误拦样本固化段」：跑生成器 → 逐条裁决（真实现场旁证：查该命令后续是否换写法绕过）→ 非 SKIP 样本追加到 guard-v2-real-replay.test.ts → 日报留痕「拦截 N → 候选 M → 固化 K / SKIP S」。边界：同 ruleId ≥3 条成规模误拦不开用例改开 issue（修规则优于钉样本）。

**为什么挂在 daily-health-check**：每日体检已有 healing events 消费职责与 issue 产出纪律，固化是其自然延伸；独立定时任务属新增机制面（决策树④），无可论证的必要性增量。

## 影响范围

- `tests/frameworks/agent/guard-dual-chain-consistency.test.ts`：新增（项 3，9 例）
- `scripts/generate-guard-replay.mjs`：新增（项 4 生成器）
- `tests/scripts/generate-guard-replay.test.ts`：新增（生成器单测 5 例：提取/去重/窗口/容错/退出码）
- `prompts/scheduled/daily-health-check.md`：新增固化段（项 4 运维闭环）
- **生产代码零改动**（vi.mock 实现双链切换）

## 验证

- 双链一致性 9 例全绿；revert #1360 修复实测 3 例红（割裂探针有效性自证）；mock-liveness 守卫自证（PR #1368 审视 §3.1 处置：断言被破坏时 9 例全红且失败文案带「mock 失活」指引——静默失效变红灯失效）
- 生成器单测 5 例全绿（临时 sqlite 种子库 → 子进程跑脚本 → 断言产出 JSON）
- 生成器实测：对真实库跑通（2026-10-07 样本 1 条导出，恰为 `ls | grep` 被 data_destructive 误拦形态）
- 全仓 vitest 回归无新增失败；tsc --noEmit 通过

## 审视处置（PR #1368 review follow-up，检视獭1360 报告）

1. **§3.1 mock-liveness 守卫（MEDIUM）**：vi.mock 用 alias 路径拦被测模块内部相对 import，靠 vitest alias 解析对齐——失效态是静默虚绿（双跑同路径→一致性平凡成立）。处置：`dualRun` 加 `expect(vi.mocked(modelParseOk)).toHaveBeenCalled()`（mockClear 后断言真被调用），失效变红灯；实测断言破坏时 9 例全红。
2. **§3.3 replay 口径（LOW-MEDIUM）**：SQL 加 `json_extract(context,'$.ruleId') IS NOT NULL OR description LIKE '%（命令前缀：%'`——真对齐 #1360 数据源口径（排除 bounce 计数事件噪声），兼容旧格式真样本；时区修正 targetDate/窗口统一 UTC 日界（旧实现本地「昨日」与 UTC 窗错位约 8h）。单测同步（s6 纯噪声改断言被排除）。
3. **§3.5 措辞（LOW）**：prompt 恢复「含大獭/小獭」抽样范围约束；压缩声称订正为「硬规则语义全保留（关键词有缩写/合并：须 6→5、禁 2→1）」——原文「14 处全保留」计数不精确（检视獭实测）。

## 后续

- 检视獭对抗审视（异体执行）→ delta 复核 → 呈搭档终审
- #1363（写落点归属校验，审视项 5）独立落地后：一致性测试灰区用例期望值 ALLOW→BLOCK 同步改双链
- 项 3 的 mock 方案若 vitest 大版本升级破坏 alias mock，回退方案是把双跑改为「单跑 + 手动临时改 parseOk 入口」的 lint 前脚本（已有 revert 自证流程兜底）
