---
id: F20261012orcl
title: 验收 Oracle 机器闸：不变量 registry + PASS/FAIL checker + 防篡改 + 测试弱化防线
summary: |
  把纪律/验收从口头指令变成机器闸：oracle/invariants.json 登记不可丢的纪律语义，
  scripts/check-oracle.mjs 逐条机器判 PASS/FAIL，oracle/lock.json hash 防篡改，
  scripts/check-pr-tests.mjs 拦测试弱化无声明，CI 接线红绿即验收。
  动机：3 场事故（假急停 #1430、出清删 4 处纪律语义、表扬漏采）全是纸面纪律失守、无机器拦截。
  主机制：registry + PASS/FAIL checker + lock 防篡改 + waiver 有效期 + CI gate。
change_type: feature
capability_test: "n/a: 机器闸属静态校验层（文件语义在位性 + diff 声明判定），无真 LLM 能力面；行为验证走 tests/oracle/ fixture 红→绿（verify_by=behavior_check）"
created_in_conversation: 98bd9fdd-8e28-4de8-b782-b59f46e733dd
created_at: "2026-10-12"
doc_type: feature
tags: [lint, oracle, ci, engineering-hygiene]
modules:
  - scripts/check-oracle.mjs
  - scripts/check-pr-tests.mjs
  - scripts/lint-evidence-anchors.mjs
  - oracle/invariants.json
  - oracle/waivers.json
  - oracle/lock.json
  - .github/workflows/ci.yml
  - .githooks/pre-commit
  - package.json
  - docs/README.md
  - .pi/skills/adversarial-review/references/review-dimensions.md
causal_links:
  from:
    - F20261012acpt
    - F20260821kgts
intent:
  problem: "纪律/验收全写在 prompt 与文档里（口头指令），无机器闸——删/放宽纪律语义与验收断言的 diff 无人拦截（出清删 4 处纪律语义一路绿灯到 delta 复核才被人眼抓、测试弱化可过 CI、处置自述被当证据采信）"
  expected_effect: "删/放宽纪律语义与验收断言的 diff 被 check-oracle / check-pr-tests 机器当场拦截（exit 1，0 人工）；registry/checker/waivers 被篡改不同步 lock 时 exit 2；过期 waiver 失效即红；测试弱化无「## 测试改动声明」即红"
  verify_by:
    type: behavior_check
---

# F20261012orcl: 验收 Oracle 机器闸

## 背景与需求

### 问题描述

搭档指令（原话）：「你一次性做完，不要搞什么p0~4，有需要分这么多个Pr啊，不都是一个特性吗」——一个特性一个 PR 一次交齐。

外部洞察（momo5502「500+ Billion Tokens Later: Letting AI Agents Decompile A First-Person Shooter」，https://momo5502.com/posts/2026-10-09-game-decompilation/ ）的教训：正确性必须机器可判 PASS/FAIL——装 oracle 前 80% 进度全是假象、reviewer 全漏、worker 自述注入；装后 reviewer 撤裁、便宜模型逆袭。三条可迁移结论：①正确性必须机器可判 PASS/FAIL；②留解释空间就会作弊；③验证脚本本身要防篡改（他们 CI hash 了验证脚本）。

映射到海獭系统的三缺口（吸收 F20261012acpt G1-G3 分析）：

- **G1 系统断言无 provenance**：断言（「已验证/全绿/通过」）不附机器锚点，编造与真实无从区分——10-12 假急停（#1430）LLM 归因错误无人可查。
- **G2 验收装置可被被验收者修改**：实现者可在 PR 中放宽/删除测试断言过 CI；今天「出清删 4 处纪律语义」的 diff 一路绿灯，直到 delta 复核才被人眼抓到。
- **G3 进度与质量混同**：只报产出数不报「其中已验证几个」（表扬漏采靠 sql 机械锚点才修好——LLM 摘要漏整类信号的同构教训）。

3 场事故共同根因：纪律/验收写在 prompt 与文档里（口头指令），删了没人拦、放宽没人知、自述没人验——**纸面纪律失守、无机器闸**。

### 今天的真实事故（registry 种子条目的出处）

