---
id: F20261005imfg
title: lint-intent 缺字段文档灰色绕过窗口收口（error + 存量豁免清单 ratchet）
summary: change_type ∈ {feature, prompt, 缺失/空值/非字符串} 且无 intent 块（或 intent 块缺 problem/expected_effect）从静默跳过升级为 error；256 篇存量冻结进 scripts/intent-exempt-list.txt（ratchet 只减不增，EXEMPT_MAX=256 防膨胀）；change_type 缺失按 feature 判定（L0 定夺）。Modification-Class 定案 mechanism-addition（机制预算四问见正文）。
change_type: feature
capability_test: "n/a: 纯 lint 脚本逻辑改动（A 类），无 LLM 参与行为；由 tests/lint/lint-intent.test.ts 45 用例 + gate 探针实跑覆盖"
modules:
  - scripts/lint-intent.mjs
  - scripts/intent-exempt-list.txt
  - tests/lint/lint-intent.test.ts
  - docs/README.md
tags:
  - lint
  - intent
  - observability
  - tech-debt
  - ratchet
  - review-loop
causal_links: ["#839", "#1283", "#1290"]
created_at: "2026-10-05"
created_in_conversation: a9260c50-cef6-412e-a0b4-282287a13103
intent:
  problem: "特性文档 frontmatter 缺 change_type/modules/intent 字段时 lint-intent 静默跳过——新文档什么都不写即可绕过 intent gate，CI 假绿（PR #838 首版实证）"
  expected_effect: "缺 intent 块（或块内缺 problem/expected_effect）的新 feature/prompt/无 change_type 文档 lint-intent 退出码 1；256 篇存量豁免清单外新增路径触发 EXEMPT_MAX error；补齐 intent 的存量被 lint 提示移出清单"
  verify_by:
    type: behavior_check
---

## 背景与需求

### 问题描述

issue #839（PR #838 审视程序性移交）：特性文档 frontmatter **完全缺失** change_type/modules/intent 字段时，lint-intent 对该文档跳过全部检查且无 error——CI 显示绿，实为灰色绕过。检查的完备性依赖字段先存在，而字段本身无强制。

### 现状口径（实现前）

- `validateIntent` 缺 intent 分支：`change_type=feature` → warning（不阻断）；`prompt` 不在 REQUIRED/RECOMMENDED 任一集合 → 完全静默；`change_type` 缺失 → 完全静默
- intent 块存在但缺 problem/expected_effect：仅当 change_type 明确为 feature 时 error——change_type 缺失时静默
- 实测存量：lint:docs 对 change_type 缺失零检查（validateChangeType 只查「存在但未知值」，known-values.ts:113-117）

### 大獭拍板（L1）

采用 issue 方案 1（error + 存量豁免清单 ratchet 制），不做方案 2（warning-only）。

### 提前合入留痕

PR #1283 于审视循环未收敛时被提前合入（2026-10-05 07:56Z，squash 381bb3be），检视獭-1283 首轮报告（3 严重 + 3 建议）中的严重①②缺陷随之进入 main。处置转为基于 latest main 的增量 PR #1290（本特性文档正文经审视处置更新，delta 复核通过后随 #1290 收口整个审视循环）。

## 方案设计

### 规则矩阵（实现后）

| 文档状态 | 清单外（新文档） | 清单内（存量豁免） |
|---|---|---|
| change_type=feature/prompt 或空值/缺失/非字符串，无 intent 块 | **error** | warning（提示移出清单） |
| 同上，intent 块缺 problem/expected_effect | **error**（子窗口防御） | warning（5 篇 2026-09-15 goal/why 自创 schema） |
| change_type=fix/refactor，无 intent 块 | **完全静默**（审视处置·建议③修正：fix 不在 REQUIRED/RECOMMENDED 任一集合，历史口径未变——存量 271 篇 fix 中 228 篇无 intent 均静默〔数字经 delta 轮订正，原 245/205 系首轮摸底旧基线〕） | 同左 |
| change_type=bugfix（历史拼法，RECOMMENDED 含它） | warning（推荐） | 同左 |

### 关键决策

