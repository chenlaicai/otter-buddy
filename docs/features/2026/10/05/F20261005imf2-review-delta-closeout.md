---
id: F20261005imf2
title: F20261005imfg 审视循环 delta 轮收口（truthy 封口 + Modification-Class 定案 + 数字订正）
summary: "#1283 审视循环的 delta 轮处置落盘：truthy 非字符串 change_type 封口（typeof 门）、Modification-Class 定案 mechanism-addition（机制预算四问留痕）、fix 存量数字订正 271/228、README 口径同步。因 #1283 提前合入使主文档成为已合入快照（historical-docs gate），本增量走 supersede 通道承载。"
change_type: feature-update
capability_test: "n/a: 纯 lint 脚本逻辑改动（A 类），无 LLM 参与行为；由 tests/lint/lint-intent.test.ts 45 用例 + gate 探针实跑覆盖"
modules:
  - scripts/lint-intent.mjs
  - tests/lint/lint-intent.test.ts
  - docs/README.md
tags: [lint, intent, observability, tech-debt, ratchet, review-loop]
from: [F20261005imfg]
causal_links: ["#839", "#1283", "#1290"]
created_at: "2026-10-05"
created_in_conversation: a9260c50-cef6-412e-a0b4-282287a13103
intent:
  problem: "PR #1283 于审视循环未收敛时被提前合入（2026-10-05 07:56Z，squash 381bb3be）——检视发现的严重①②随首版进 main；delta 复核又出 3 条新建议（truthy 非字符串静默/数字不实/README 未同步）与严重③ Modification-Class 待定案，但主特性文档已成已合入快照，lint-historical-docs gate 禁止回改正文（.doc-fix 仅放行 frontmatter 元数据）"
  expected_effect: "truthy 非字符串 change_type（[feature]/123/true）lint:intent EXIT=1（探针实证）；机制预算四问与订正数字在本 PR 可追溯；审视循环经 delta 复核收敛后 #1290 可合入"
  verify_by:
    type: behavior_check
---

## 背景：裁决链留痕

1. PR #1283（#839 主体，F20261005imfg）于 **2026-10-05 07:56Z 被搭档合入 main**（squash 381bb3be），合入的是首版 eb6c7029——检视獭-1283 的检视报告（3 严重 + 3 建议，16:03 呈递）未及收敛，严重①②缺陷随之进入 main
2. 处置转为基于 latest main 的增量 **PR #1290**：严重①（过期检测判据对偶）+ 严重②（change_type null/'' 静默）+ 建议①②③，delta 复核通过（检视獭-1283 + 检视獭-1290 双确认）
3. delta 轮 3 条新建议 + 严重③定案需要落盘，但主文档 F20261005imfg 已是已合入快照——blocked 信号经大獭裁决（2026-10-05 16:59）：历史文档机械边界是既定搭档决策（F20260922dfch），不突破，正文增量走 supersede 新文档（本文件）
4. 本文档收口整个审视循环

## 本轮变更（PR #1290 两个增量 commit）

### truthy 非字符串 change_type 封口（delta 轮新发现 2，commit f63cf6a3）

原 `\|\|` 兜底只封 falsy（undefined/null/''），truthy 非字符串（`[feature]`/`123`/`true`）双 lint 完全静默（检视獭-1283 与检视獭-1290 双实测确认，首轮残余面非回归）。修法：`typeof fm.change_type === "string" && length > 0` 门前置，非字符串一律按缺失口径（feature 必填）。真实 gate 探针：三形态全部 EXIT=1。+3 条锁定用例（单测 42→45）。

### README 口径同步（delta 轮新发现 3，commit f63cf6a3）

docs/README.md「intent 块约定」节：判定口径补「缺失/空值（null/''）/非字符串一律按 feature」；豁免清单说明改「新增路径不进清单；清单键 = 仓库根相对路径」（键已改路径，见 #1290 首个 commit）。

## Modification-Class 定案：mechanism-addition（严重③，大獭拍板 A）

**声明**：本特性族（F20261005imfg + 本增量）的 Modification-Class 为 **mechanism-addition**——豁免清单（scripts/intent-exempt-list.txt）命中机制识别清单「新增持久化存储（文件）」与「新增决策分支持久化消费」两项。与 prompt-anchor-whitelist.txt 先例（8941ab4a）声明口径对齐。首版 narrow-fix 声明作废：原论证「无新决策分支被持久化消费」与清单第 6 项字面冲突，硬留 narrow-fix 靠修论证绕不如承认 + 四问留痕。

### 机制预算四问

**① 谁需要它**：lint-intent gate（commit-time 强制校验流程）——具体是 #839 修复后「缺 intent 块必须 error 拦截」的规则本身：没有豁免清单，规则收紧会立即打红 256 篇存量文档，#839 无法落地。其次是谁在维护 docs/ 的所有写作者（獭与人）——清单是他们补齐 intent 后获得「移出提示」反馈的对象。