1. **出清删 4 处纪律语义**：一次「出清冗余」改动删掉 daily-health-check.md 里 4 处纪律语义（「禁止只列数字」等），全程 CI 绿灯，delta 复核才被人眼抓到。
2. **假急停 #1430**：来源盲扫描把定时任务 prompt 当用户消息，注入假「停下」——Magic Words 触发边界（「仅搭档当前指令触发，引用/复述/讨论历史不触发」）是唯一防线，此类指令保鲜无机器校验。（bug 本体已随 #1443 修复；本特性管「这类指令不许再被删」。）
3. **表扬漏采**：LLM 摘要漏整类信号，靠 sql 机械锚点才修好——「机器可查证据 > LLM 自述」的又一实证。

## 目标 / 非目标

### 目标

- T1: 不变量 registry + PASS/FAIL checker——删/放宽纪律语义的 diff 被机器当场拦截（红→绿用例 = 今天出清删纪律语义的真实事故）
- T2: 防篡改——registry/checker/waivers 被改动不同步 lock 即 exit 2；放宽必须走 waiver 且过期自动失效
- T3: 测试弱化防线（F20261012acpt T2 机械化）——测试删除无声明即红，放宽无理由即红
- T4: 断言证据锚点轻量规则（F20261012acpt T1 报告侧）——验证类断言无锚点机械告警（ratchet 起步）
- T5: 反自述核验规程（软代码）——「处置自述不作证据」进检视维度
- T6: 交付双数字模板（F20261012acpt T3）进 docs/README.md，并受 registry 保护

### 非目标

- 不含 #1430 bug 修复本身（已随 #1443 落地）
- 不做 F20261012acpt T4 效果验收试点（雷达/体检效果指标）——本特性只做「效果度量」口径定义，定时任务效果验收另立特性
- 不判测试改动的语义好坏（「收紧/放宽」是声明字段，机器只判声明存在与理由非空）
- registry 不覆盖 src 代码断言（先管 prompt/文档层纪律语义，扩面待复盘点）

## 方案设计

六个交付物全部在本 PR 内（不分期）：

| # | 交付物 | 形态 | 治什么 |
|---|--------|------|--------|
| 1 | `oracle/invariants.json` | 不变量 registry（id/file/pattern/rationale/waiver_eligible，种子 ≥9 条） | 纪律语义「必须在位」有登记 |
| 2 | `scripts/check-oracle.mjs` | PASS/FAIL checker（`--json` / `--update-lock`；exit 0/1/2） | 缺失即红，0 人工 |
| 3 | `oracle/lock.json` + `oracle/waivers.json` | 防篡改 lock（sha256）+ waiver（含 expires，数量 ratchet 上限） | 改闸必须显形；放宽必须审批且会过期 |
| 4 | `scripts/check-pr-tests.mjs` | 测试弱化防线（diff 删测试行 → 要求「## 测试改动声明」+ 方向；放宽要理由） | G2 机械化 |
| 5a | `scripts/lint-evidence-anchors.mjs` | 断言证据锚点轻量规则（warn 起步，改动态 + PR body） | G1 报告侧 |
| 5b | `review-dimensions.md` 增补「处置自述不作证据」硬规程 | 软代码（行为触发语义） | 反自述核验 |
| 6 | `tests/oracle/*.test.ts` | 红→绿 fixture、lock 篡改、waiver 过期、测试弱化用例 | 闸自身的验收装置 |
| 7 | CI / pre-commit 接线 + npm scripts | `.github/workflows/ci.yml`、`.githooks/pre-commit`、`package.json` | 执行面（纪律≠机制，--no-verify 绕不过 CI） |

### checker 语义（核心判定表）

| 场景 | 退出码 | 说明 |
|------|--------|------|
| 全部 pattern 在位 | 0 | PASS |
| pattern 缺失、无 waiver / waiver 过期 / 条目不可豁免 | 1 | FAIL（含过期 waiver——「过期 waiver 无效」） |
| pattern 缺失、有有效 waiver（waiver_eligible=true 且未过期） | 0 | PASS(WARN)，明细打印 |
| lock 与 registry/checker/waivers 实际 hash 不符 / lock 缺失 / registry schema 非法 | 2 | 「registry/checker 被改动，需 --update-lock 并走 waiver 评审」 |
| waiver 条目畸形 / 指向未知条目 / 指向不可豁免条目 | 1 | fail-closed，配置不一致即红 |

