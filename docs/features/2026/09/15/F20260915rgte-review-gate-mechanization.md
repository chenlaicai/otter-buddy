---
id: F20260915rgte
title: 审视闭环机械化身：review state 闸门 + main 分支保护
summary: 修复 #824——检视 review 全为 COMMENTED state（GitHub 机械层不挡合并）且 main 分支保护未开 required reviews，审视闭环纯靠 prompt 纪律（跳环率 8 月 20%→9 月 28%）。修复：检视獭 review 按结论带 state（严重→request-changes / delta 通过→approve / 初轮仅建议→comment）+ 两检视 skill 体检（3 个真实缺陷已修）。分支保护 required reviews 曾开启，r2 实证 GitHub 拒绝 self-approval（同账号下无人能发 APPROVE），经搭档 9/15 决策「海獭与搭档对外一体、不追求 GitHub 独立身份」后回滚——机械层不设闸，state 留痕保留作可见性，防线回归流程纪律（#941 按决策关闭）。
type: feature
status: development
created: 2026-09-15
created_in_conversation: c2f347c6-7e59-4e2e-ab48-10f64a5a1258
modules: [review-protocol, adversarial-review, github-branch-protection]
closes_issue: 824
intent:
  goal: 把审视闭环从「对话自觉」升级为「GitHub 机械层强制」，消灭带病合入的溜缝空间
  why: 8 月 20% → 9 月 28% 的跳环率证明纯 prompt 纪律不可靠；检视 review 全是 COMMENTED 不挡合并、main 分支保护未开 required reviews，机械层零感知
  non_goals:
    - 不解决「同账号自 approve」谎报（根治需 GitHub App 独立身份，本特性登记为后续项）
    - 不改变审视报告的内容结构与发现分级标准（那是 adversarial-review 的职责）
---

# 审视闭环机械化身：review state 闸门 + main 分支保护

## 目标

1. 检视獭的 PR review 按结论携带正确 state：严重发现 → `REQUEST_CHANGES`；delta 复核通过 → `APPROVE`；中间态（初轮建议发现待处置）→ `COMMENT`
2. main 分支保护开启 `required_pull_request_reviews`（required_approving_review_count=1）+ `dismiss_stale_reviews=true`——回修推新 commit 后旧 approval 自动作废，机械强制 delta 复核
3. 全身体检 adversarial-review / review-protocol 两个 skill，修复发现的缺陷

## 背景与根因（#824）

- 现场证据：近 5 个已合 PR（#935/#933/#914/#938/#936）的 review state **全部为 COMMENTED**（gh api 实证），GitHub 机械层无法区分「检视通过」与「未检视」
- main 分支保护现状（gh api 实证）：`required_status_checks` 只查 CI（check context），**无 required_pull_request_reviews 节**——无 APPROVE 也能合并
- 跳环率（#678 铁案）：8 月 20% → 9 月 28%（281 个有留痕 PR 全量统计）
- 搭档 9/6 指令：「优先分析根因，做事前措施」；9/15 拍板：「ok 你来做」+ 附加要求体检检视 skill 缺陷

## 方案设计

### 改动 1：adversarial-review skill 步骤 6a

review state 决策表：

| 检视结论 | gh 命令 | 语义 |
|---|---|---|
| 有严重发现（任何轮次） | `gh pr review <PR> --request-changes --body-file <f>` | 机械挡合并 |
| delta 复核通过（无严重发现未处置） | `gh pr review <PR> --approve --body-file <f>` | 闸门打开 |
| 仅建议发现、待作者处置（初轮） | `gh pr review <PR> --comment --body-file <f>` | 中间态，不挡不放的悬置 |

### 改动 2：review-protocol skill A 节步骤 1

systemPrompt 要求清单补充：检视獭必须按 review state 决策表留痕（而非一律 --comment）。

### 改动 3：main 分支保护（一次性配置，不占 PR）

```bash
gh api repos/chenlaicai/otter-buddy/branches/main/protection -X PUT \
  --input <(现有保护配置 + required_pull_request_reviews 节)
```

参数：`required_approving_review_count=1`、`dismiss_stale_reviews=true`、`require_code_owner_reviews=false`（无 CODEOWNERS 文件）。保留既有 required_status_checks（strict + check context）与 enforce_admins。

### 改动 4：skill 全身体检发现修复（见「体检发现」节）

## 体检发现（本次同步修复）