**② 失败后果**：内部可感知而非用户可感知（lint 是 commit-time 工具，无运行时用户）。清单漏收录 → 存量被误打红，作者立刻发现并修（fail-loud）；清单多收录/永不缩减 → 灰色绕过窗口在存量上无限期存在——EXEMPT_MAX 只减不增 + 过期条目提示（isIntentComplete 对偶判据）是针对它的机械推动力；清单文件丢失 → 全部豁免消失、256 篇打红（fail-closed，不静默放行）。

**③ 后续机制**：新状态 = 「某文档在豁免清单内」。出错方式与修法：a) 补齐 intent 忘移出 → isIntentComplete 过期检测提示（已实现，含正反两向探针验证）；b) 新文档试图加清单绕过 → EXEMPT_MAX 超限 error + PR diff 显形（已实现，255/257/256 三态探针验证）；c) 清单与文档集漂移（删/改名）→ 幽灵条目不触发行为，仅占配额，定期核对可清。

**④ 退役条件**：清单缩减至 0（存量全部补齐）时，删除 intent-exempt-list.txt、EXEMPT_MAX、loadExemptSet、validateIntent 的 exemptKey 参数与全部豁免分支，回归单一必填口径。另一退役信号：intent 声明机制本身若被 #1067 评测裁撤（intent 治理族待拍板项），本 gate 连同豁免清单一并删除。

### 替代方案评估（与四问①互证）

- **逐篇补齐 256 篇再合入**：单 PR 体量不可行（256 篇 × 每篇需真实 problem/expected_effect 推导），且违背「不追诉存量」既定口径
- **时间界收口**（SOFT_CODE_ENFORCE_DATE 先例）：存量可精确枚举无需近似；时间界有回填旧日期逃逸面
- **快照冻结 + ratchet（已选）**：一次冻结精确、维护成本 ≈ 0（补齐自动提示移出、超限自动拦、膨胀在 diff 显形）

## 数字订正（delta 轮新发现 1）

F20261005imfg 主文档 :51 与 #1283 PR body 中「245 篇 fix 中 205 篇无 intent」**不实**——实测（frontmatter parser 全量复算，检视獭-1283 与检视獭-1290 独立复测一致）：**fix 271 篇 / 无 intent 228 篇**（当前 main 基线）。原数字系首轮摸底旧基线。注：main 上 change_type 旧拼法（bugfix/feature_update/new_feature 等）已被另一任务链统一为 fix/feature-update，现仅 fix 口径即可表述。#1283 body 已 merged 不可改，以本文档为准。

## 提前合入留痕

PR #1283 于审视循环未收敛时被提前合入（2026-10-05 07:56Z，squash 381bb3be），检视獭-1283 首轮报告（3 严重 + 3 建议）中的严重①②缺陷随之进入 main。处置转为基于 latest main 的增量 PR #1290，本订正文档承载全部 delta 轮内容，#1290 合入即收口整个审视循环。imfg 主文档正文自 #1283 合入起冻结（append-only 铁律），#1290 净 diff 中 imfg 与 main 零差异。

## 附录：归一尝试与撤销（append-only 留痕，2026-10-06）

大獭曾拍板「文档归一」（imf2 并入 imfg、删除 imf2，commit 1805a582），理由「冻结语义已被 moving-base 盲区击穿、硬还原是自欺」。**该推理错误**：分支上的违规修改是历史，append-only 铁律约束的是合入 main 的净 diff——imfg 必须保持 main 原版。经搭档纠正后已撤销：imfg 恢复 origin/main 原样（净 diff 零差异），全部订正内容回归本文档承载；moving-base 盲区本身已立 issue #1300 追踪修复。

## 验证

- [x] 单测 45/45（含 truthy 三形态锁定用例）
- [x] 全量 316 files / 4550 tests（worktree 实跑）
- [x] lint:intent / lint:docs gate 实跑 EXIT=0
- [x] truthy 探针三形态（[feature]/123/true）→ EXIT=1 精确拦截
- [x] 本文档 intent 块过 lint:intent（feature-update 带完整 intent 块）

## 对抗审视记录

- 首轮（检视獭-1283，2026-10-05）：3 严重 + 3 建议——严重①② + 建议①②③ 已修（PR #1290 首个 commit，delta 复核通过，双检视独立确认）
- delta 轮（检视獭-1283 + 检视獭-1290，2026-10-05）：处置全部核实通过；新发现 3 条——新 2 新 3 已修（f63cf6a3），新 1（数字订正）+ 严重③定案由本文档承载；待轻量 delta 复核本文档 + f63cf6a3
- 第三轮 delta（检视獭-1290r3，2026-10-06）：**通过（0 严重 0 建议）**——针对归一 commit 1805a582 的复核确认 imf2 九项内容无丢失并入 imfg；该归一随后经搭档纠正被撤销（append-only 铁律，见附录），本复核结论中「归一形态」作废、「内容完整性核对」结论对本文档继续有效

## 后续

- #1290 合入后，#1289（computeDeclarationStats 修复，另一任务链）rebase 重跑 lint:intent（既定排序）
- 256 篇存量按 ratchet 逐步补齐（每补一篇移出清单并下调 EXEMPT_MAX）
- #1067（intent 评测机制去留）拍板结果触发四问④第二退役信号评估