## 设计取舍

### 机制识别检查点判定（动手前完成，2026-10-12）

本次修复是否涉及以下任一项（清单：troubleshooting skill 修法决策树节）：

- ☑ **新增配置字段/枚举/开关**——registry 条目 schema（id/file/pattern/rationale/waiver_eligible）、waiver 条目 schema（invariant_id/reason/approved_by/expires）
- ☑ **新增持久化存储（文件）**——oracle/ 三件套（invariants.json / waivers.json / lock.json）
- ☑ **新增决策分支（结果被记住并影响后续行为）**——lock 不符 → exit 2、waiver 有效/过期 → WARN/FAIL 的分支直接决定 CI 红绿与合入命运
- ☐ 状态生命周期 / ☐ 定时任务 / ☐ 信号类型 / ☐ 跨模块调用路径——均无（checker 是单进程只读脚本）

命中 → **判定净新增机制 → 修法决策树④ + 机制预算四问必答 + 重对抗门必过**。

**为何跳过①②③**：① 既有 lint 家族无「纪律语义在位性」检查——lint-docs 管 frontmatter 结构、lint-prompt-anchors 管「不该在」（禁锚点，方向与本闸相反）、lint-tests 管测试反模式、lint-intent 管声明字段；「文件必须仍含某语义」无既有机制可扩；② 无可收窄的问题机制（病是「无闸」不是「闸太宽」）；③ 无可删机制。测试弱化防线（check-pr-tests）是 F20261012acpt T2 检视维度的机械化——「机器判声明存在」必须有独立执行体，无法寄生在检视 skill 的文字规程里，同理归④。

**重对抗门状态**：按流程选④须重对抗门（检视獭审查「治本还是治标」）。本特性由大獭编排检视轮承接（异体检视獭同一轮审视中追加门控三问，与对抗审视合并，不重复召唤）——门控结论待检视轮回填本段。

### 机制预算四问

① **谁需要它**：检视獭（验收核验者）——核验纪律语义在位性不再靠人眼通读 diff，checker 输出直接当证据；CI（机器执行面，对每个 PR 生效）；每只提交 PR 的海獭（被闸者，红绿即验收信号）；搭档/大獭（终审时看 oracle PASS/FAIL 而非自述）。3 场事故的共同受害方是搭档（拿到纪律退化的体检报告、被假急停打断流程）。

② **失败后果**：用户可感知损害，不是内部指标异常——(a) 纪律语义被删无人知 → 体检报告退回「只列数字」的退化形态（今天差一点发生）；(b) 测试被放宽过 CI → 回归逃逸、用户踩 bug；(c) 验收自述可注入 → 假进度被当真进度（momo5502 案例的 80% 假象同构）。不装闸的失败后果本周已真实发生 3 次。

③ **后续机制**（它创造的新状态里哪些可能出错、会被怎么修）：
- registry 条目腐烂——pattern 指向的文件重构后失配误报 → FAIL 显形于 CI（误报也被看见，改 pattern 走 --update-lock + review，diff 显形）；
- registry 膨胀——每条 rationale 必写出处，新增条目进 diff 由检视核对「今天真实教训」；不做自动上限（条目数与纪律语义量同构，ratchet 不适用），复盘点人工审规模；
- waiver 堆积不清理——数量 ratchet 上限（WAIVER_MAX，超限 error）+ expires 强制过期即 FAIL（到期 waiver 不清就红，机械推动清理）；
- lock 更新变走过场——机器拦不住「--update-lock 一把梭」，靠流程锁：lock.json 变更必进 PR diff，检视按「改闸必须显形」核对 waiver 评审留痕。

④ **退役条件**：(a) 纪律语义全部迁入可执行测试/代码断言（prompt 层不再承担行为约束）时，registry 的 prompt 在位性检查冗余可退役；(b) 试点 2–4 周复盘点后 oracle 零拦截、检视从未消费其输出、waiver 零使用 → 说明闸位不对，重定位或删除。**中间复盘点**：试点 2–4 周复审一次（拦截数 / 误报率 / waiver 使用率 / lock 更新频次），无复审记录则本机制视为长期化并需搭档知情。

### 取舍表

