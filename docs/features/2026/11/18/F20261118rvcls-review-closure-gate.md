---
id: F20261118rvcls
title: 检视闭环机械闸——变更自动撤销检视证书
summary: |
  把「检视结论是对特定 commit 的证书」落成机械状态不变量：新增唯一判定器
  scripts/check-pr-review-closure.mjs（闭环谓词四条件），并被两道闸消费——merge_pr
  工具合入前 fail-closed 调用（后闸，物理拦截）+ CI pull_request 时可见检查（前闸）。
  断环①/②（实证 PR #1909：检视覆盖后 head 前移、alpha 修复未回检视）从「靠人发现」
  变为「push 即红、合入必拒」。检视报告模板固化「上轮处置确认」段作为判定器可解析输入。
change_type: feature
capability_test: "n/a: 判定器为纯函数单测（tests/scripts/check-pr-review-closure.test.ts）+ merge_pr 工具集成测试（tests/interface-adapters/agent-runtime/tools/merge-pr-tool.test.ts）；CI 闸为 workflow 声明式配置，无黄金轨迹可跑"
created_in_conversation: 3e928c99
causal_links:
  from:
    - F20261110ryrev   # yield 自动采集检视轮次（本闸依赖的检视派工 telemetry 底座）
  supersedes: []
tags: [review, review-loop, merge-gate, ci, mechanical-gate]
modules:
  - scripts/check-pr-review-closure.mjs
  - src/interface-adapters/agent-runtime/tools/tool-factory.ts
  - .github/workflows/ci.yml
  - .pi/skills/adversarial-review/SKILL.md
created_at: 2026-11-18
intent:
  problem: "检视通过后 head 又前移（新增修复 commit），新 head 静默继承旧证书直接合入——断环①/②（PR #1909 实证）靠人开 issue 才被发现，无机械闸兑底"
  expected_effect: "PR 当前 head 未持有有效独立检视通过回执时，merge_pr 合入被物理拒绝；CI pull_request 时判定器红，断环在呈拍板前即可见"
  verify_by:
    type: behavior_check
    bugfix_acceptance:
      - "判定器：head 前移无覆盖 → head_not_covered 拒绝；四条件齐备 → closed 放行"
      - "merge_pr：判定器 exit 1 → 拒绝合入不执行 gh pr merge；exit 0 → 正常合入"
      - "CI 闸：pull_request 事件跑判定器，断环时 check 红"
---

# 检视闭环机械闸——变更自动撤销检视证书

## 背景

issue #1911（P1）：搭档 11/18 观察「写代码 → 检视提出问题 → 全部分析和修改 → 复核」循环老有缺漏。实证 PR #1909 两处断环：

- 断环①：确认轮发现 minor-1（监听器累积），修复 commit 后未回检视直接进 alpha 验证；
- 断环②：alpha 实启发现 auth 策略/入口路径两问题，修复 commit 后未过检视眼直接呈拍板。

两处断环的共同形态：**检视 review 覆盖某 commit 后，head 又前移（新增修复 commit），新 head 没有任何 review 覆盖**。PR #1909 的循环最终靠 issue 立案后补的第三条「闭环复核」review 才闭合（11-18 00:49，覆盖 head `ece7fc88`）。

## 第一性原理与决策

三路异模型分析（deepseek / glm / kimi）收敛于同一结论：

> **检视结论是对特定 commit 的证书。任何 push（新 commit）都让被审对象更换，旧证书必须自动失效。断环的本质 = 新 head 静默继承了旧 head 的通过叙事——系统缺「变更 → 证书失效」的状态不变量。**

CI 绿/alpha 通过证明「代码健康」，不能证明「过程闭合」；「修复后必须传回复核」这条控制流全靠作者自述——系统对工件有「处置自述不作证据」铁律，唯独流程合规信任自述。

因此治本不是再加一条 prompt 纪律（协议层已完备，边际为零），而是**把「当前 head 是否持有有效独立检视通过回执」变成可机械判定的状态**，并让变更自动撤销旧回执。

## 方案

### 唯一判定器 `scripts/check-pr-review-closure.mjs`

闭环谓词四条件（机械锚点全部来自 `gh pr view --json headRefOid,reviews` 服务端数据）：

1. **head 覆盖**：存在 review 的 `commit.oid === headRefOid`（检视覆盖了当前版本）；
2. **通过语义**：覆盖回执含通过/闭环结论词，且不含「需要修改」（FAIL_RE 优先判定）；
3. **处置确认**：覆盖回执含「上轮处置确认」段或逐条处置核实语义（空段即断环）；
4. **审查者署名**：覆盖回执含审查者名号（`reviewer-` / `## 审查者` / 检视獭）——挡作者自己 post 一句 PASS 的 self-review。

退出码：0 闭环 / 1 断环 / 2 拒判（数据不足，fail-closed 同态）。

### 两道闸

