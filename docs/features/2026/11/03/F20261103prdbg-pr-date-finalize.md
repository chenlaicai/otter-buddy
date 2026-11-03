---
id: F20261103prdbg
title: 定稿编号顺延堵口：检视/终审/文档三处补 F20260914prdb 检查项
summary: |
  2026-11-03 #1660 现场：跨日 PR（10-27 创建、11-03 合入）编号停在创建日
  F20261028bsrmx，检视獭初轮+两轮 delta 均「三处一致即过」漏检「日期=合入日」
  语义，搭档人眼抓出。根因：F20260914prdb 定稿改名规程只活在特性文档里，
  三处执行面（检视维度 B4 / 终审清单 / docs 成文）全没接住。本 PR 三处堵口：
  B4 补定稿顺延检查项（跨日未顺延=建议发现）、review-protocol 终审清单补
  定稿编号核对、docs/README.md 补定稿改名成文节。附带发现：F20260914prdb:51
  成文于 commit-convention.md 的定稿改名规则从未写入（文件自 09-04 存在并
  承载 FID 格式规则，但「定稿/顺延/合入日」零命中），规则缺位 50 天。
change_type: fix
capability_test: "n/a: skill/文档规则改动，效果为未来检视与终审行为约束，无直接可跑用例"
causal_links:
  relates:
    - "F20260914prdb"
    - "#1660"
tags: [adversarial-review, review-protocol, docs, fid-date, finalize-rename, gap-fix]
modules:
  - .pi/skills/adversarial-review/references/review-dimensions.md
  - .pi/skills/review-protocol/SKILL.md
  - docs/README.md
created_at: 2026-11-03
created_in_conversation: 12967086-9ce5-4cf8-8343-ce4b0fd31519
intent:
  problem: "F20260914prdb 定稿改名规程（创建日 ID → 定稿顺延合入日）只活在特性文档里，三处执行面（检视 B4 / 终审清单 / docs 成文）全没接住，#1660 靠搭档人眼兜底才未合入错误编号"
  expected_effect: "跨日 PR 在检视侧（B4 检查项）或终审侧（呈终审前核对）至少一处被接住，定稿编号顺延成为审视闭环标准动作；docs 成文让规则可被新人（含新獭）独立发现"
  verify_by:
    type: human_judge
---

# 定稿编号顺延堵口

## 现场

2026-11-03 #1660（B5 撞车降级）呈终审、搭档已点合入按钮后，搭档发现编号
F20261028bsrmx 停在创建日（PR 创建 10-27，合入 11-03）。检视獭初轮 + 两轮
delta 均「三处一致即过」，把「编号锚点齐」当成了「编号合规」。若非搭档人
眼，squash 合入后 main 历史永久停在创建日（squash 标题即 main 历史，事后
不可改）。检视獭自认失职并撤回 delta 通过（review 5746896476），重打为
F20261103bsrmx 后复检通过合入。

## 根因

规则**存在**但**只活在 F20260914prdb 特性文档里**（docs/features/2026/09/14/
F20260914prdb-pr-date-base.md:16-18，「创建 PR 用创建日 ID → 审视闭环后定稿
统一改名合入日 → squash 合入」），三个执行面全没接住：

| 执行面 | 现状 | 缺口 |
|---|---|---|
| 检视 B4（review-dimensions.md） | 只查「三处一致」 | 不查「日期=合入日」 |
| 终审清单（review-protocol 步骤 5） | 有发现处置表/base 落后核对 | 无定稿编号核对项 |
| docs 成文 | F20260914prdb:51 指向 commit-convention.md 成文 | 定稿改名规则未写入任何常驻成文面（commit-convention.md 存在但零命中，docs/README.md 原无此节） |

检视獭读的是 skill，不是特性文档史——规则不进执行面就等于不存在。

## 变更（三处堵口）

1. **B4 检查项**（review-dimensions.md）：补定稿日期顺延检查——跨日 PR 未
   顺延 = 建议发现，打回改名后合入；附 #1660 现场三要素（错误现象/后果/定位）。
2. **终审清单**（review-protocol SKILL.md 步骤 5）：呈终审前核对定稿编号，
   当天日期 ≠ 编号日期 → 顺延三处同改再呈终审。
3. **docs 成文**（docs/README.md 路径格式节）：补定稿改名规程成文节（规程
   定型于 F20260914prdb，含文档随迁与 CI edited 双基准说明）。

## 设计取舍

- **建议级而非严重级**：编号不一致（锚点断裂）是 B4 严重项；日期未顺延是
  定稿时序问题——发现即可打回改名，无信息损失，建议级 + 打回合入足够。不
  设为严重是为避免当日 PR 误伤（天然满足，无需改名）。
- **三处都堵而非单点**：检视侧（B4）与终审侧（呈终审前核对）互为双保险；
  docs 成文让规则可被独立发现（新人/新獭不依赖翻特性文档史）。
- **成文进 docs/README.md 而非扩展 commit-convention.md**：commit-convention.md
  实际存在（code-implementation/references，FID 格式规则活载体，10-28 #1668
  刚改过），但定稿改名规则 50 天从未写入——本 PR 选择成文于 docs/README.md
  （管文档 ID 路径迁移的属地）；是否同步扩展 commit-convention.md 留搭档决定。
- **残余窗口披露**：两处检查点均锚在呈终审时刻，搭档隔日拍板/合入时编号
  又落昨日（#1660 同型损伤可在「检查全过」后复发）——规则本体固有窗口。
  处置：review-protocol 终审段补「简报后续事项提示」义务——呈终审后未
  即时合入时，终审简报必须显式提示搭档合入前重核编号日期。不彻底消除
  （合入与呈审同刻才零窗口），残余靠简报提示 + 搭档合入动作覆盖——
  prompt 层能触达的最后一点是简报。

## Verification

- 变更内容：3 文件规则文案（skill×2 + docs×1），`git show --stat` 可复验
- CI：本 PR checks 四绿为合入前置
- Golden Gate: n/a（verify_by=human_judge——规则文案改动，效果为未来检视/
  终审行为约束，无 static 场景可跑）

## 后续事项

- 是否同步扩展 commit-convention.md（写入定稿改名节）→ 呈搭档决定（默认不扩，见取舍；文件已存在并承载 FID 格式规则，S1 订正后口径）