| 取舍 | 决策 | 替代方案 | 理由 |
|------|------|----------|------|
| lock 覆盖面 | hash 三文件：registry + checker 自身 + waivers | 只 hash registry | 规格教训③「验证脚本本身要防篡改」——只锁 registry 则改 checker 让它永远 PASS 即绕闸 |
| lock 形态 | 逐文件 sha256 map + 组合 hash | 单一组合字符串 | 诊断更细（哪件被改一眼可见）；信息量严格不小于规格要求，防篡改语义不变 |
| waiver 形态 | `oracle/waivers.json`（结构化 + expires + 数量 ratchet 上限） | 沿用 intent-exempt-list 文本清单惯例 | exempt-list 是「存量冻结」语义（只减不增），waiver 是「临时放宽」语义（必须会过期）——文本清单无 expires 字段，达成不了「过期无效」的防篡改语义，按规格口径允许新造并在此说明 |
| check-pr-tests 触发口径 | 测试路径**任何删除行**即触发声明要求 | 净删除（删>增）才触发 | 净额口径漏「删 2 加 2 空断言」的零净弱化；声明成本一行，闸漏成本是 G2 失守——取严 |
| 测试弱化判定深度 | 只判声明存在 + 方向字段 + 放宽理由非空 | LLM 判语义 | 「不判语义」是刻意边界：语义判定留给检视獭，机器管「声明必须显形」——留解释空间就会作弊，机器闸只管可机械判定的最小面 |
| 5a 分级 | warn 起步（不阻断） | 直接 fail | 存量验证节大量无锚点，直接 fail 炸存量；先告警积累观测基线，复盘点收紧为 fail 或接 date-bombs 式基线守恒（只减不增） |
| 5a 范围 | 本次改动的 F 文档 + PR body | 全树扫描 | 责任面是本 PR 改的文档；全树存量误报不属本 PR 修复义务 |
| check-pr-tests 执行面 | 仅 CI（pull_request 事件） | + pre-commit | 声明载体是 PR body，commit 时不存在——本地无判定对象 |
| lint:oracle 执行面 | pre-commit + CI 双挂 | 只挂一处 | lint-gate 家族惯例（只挂 pre-commit 会被 --no-verify 绕） |
| T3 双数字落点 | docs/README.md 模板段 + registry 保护 | 再改 daily-health-check 加抽查项 | 控制注入面改动（daily-health-check 是高频注入 prompt，非本特性必要不动）；registry 保护已给模板段上闸 |

## 验收标准（本特性的「字节匹配」等价物）

| 编号 | 场景 | 操作 | 预期结果 |
|------|------|------|----------|
| AT-1 红 | 出清删纪律语义事故重演 | fixture 删「禁止只列数字」（及今天被删的 4 处） | `check-oracle` FAIL（exit 1，明细含条目 id）——今天这个 diff 一路绿灯 |
| AT-2 绿 | 完整文件 | 完整 registry 目标文件 | PASS（exit 0） |
| AT-3 篡改 | 改 registry/checker/waivers 不同步 lock | 任意 oracle 件套改动后直跑 | exit 2「需 --update-lock 并走 waiver 评审」 |
| AT-4 waiver | 合法 waiver / 过期 waiver | 缺失条目 + 未过期 waiver / 过期 waiver | PASS(WARN) / FAIL |
| AT-5 测试弱化 | 测试删断言无声明；带声明；放宽无理由 | check-pr-tests 三态 | FAIL / PASS / FAIL |
| AT-6 锚点 | 验证断言无锚点 | lint-evidence-anchors | warn（ratchet 起步） |

### 能力测试映射

无（静态校验层，capability_test 声明 n/a，理由见 frontmatter）。

## 设计决策

（取舍见「设计取舍」段；实现期决策已并入该段取舍表，无新增分支。）

## 实现细节

### 改动范围