1. **change_type 缺失按 feature 判定（L0 自行定夺，按大獭授权）**：调研发现 lint:docs 对 change_type 缺失零检查（`validateChangeType` 仅在字段存在时校验未知值，frontmatter-validator.ts:113-117）——这正是 #839 暴露的缺口本身。若 change_type 缺失仍静默，新文档连 change_type 都不写即可保持灰色窗口，收口不闭环。视同最严类 feature 是唯一不留窗口的选择。
2. **豁免口径含 bad-schema 存量（5 篇）**：首版实现后发现 5 篇 2026-09-15 文档 intent 块用 goal/why/non_goals 自创 schema 且 change_type 缺失——fallback 收口后暴露为 error。若只为绕开这 5 篇把 fallback 限定在「缺 intent 块」分支，会留下「新文档写 `intent: {foo: 1}` 绕过全部校验」的子窗口（与 #839 同构）。故豁免清单口径 = 实际触发缺字段规则的全体存量（251 无块 + 5 bad-schema = 256），规则本体保持完备。
3. **prompt 纳入 REQUIRED**：issue 拍板方案 1 原文即「change_type=feature/prompt 但无 intent 块 → error」；prompt 是软代码主力 change_type（66 篇），缺 intent 时的静默通过是最宽绕过面。
4. **豁免清单独立数据文件**（scripts/intent-exempt-list.txt）+ 脚本内 EXEMPT_MAX 常量：参照仓内 ratchet 双先例——lint-docs.mjs 的 MAX_WARNINGS（#470）与 prompt-anchor-whitelist.txt（独立数据文件 + 失效检测）。EXEMPT_MAX 冻结 256，加路径必须显式改常量，膨胀在 diff 中显形；文档补齐后 lint 主动提示移出（过期条目检测）。
5. **豁免键用文件相对路径而非 fm.id（审视处置·建议①）**：实测全仓存在重复 ID（F20260824ax376/F20260903gh698 各 2 篇），id 键下新文档可抄豁免清单内 ID 继承豁免（探针实证）；路径键下抄 ID 无效（新文件路径必不在清单）、改名则 fail-closed（脱离清单变 error，diff 显形）。全仓 ID 唯一性治理不在 #839 scope，另行立项。validateIntent(fm, exemptKey) 二参，主流程传文件相对路径；测试直调不传 exemptKey 时按非豁免判定（锁定新口径）。
6. **change_type 空值（null/''）与键缺失同口径（审视处置·严重②）**：`||` 统一兜底——原 `??`/`=== undefined` 只兜 undefined，null/'' 双 lint 静默旁路（检视探针实证，存量 0 篇零成本收口）。
7. **truthy 非字符串 change_type 封口（delta 轮新发现 2，commit f63cf6a3）**：原 `||` 兜底只封 falsy（undefined/null/''），truthy 非字符串（`[feature]`/`123`/`true`）双 lint 完全静默（检视獭-1283 与检视獭-1290 双实测确认，首轮残余面非回归）。修法：`typeof fm.change_type === "string" && length > 0` 门前置，非字符串一律按缺失口径（feature 必填）。真实 gate 探针：三形态全部 EXIT=1。+3 条锁定用例（单测 42→45）。

### Modification-Class 定案：mechanism-addition（严重③，大獭拍板 A）

**声明**：本特性族的 Modification-Class 为 **mechanism-addition**——豁免清单（scripts/intent-exempt-list.txt）命中机制识别清单「新增持久化存储（文件）」与「新增决策分支持久化消费」两项。与 prompt-anchor-whitelist.txt 先例（8941ab4a）声明口径对齐。首版 narrow-fix 声明作废：原论证「无新决策分支被持久化消费」与清单第 6 项字面冲突，硬留 narrow-fix 靠修论证绕不如承认 + 四问留痕。

#### 机制预算四问

**① 谁需要它**：lint-intent gate（commit-time 强制校验流程）——具体是 #839 修复后「缺 intent 块必须 error 拦截」的规则本身：没有豁免清单，规则收紧会立即打红 256 篇存量文档，#839 无法落地。其次是维护 docs/ 的所有写作者（獭与人）——清单是他们补齐 intent 后获得「移出提示」反馈的对象。

**② 失败后果**：内部可感知而非用户可感知（lint 是 commit-time 工具，无运行时用户）。清单漏收录 → 存量被误打红，作者立刻发现并修（fail-loud）；清单多收录/永不缩减 → 灰色绕过窗口在存量上无限期存在——EXEMPT_MAX 只减不增 + 过期条目提示（isIntentComplete 对偶判据）是针对它的机械推动力；清单文件丢失 → 全部豁免消失、256 篇打红（fail-closed，不静默放行）。