| # | 缺陷 | 位置 | 处置 |
|---|---|---|---|
| D1 | review 留痕一律 `--comment`，无 state 决策——检视结论机械层不可见（本特性根因） | adversarial-review 步骤 6a | 改决策表 |
| D2 | 产出模板两处「审查结论」枚举（`需要修改`/`存在以下问题（决策者判断）`）缺「通过」表述——delta 复核通过场景无标准措辞，与 APPROVE state 无对应文案 | adversarial-review 两个模板 | 补「**通过（delta 复核）**」枚举，并注明与 review state 的对应关系 |
| D3 | review-protocol A 节步骤 1 systemPrompt 要求清单未提 review state 要求——编排层不传达，检视獭不知道要带 state | review-protocol A 节步骤 1 | 补一条要求 |
| — | （审计范围说明，非缺陷发现）体检其余维度（报告模板完整性、禁用语、决策树引用、行动权路由表、文档审视路径、delta 材料清单）：无缺陷，审计通过 | — | 无需改动 |

### 体检范围说明

全量通读：adversarial-review/SKILL.md（含触发/工作流/产出模板/禁用语/路由表）、review-protocol/SKILL.md（A/B 两协议）。adversarial-review/references/ 下 4 个文件（review-dimensions/anti-patterns/review-loop/author-response-protocol）本次未全量审读——若本次改动与其中内容冲突，检视獭会在审视中发现，届时处置。

## 影响范围

- 文档：`.pi/skills/adversarial-review/SKILL.md`、`.pi/skills/review-protocol/SKILL.md`、本特性文档
- 配置：main 分支保护（一次性 gh api，不动 git 追踪文件）
- 行为变化：**此后所有 PR 无 APPROVE 不可合并**——包括搭档自己的 PR 和紧急修复。回修推新 commit 后旧 approval 作废，必须 delta 复核重新 approve

## 取舍

| 取舍 | 选择 | 理由 |
|---|---|---|
| required_approving_review_count | 1 | 单检视獭流程现状的机械映射；>1 无对应流程 |
| dismiss_stale_reviews | true | 机械强制「修复≠签收」（#213 铁律），这是本特性的核心收益 |
| require_code_owner_reviews | false | 仓库无 CODEOWNERS，开启会无人能合 |
| 同账号自 approve 谎报 | 不防，登记后续 | 根治需 GitHub App 独立身份，投入大；当前靠日报盯 + 纪律，接受 |
| enforce_admins | 保持 true | 现状已是 true（管理员也受保护约束），不降级安全水位 |

## 已知限制

- **同账号谎报**：开发獭与检视獭共用 chenlaicai 账号，「开发獭自己 approve 自己」机械层不可辨。缓解：每日健康检查可扫「PR author == review author == 唯一账号」恒真无判别力，实际防线是流程纪律 + 大獭编排层不省略检视环节。根治路径：GitHub App 独立身份（#941 跟踪）。
- **同账号硬边界（r2 实证 + 搭档终裁）**：GitHub 原生拒绝 self-approval——单一账号下没有任何獭能发出 APPROVE，required reviews 闸门完全失灵。搭档 9/15 终裁不追求独立身份（「海獭和我是一体的」），required reviews 已回滚。state 决策表保留：REQUEST_CHANGES/COMMENTED 物理可达，APPROVE 仅在未来有多账号环境时生效——届时无需改 skill，直接可用。
- **紧急修复 friction**：无 APPROVE 不可合，包括 hotfix。接受——这正是目的（跳环率 28% 的代价远大于多一道检视的 friction）。

## 验证

1. skill 改动：lint（skill lint）通过；检视獭审视本 PR 时按新决策表留痕（自检：本 PR 自己的 review 应带 APPROVE/REQUEST_CHANGES 而非 COMMENT）
2. 分支保护：配置后 `gh api repos/chenlaicai/otter-buddy/branches/main/protection` 回读验证 required_pull_request_reviews 节存在且参数正确
3. 端到端：本 PR 合入即依赖分支保护生效（先配保护 → 本 PR 需 APPROVE 才能合，自证机制运转）

## 回滚

- 分支保护：`gh api .../required_pull_request_reviews -X DELETE` 一键回退
- skill 改动：git revert

## 决策史

- 2026-09-06 搭档质疑检视有效性并下「事前措施」指令（对话 1b7e2db3）
- 2026-09-06 根因分析完成 + 方案设计完成，呈报后悬置（#824 开 issue 跟踪）
- 2026-09-15 搭档拍板「ok 你来做」+ 附加 skill 体检要求（本对话）
- 2026-09-15 r2 delta 复核通过（检视獭-940d，mimo），但实证 GitHub 拒绝 self-approval——同账号下 APPROVE 无人能发，闸门实际由搭档手动合并承担（见已知限制）
- 2026-09-15 **搭档终裁**：「海獭和我是一体的（对外），不要卡 github 不同账号 approve 这一点」——required reviews 仓库层回滚（gh api 实证 reviews:null，CI check 保留）；#941（GitHub App 独立身份）按决策关闭；skill 决策表保留（state 留痕仍有价值：检视结论机械可见，REQUEST_CHANGES/COMMENTED 可正常发，仅 APPROVE 物理不可达）