| 文件 | 性质 | 内容 |
|------|------|------|
| `oracle/invariants.json` | 新增 | 不变量 registry v1，9 条种子（每条 rationale 带出处） |
| `oracle/waivers.json` | 新增 | waiver 空清单（version + waivers 数组） |
| `oracle/lock.json` | 新增 | 三件套 sha256（逐文件 map + combined） |
| `scripts/check-oracle.mjs` | 新增 | PASS/FAIL checker（~280 行，`--json`/`--update-lock`/`--root`，导出纯函数供测试） |
| `scripts/check-pr-tests.mjs` | 新增 | 测试弱化防线（diff 删测试行 → 声明闸） |
| `scripts/lint-evidence-anchors.mjs` | 新增 | 断言证据锚点 lint（warn 起步） |
| `tests/oracle/*.test.ts` | 新增 | 36 用例（红→绿/防篡改/waiver/声明闸/锚点检测） |
| `.github/workflows/ci.yml` | 修改 | fast lint gates 加 `lint:oracle`；新增两个 PR 侧 gate step（注入 PR_BODY） |
| `.githooks/pre-commit` | 修改 | 末尾加 `npm run lint:oracle`（家族惯例双挂） |
| `package.json` | 修改 | `lint:oracle` / `lint:pr-tests` / `lint:evidence-anchors` scripts |
| `docs/README.md` | 修改 | 新增「交付双数字（汇报强制）」段（T3 落点，受 registry 保护） |
| `.pi/skills/adversarial-review/references/review-dimensions.md` | 修改 | B3 增补「处置自述不作证据」硬规程（T5，软代码） |

### registry 种子条目（9 条）

| id | 目标 | 治什么（出处） | 可豁免 |
|----|------|----------------|--------|
| dhc-no-bare-numbers | daily-health-check.md | 「禁止只列数字」被删（10-12 事故①） | 是 |
| dhc-assertion-evidence | daily-health-check.md | 「失败附断言原文+实际内容」被删（事故②） | 是 |
| dhc-issue-verification-assertion | daily-health-check.md | 「每个 issue body 含「验证断言」段」被删（事故③） | 是 |
| dhc-issue-close-criteria | daily-health-check.md | 「每个 issue body 含「关闭标准」段」被删（事故④） | 是 |
| system-magic-stop | SYSTEM.md | 「停下」急停行（安全底线） | 否 |
| system-magic-divert | SYSTEM.md | 「绕路了」重审行（安全底线） | 否 |
| system-magic-trigger-scope | SYSTEM.md | 「仅搭档当前指令触发」边界（假急停 #1430 同构失守） | 否 |
| docs-delivery-dual-number | README.md（docs） | 交付双数字模板段（G3 假进度防线，本 PR 新增并上闸） | 是 |
| review-no-self-report-evidence | review-dimensions.md | 「处置自述不作证据」规程（反自述核验，dogfood 自保） | 是 |

## 验证

### 红→绿证据链（fixture 重演今天的真实事故）

**绿基线**（完整仓库）：

```
$ node scripts/check-oracle.mjs
[lint:oracle] PASS（9/9 条在位，lock OK）
```

**红**（fixture 重演「出清删 4 处纪律语义」事故 diff——今天这个 diff 一路绿灯到 delta 复核）：

```
$ sed -i '' 's/禁止只列数字//;s/失败附断言原文+实际内容//;s/每个 issue body 含「验证断言」段/issue body/;s/每个 issue body 含「关闭标准」段/issue body/' "$FIX/prompts/scheduled/daily-health-check.md"
$ node scripts/check-oracle.mjs --root "$FIX"
✗ dhc-no-bare-numbers  prompts/scheduled/daily-health-check.md
    语义缺失——期望 pattern：禁止只列数字
✗ dhc-assertion-evidence  prompts/scheduled/daily-health-check.md
    语义缺失——期望 pattern：失败附断言原文+实际内容
    （另有 ✗ dhc-issue-verification-assertion / ✗ dhc-issue-close-criteria 两条同格式明细，逐字实录中略）

[lint:oracle] FAIL（缺失 4 / 配置错误 0，lock OK）——修复语义或走 waiver（oracle/waivers.json）后重跑
exit:1
```

**测试套件**（36 用例全绿，含 lock 篡改→exit 2、waiver 过期→FAIL、弱化无声明→FAIL、放宽无理由→FAIL 等负面向用例）：

```
$ npx vitest run tests/oracle/
 Test Files  3 passed (3)
      Tests  36 passed (36)
```

**回归基线**（全量套件，零 pre-existing 失败——无需基线声明，干净即证据）：

```
$ npx vitest run
 Test Files  359 passed (359)
      Tests  5407 passed (5407)
```

