---
id: F20261106gtagl
title: 闸门口径统一：Modification-Class 词表闸 + B4 单一真相源 + delta 轮不豁免
summary: "#1782 复盘落地（每日补丁清单 🔴 + kimi-lty 异体讨论定案 A+B′）：三套「机制」定义分裂（B4 五类重资产 / troubleshooting 七项清单 / 预算软维度）+ delta 整改轮未执行既有 B4 检查 + 声明值无机械校验，导致 RETIRED_RULE_IDS 封存账（新枚举，命中机制识别清单）随 delta r1 零检查上线——同 PR 的 upstreamIsMainPidFile 为纯运行时 helper，七项清单不命中，非机制。修法：① commit-msg 词表闸（五值硬拦，卫生闸定位）② B4 机制判定改引 troubleshooting 七项清单为唯一真相源，删五类窄口径 ③ delta 协议明确「不重开范围≠豁免 B4」④ 补答 #1782 S2 封存账机制预算四问（F20261105killa 欠账，历史文档不可变故落本文档）。"
change_type: prompt
capability_test: "tests/githooks/commit-msg-modclass.test.ts"
intent:
  problem: "三套「机制」定义分裂 + delta 整改轮未执行既有 B4 检查 + Modification-Class 声明值无机械校验——新机制可随整改 diff 零检查上线（#1782 实证）"
  expected_effect: "声明值词表外在提交时被机械拦截；B4 机制判定统一以 troubleshooting 七项清单为唯一真相源；delta 轮修复 diff 净新增机制面时必须改声明+补四问，否则按严重发现处置"
  verify_by:
    type: behavior_check
created_in_conversation: 3241317b-99d6-4d78-9248-ff208a7461bc
causal_links:
  - F20260908pgrd
  - F20261105killa
tags:
  - skills
  - guard
  - ci
modules:
  - .githooks/commit-msg
  - .pi/skills/adversarial-review/SKILL.md
  - .pi/skills/adversarial-review/references/review-loop.md
  - tests/githooks/commit-msg-modclass.test.ts
---

# 闸门口径统一（#1782 复盘落地）

## 这是什么事

2026-11-05 PR #1782（kill 守卫政策 A）delta 整改轮落入 RETIRED_RULE_IDS 封存账（新枚举，命中机制识别清单，无机制预算四问——本复盘标的）；同 diff 的 upstreamIsMainPidFile 为同模块纯函数 helper（纯运行时分支，七项清单排除条款明确不命中，属既有语义内修，r1 审视订正本复盘初稿的「两个新机制」合并口径），commit 声明值「bugfix」不在五值词表，全程零拦截。11-06 晨间补丁清单（F20260908pgrd 提案 2）判 🔴，经 kimi-lty 异体讨论（两处归因事实修正：S1/S2 是严重发现非建议；B4「每次必查」条款存在但 delta 轮未执行）收敛方案 A+B′，搭档 09:17 拍板开工。

## 根因（讨论修正后定案）

1. **闸在但没执行**：B4 声明一致性条款存在（adversarial-review SKILL），delta r1 只复核修复点未执行 B4——执行收窄，非规则缺失
2. **三套机制定义分裂**：B4 五类重资产口径 vs troubleshooting 七项识别清单 vs 机制预算软维度——封存账（常量集）在窄口径下合法放行
3. **严重发现义务盖过分类讨论**：S2（封存账）处置标「本 PR 修复」，修复正当性与「是否净新增机制」的分类判断不在同一时刻发生；S1（helper）同理走修复义务，但本就无分类争议
4. **词表无机械校验**：「bugfix」词表外值全流程无人拦（历史自造值 30+ 种）

## 变更清单

| 文件 | 操作 | 说明 |
|---|---|---|
| `.githooks/commit-msg` | M | 方案 A 词表闸：声明值 ∉ 五值词表即拒提交；行内匹配容忍括号注释形态（取首 token）；无声明行放行（存在性归 B4 异体审） |
| `.pi/skills/adversarial-review/SKILL.md` | M | B′-1：B4 机制判定改为引用 troubleshooting 机制识别检查点七项清单（唯一真相源），删五类重资产窄口径；声明词表外值 = 严重发现；命中清单但无「为何不是净新增机制」论证 = 严重发现；「每轮必查，含 delta 轮」 |
| `.pi/skills/adversarial-review/references/review-loop.md` | M | B′-2：delta 审视职责新增第 3 条——B4 声明一致性不豁免，修复 diff 净新增机制面须改声明+补四问；原 3/4 条顺延为 4/5 |
| `tests/githooks/commit-msg-modclass.test.ts` | A | 元测试：行为验收（接受/拒绝/无声明放行）+ hook↔skill 词表镜像一致性（防单侧漂移） |
| 本文档 | A | 含 S2 封存账四问补答（见下） |

## 设计取舍（mechanism-addition 四问——本 PR 新增词表闸机制）

> 本 PR 自身命中机制识别清单（新增校验规则 = 新决策分支，其结果被 commit 拒绝行为记住），声明 mechanism-addition，四问当场作答：