**③ 后续机制**：新状态 = 「某文档在豁免清单内」。出错方式与修法：a) 补齐 intent 忘移出 → isIntentComplete 过期检测提示（已实现，含正反两向探针验证）；b) 新文档试图加清单绕过 → EXEMPT_MAX 超限 error + PR diff 显形（已实现，255/257/256 三态探针验证）；c) 清单与文档集漂移（删/改名）→ 幽灵条目不触发行为，仅占配额，定期核对可清。

**④ 退役条件**：清单缩减至 0（存量全部补齐）时，删除 intent-exempt-list.txt、EXEMPT_MAX、loadExemptSet、validateIntent 的 exemptKey 参数与全部豁免分支，回归单一必填口径。另一退役信号：intent 声明机制本身若被 #1067 评测裁撤（intent 治理族待拍板项），本 gate 连同豁免清单一并删除。

#### 替代方案评估（与四问①互证）

- **逐篇补齐 256 篇再合入**：单 PR 体量不可行（256 篇 × 每篇需真实 problem/expected_effect 推导），且违背「不追诉存量」既定口径
- **时间界收口**（SOFT_CODE_ENFORCE_DATE 先例）：存量可精确枚举无需近似；时间界有回填旧日期逃逸面
- **快照冻结 + ratchet（已选）**：一次冻结精确、维护成本 ≈ 0（补齐自动提示移出、超限自动拦、膨胀在 diff 显形）

## 实现细节

### scripts/lint-intent.mjs

- `INTENT_REQUIRED_CHANGE_TYPES`：+prompt
- 新增 `FALLBACK_CHANGE_TYPE = "feature"`（change_type 缺失口径）+ `EXEMPT_LIST_PATH`/`EXEMPT_MAX=256`/`loadExemptSet()`
- `validateIntent(fm, exemptKey)`：豁免判定（路径键命中清单）；缺 intent 分支、problem 分支、expected_effect 分支均按「豁免 → warning / 非豁免 → error」双轨；内部统一 `effectiveChangeType`；非字符串 change_type typeof 门前置（f63cf6a3）
- main()：传文件相对路径（豁免键，审视处置·建议①）；ratchet 上限核对（清单 > EXEMPT_MAX → error；< EXEMPT_MAX → warning 提示同步下调，消除回涨空间——审视处置·建议②补实现）；过期条目提示判据 isIntentComplete()（非豁免身份重跑无 "Missing intent" 类 error 才提示移除——审视处置·严重①，与豁免触发条件对偶，bad-schema 存量不再被误提示）

### scripts/intent-exempt-list.txt（新增）

256 篇冻结清单（路径键）：feature 191 / prompt 35 / change_type 缺失 25（无 intent 块）+ 5（bad-schema）。生成方式：worktree 内一次性脚本按 parseFrontmatterFromContent 真实解析结果枚举（与 lint 同一 parser，非手抄）。

### tests/lint/lint-intent.test.ts

45 用例（原 33 → 首版 +9 → 审视处置 +6 / 改写 6 → delta 轮 +3）。锁定用例覆盖：
- 缺 intent 块的新 feature/prompt/无 change_type 文档 → error
- change_type null/空串（严重②）/ truthy 非字符串三形态 [feature]/123/true（delta 新 2）→ error
- 豁免清单内（取真实清单首条路径）→ warning 非阻断（feature/prompt 双口径）
- bad-schema intent：豁免内降 warning / 清单外 error（子窗口防御）
- EXEMPT_MAX ≥ 清单行数 > 200（防清单意外清空致 gate 失真）

### docs/README.md

「intent 块约定」节：判定口径补「缺失/空值（null/''）/非字符串一律按 feature」（f63cf6a3 同步）；豁免清单说明改「新增路径不进清单；清单键 = 仓库根相对路径」。

## 设计取舍

- **不做时间界（created_at 软代码先例式）**：intent 块的存在性可由清单精确枚举，无需时间界近似；时间界存在回填旧日期逃逸面（SOFT_CODE_ENFORCE_DATE 注释自认）。豁免清单一次冻结更精确且天然只减不增。
- **豁免键用文件相对路径而非 fm.id**（审视处置·建议①修订，原选 id 的理由被重复 ID 实测推翻）：id 存在重复歧义（2 组实测），路径唯一且 fail-closed；代价是路径含 slug 可变——文档改名会脱离清单变 error，在 diff 显形，属 ratchet 收紧方向的预期行为。
- **存量豁免降级为 warning 而非完全沉默**：保留可观测性（ratchet 地板的推动力），且 lint 输出中显式提示「补齐后请从清单移除」。