### Golden Gate 声明（软代码改动义务）

本变更涉及软代码（review-dimensions.md 行为触发语义）→ 已执行 Golden Gate 命令：

```
$ npm run test:capability
 Test Files  15 passed (15)
      Tests  15 passed | 40 skipped (40)
[capability] SKIP REPORT: 采样段因本地无 LLM 端点跳过
```

豁免声明：本变更软代码（检视规程文案）无对应 golden 场景（golden 仅覆盖记忆召回判别）；采样段需真 LLM 端点（本地未配置，两次执行 skip 报告同因）；golden selftest 段由 CI 定时 golden-selftest 任务覆盖（push/PR 不跑，见 ci.yml 注释）。按 Golden Gate 豁免规则记声明，非静默跳过。

### 最简实现检查

1. **是否已有同类机制可扩展？** 已盘 lint-gate 家族（lint-intent/lint-docs/lint-capability/lint-tests/lint-skills/lint-historical-docs/lint-prompt-anchors/lint-prompt-size/lint-date-bombs/lint-tool-manifest）——无一管辖「文件语义在位性」（lint-prompt-anchors 管禁锚点，方向相反）；测试弱化/证据锚点同理无既有执行体，故新增 3 个脚本而非强改无关闸。
2. **能否删除部分设计？** lock 覆盖 checker 自身不可删（否则改 checker 即绕闸）；waiver 的 expires 不可删（否则放宽永久化）；5b 软代码规程不可删（G1 反自述的规程层）。
3. **绕过了什么既有保护？（负面向验收条目）** (a) `--update-lock` 是自服务的 lock 重写口——机器拦不住一把梭，靠「lock.json 变更必进 diff + 检视核对 waiver 评审留痕」流程锁；(b) check-pr-tests 不判语义，声明造假（写「收紧」实为放宽）机器不抓，靠检视反自述规程抓；(c) 5a warn 级不阻断，ratchet 起步；(d) registry pattern 是子串/正则在位性，管不到「语义被改写但关键词还在」的变体——指令保鲜到关键词级是刻意的可判定边界。

### 负面向验收条目（本次变更绕过了什么既有保护——与上节同源，留档双处可见）

见上「最简实现检查」第 3 条：lock 自服务更新口 / 声明语义不可机判 / warn 不阻断 / 关键词级保鲜边界。

## 效果度量（T4 口径定义，试点 2-4 周复盘点取数）

| 指标 | 口径 | 取数处 |
|------|------|--------|
| oracle 拦截数 | CI 红灯中 lint:oracle/check-pr-tests 导致的失败次数 | CI run 详情 |
| oracle 通过率 | lint:oracle PASS 次数 / 执行次数 | CI run 详情 |
| waiver 使用率 | waivers.json 条目数 / 过期未清理数 | oracle/waivers.json |
| 检视复核工时 | 检视轮中「人眼抓纪律语义删除」发生的次数（目标趋零） | 检视报告 |
| 便宜模型任务占比 | 可机械验收任务（lint/闸类）派给低价模型的比例 | 派工记录 |

复盘点（2026-10-26 前后）：拦截数/误报率/waiver 使用率/lock 更新频次——若 oracle 零拦截且检视从未消费其输出 → 按④退役条件重定位或删除；无复审记录则本机制视为长期化并需搭档知情。

## 本次变更对旧特性做了什么

- **吸收 F20261012acpt T2-T4 意图并机械化**：T2（测试弱化防线）→ check-pr-tests 机器闸；T3（双数字汇报）→ docs/README.md 模板段 + registry 保护（抽查项未纳入，见非目标）；T4（效果验收试点）→ 本节效果度量口径定义（定时任务效果验收另立特性）。原 PR #1441 作废由大獭关闭，其 T1（断言证据锚点）代码部分已随 #1430 修复 PR（#1443）落地，本特性补其报告侧（5a）。
- **对 lint-gate 家族（F20260821kgts）**：纯加法扩展，新增 3 个脚本 + 2 个 CI step + 1 个 pre-commit 行，未改动既有闸的任何判定（eslint/全量测试回归绿）。
- **对 F20261005imfg 等 intent 体系**：无改动，本特性文档自身按现行规范登记（lint:intent 本期 100%）。