1. **谁需要它**：作者（提交时强制对表选值，消灭 30+ 种自造值）+ 检视者（B4 语义一致性核对有了机械前置，只处理「值合法但分类错」的残余面）+ 每日回看（补丁清单 🔴 判定的机械证据源——词表外值从此在提交时留痕拦截，不再依赖事后发现）。
2. **失败会怎样**：闸失效形态 = `--no-verify` 绕过或 hook 未安装 → 退化到现状（B4 异体审兜底，不劣于改动前）；误拦形态 = 词表过窄拦住合法值 → 作者受阻即反馈，词表开放修订（五值对应修法决策树，树不变词表不变）。fail-open 边界（非标形态不触发闸）是设计选择：误拦正常提交的成本 > 漏拦非标形态（后者仍有 B4 兜底）。
3. **后续机制预测**：无直接后继——本闸是校验层不是流程层。可能衍生：commit 级检查不够时升 PR 级声明一致性 CI 检查；出现该需求时优先评估是否 hook 覆盖面问题而非新机制。
4. **退役条件**：Modification-Class 声明制度本身废止（F20260908pgrd 机制退役）时本闸随之拆除；或校验迁移到 CI 层时删 hook 段。元测试同步退役。

**为何不是 narrow-fix**：新增提交拒绝分支 + 新测试文件，非既有校验语义内修——按本 PR 统一后的 B4 口径如实归 mechanism-addition。

### R8.5 机制提案准入三问（r1 发现4 补答）

1. **决策者变了么**：没变。词表闸拦截的是「声明值不合法」这个事实判断，不改变任何决策归属——修法选择仍归作者（修法决策树）、分类正确性仍归检视者（B4 异体审）、机制预算仍归特性文档四问。闸只是把「词表外自造值」的信息成本从事后回看提前到提交时。
2. **靠自觉还是靠守卫**：靠守卫。本 PR 的 A 项就是机械闸（hook 拒提交 + 元测试锁镜像一致性）；B′ 两项是协议文本（半机械+异体审——B4 每轮必查是检视者义务，非机器可判），不假称全自动。
3. **深潜成本降了吗**：降了。#1782 复盘花了三轮对话才拼齐「声明值非法→delta 轮未执行 B4→口径分裂」的证据链；统一后 B4 单一真相源 + 词表机械拦，同类问题在提交时或初轮审视即暴露，搭档深潜路径从「翻三轮 review 记录」缩到「看 hook 报错/特性文档四问段」。

**P0 负面清单命中判定**：未命中。本机制不替人盯（每日回看仍独立运转）、不替人审（B4 仍异体）、不限产出、不自动跳过、无智能预审——词表闸是「声明纪律的机械存在性检查」，P0 四条共性（挤占决策归属）均不沾。

## S2 封存账机制预算四问补答（补 F20261105killa 欠账）

> #1782 的 S2 处置新增 RETIRED_RULE_IDS（guard-intercept-classify.ts，退役规则封存账）未答四问。F20261105killa 已在 main（历史文档不可变铁律），补答落此并因果回链。检视建议驱动的整改同样过预算——这正是本次闸门口径统一的标的。

1. **谁需要它**：classify 兜底归因（37 条存量 healing 事件回溯归因链不断——退役规则名仍出现在历史事件文案，无封存账则归因到「未知规则」桶）；月度 guard-intercept 回报读者（退役规则族在历史数据中仍可见，呈报需口径）。
2. **失败会怎样**：封存账缺失/失准 → 存量事件归因错桶，月度清点误导；封存账滥用（塞入未真退役的规则）→ 活规则被静默豁免，拦截面缩水无人知——后者是更危险的失败向，B4 七项清单（「新枚举」命中）+ 本次 delta 不豁免条款为其上闸。
3. **后续机制预测**：每次规则退役都须手动补封存账——若 6 个月内规则退役高频化，可能催生「退役事前申报机制」；出现该苗头 = 本账自身服从生成回路的信号，届时重估（候选替代：事件落库时快照规则名，归因不依赖运行时清单）。
4. **退役条件**：封存账内全部规则的事件 age-out（超出 healing 保留期）且月度呈报不再出现该规则族名 → 清空删除；或归因改走事件落库快照方案 → 整个封存账机制可删（deletion 路径）。

## 验证证据

- 元测试 21 用例全绿（`npx vitest run tests/githooks/commit-msg-modclass.test.ts`：接受 11 / 拒绝 8 / 无声明放行 1 / 镜像一致性 1）
- 手工边界验证：空值声明（`Modification-Class:` 裸行）正确拦截；非标形态（冒号前空格）放行且注释标注 fail-open 设计理由
- 全量 hook 回归：`tests/githooks/commit-msg-fid.test.ts` 不受影响（词表段在日期校验后、互不干扰）

## 预期 vs 实际对照（修法决策树）

预注册预期：方案 A+B′ 纯增量落地，无迁移/兼容面。实际符合——hook 追加段、SKILL 替换段、review-loop 插条与顺延，无意外发现。

## 测试改动声明

- 新增 `tests/githooks/commit-msg-modclass.test.ts`：词表闸行为 + 镜像一致性元测试
- 无既有测试修改

🤖 Generated with [Otter Buddy](https://github.com/chenlaicai/otter-buddy) by 大獭