## 验证

- [x] 单测 45/45 通过（锁定用例：新文档缺块→error、null/空串 change_type→error（严重②）、truthy 非字符串三形态→error（delta 新 2）、豁免内存量→warning 不阻断、bad-schema 子窗口防御、isIntentComplete 三态（严重①）、抄 ID 不继承豁免（建议①）、EXEMPT_MAX 一致性）
- [x] gate 实跑（探针法）：新文档缺 intent 块 / change_type 空值 / truthy 非字符串三形态 / 抄豁免 ID → 各自精确 error + exit 1；删除探针后 691 docs OK + 0 error（256 豁免 warning）
- [x] 存量豁免：256 篇清单内文档全部降级 warning（含 5 篇 bad-schema）
- [x] 既有 error 不回归：顶层 verify_by / invalid verify_by.type / fuzzy word 门禁 / golden_replay 核对用例全绿
- [x] lint:docs / lint-capability-docs / lint-historical-docs 实跑通过
- [x] 全量 316 files / 4550 tests（worktree 实跑）
- [x] 最简实现检查：已过——豁免对照表 + 双轨降级是 ratchet 模式最小实现；替代方案（逐篇补齐 256 篇 intent）单 PR 体量不可行且违背「不追诉存量」既定口径

## 对抗审视记录

### 首轮（检视獭-1283，2026-10-05）：需要修改——3 严重 + 3 建议

处置（同日完成，见 PR review 处置表）：

- **严重①（过期条目检测判据错构）已修**：判据改为 isIntentComplete()（非豁免身份重跑 validateIntent，无 "Missing intent" 类 error 才算已补齐），导出供测试锁定；5 篇 bad-schema 存量不再被误提示（原实现照提示移出即 CI 红）。补 3 条 isIntentComplete 三态用例。
- **严重②（change_type 空值 null/'' 双 lint 静默）已修**：`||` 统一兜底（原 `??` 只兜 undefined）；空值/缺失同口径拦截，文案「change_type 缺失/空值按 feature 判定」。补 2 条锁定用例（null/空串 → error）。真实 gate 探针实证三种绕过形态全部拦截。
- **严重③（Modification-Class）已处置**：大獭拍板 A——改 mechanism-addition + 机制预算四问留痕（见「方案设计」节），首版 narrow-fix 声明作废。
- **建议①（豁免键 id 歧义）已修**：豁免键改文件相对路径，抄 ID 继承豁免被探针实证封死；全仓 ID 唯一性治理另行立项。清单重新生成（256 条路径键）。
- **建议②（收缩提示缺实现）已修**：EXEMPT_MAX 核对双向——超限 error / 低于上限 warning 提示同步下调。
- **建议③（规则矩阵 fix 行不实）已修**：特性文档矩阵改为「fix → 完全静默（历史口径未变）」，PR body Discovered Issues 自评同步修正。

### Delta 复审（检视獭-1283 + 检视獭-1290，2026-10-05）：通过，新发现 3 条

- 处置核实：首轮 3 严重 + 3 建议全部修复属实，双检视独立确认
- **新发现 1（数字不实）已修**：fix 存量 271 篇 / 无 intent 228 篇（当前 main 基线，双检视独立复测一致），原 245/205 系首轮摸底旧基线——规则矩阵节已订正（#1283 PR body 已 merged 不可改，以本文档为准）
- **新发现 2（truthy 非字符串静默）已修**：typeof 门封口（f63cf6a3），探针三形态全拦，+3 锁定用例
- **新发现 3（README 未同步）已修**：docs/README.md 判定口径与清单键说明同步（f63cf6a3）

## 后续

- #1290 合入后，#1289（computeDeclarationStats 修复，另一任务链）rebase 重跑 lint:intent（既定排序）
- 256 篇存量按 ratchet 逐步补齐（每补一篇移出清单并下调 EXEMPT_MAX）
- #1067（intent 评测机制去留）拍板结果触发四问④第二退役信号评估