- **后闸（merge_pr 工具）**：授权原话闸通过后、合入执行前，`checkReviewClosureOnPr` 调判定器 fail-closed——exit 1/2 均拒绝合入并回显缺口描述。这是合入点的物理拦截。
- **前闸（CI）**：`ci.yml` 在 pull_request 事件跑同一判定器（`GH_TOKEN: ${{ github.token }}`）——断环在呈拍板前即 check 红，不等到 merge_pr 才爆炸。

### 报告格式固化

`adversarial-review` SKILL 的三处报告模板加「## 上轮处置确认」段（delta 轮逐条列上轮发现 + 四类处置终态 + 证据；初轮写「无（首轮审阅）」）——这是判定器可解析的输入格式，是「如何满足闸」的操作说明，不是新增纪律检查项。

## 设计取舍

1. **独立检视证据强度（第一版）**：真证据是 yield 检视派工 trace（DB 侧），脚本拿不到。「审查者署名」是脚本能判的最硬代理——它挡得住「作者随手写 PASS」，但挡不住「检视獭署名被冒用」；署名真实性与回执语义真实由对抗审视 B9 抽样兜底（与 check-pr-evidence 同构：机械闸判结构，真实归检视獭 B9）。trace 强绑定作为后续加码，不在本版。
2. **前闸只做可见，不做 required status**：物理拦截已由 merge_pr 后闸承担；把 CI 闸设为 required 需要 GitHub 分支保护配置变更（仓库设置层，非代码）。前闸红灯 = 「未满足闸」，是机械闸正常形态（同 check-pr-evidence），不是坏。
3. **单账号环境 APPROVED 不可用**：判定器不依赖 GitHub review state（全 COMMENTED），靠正文结构化段 + commit.oid 覆盖判定，与既有「单账号降级 comment、结论词在正文首行」纪律同源。
4. **rebase 的严格性**：rebase 改 oid 会让旧回执 commit.oid ≠ 新 head，判定器判断环——这是「正确的严格」：rebase 本就是「检视通过后代码又变」，应重新检视，与 review-protocol「呈终审前确认 base 未落后、落后则 rebase 重验」同构。

## 机制识别判定

本改动命中机制识别检查点第 7 项「新跨模块调用路径」——merge_pr 工具新增对
`scripts/check-pr-review-closure.mjs` 的 fail-closed 调用，与授权原话闸并列构成合入
前置链；判定为净新增机制，声明值 `mechanism-addition`，机制预算四问答案见下。

## 机制四问

- **谁需要**：一切呈拍板/合入的代码 PR——合入点必须证明「当前版本被独立检视过」。
- **失败后果**：缺这道闸，检视通过后的一切小修（confirm 轮新增发现、alpha 实启修复）都可能跳过复核直接合入，断环重演（#1909 实证）。
- **后续机制**：CI 前闸从「可见」升级 required status（分支保护）；独立检视证据从「署名代理」升级「检视派工 trace 强绑定」。
- **退役条件**：当 GitHub 多账号环境接入使 APPROVED state 物理可用，且分支保护 required reviews 真正生效时，覆盖判定可退化由平台承担，本判定器可退役（判定器与 merge_pr 授权闸同构：平台能兜住就不再需要自家闸）。

## 变更清单

| 文件 | 类型 | 内容 |
|------|------|------|
| scripts/check-pr-review-closure.mjs | 新增 | 唯一判定器（纯函数 checkReviewClosure + gh 数据获取 + CLI） |
| tests/scripts/check-pr-review-closure.test.ts | 新增 | 判定器四条件 + 断环①②形态回归（10 例） |
| src/interface-adapters/agent-runtime/tools/tool-factory.ts | 修改 | merge_pr 工具加后闸 checkReviewClosureOnPr（fail-closed） |
| tests/interface-adapters/agent-runtime/tools/merge-pr-tool.test.ts | 修改 | stub 判定器调用 + 断环拒绝用例 |
| .github/workflows/ci.yml | 修改 | check job 加前闸 step（pull_request 跑判定器） |
| .pi/skills/adversarial-review/SKILL.md | 修改 | 三处报告模板加「上轮处置确认」段 |

## Rollback

Revert 本 PR 即回 main 现状：判定器脚本与测试为新增文件（删除即回）；tool-factory.ts 的闸为纯函数调用（删除调用点即回）；ci.yml step 删除即回；SKILL.md 模板段删除即回。无 schema 变更、无历史数据迁移。

## 证据分层声明（含机器锚点 / agent 陈述两层）

- **机器锚点**：commits 见 PR commits 页；`npm run check` / `npm test` 全绿（判定器 10 例 + merge_pr 工具 35 例 + 全量）；CI 四项见 PR checks。
- **agent 陈述**：判定器四条件均基于 gh 服务端字段（review.commit.oid / review.body），无作者自报输入；merge_pr 后闸 fail-closed（脚本 exit 非 0 一律拒绝，脚本崩溃同拒）。

## 测试改动声明（方向：收紧 + 理由）

全部为**新增测试**（10 例判定器 + 1 例 merge_pr 断环拒绝），零存量测试删改；merge_pr 现有测试仅扩展 stub 以覆盖新增的判定器调用（不改变既有断言语义）。「本机行为不变」由全量回归背书。
