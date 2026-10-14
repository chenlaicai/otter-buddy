---
id: F20261014cwfu
title: F20261014cwsp 拆分交付：SYSTEM.md cwd 说明 + 命令形态相对路径扫改 + 引用约定
doc_type: feature
change_type: prompt
created: 2026-10-14
created_in_conversation: f3567df1-e24b-49cd-a020-cdb39572f853
summary: "PR #1480（cwd 统一工作区）合入后的配套拆分交付——SYSTEM.md 新增 R4.5 bash 工作目录语义段（休眠无状态提示激活重写）、prompt/skill 命令形态相对路径扫改、writing-skills 主仓文件引用约定。承载 issue #1481。"
status: implemented
capability_test: "n/a: 纯 prompt/skill 文档改动，无代码行为面；验收走 lint-prompt-anchors / lint-prompt-size / lint-skills 静态闸 + 主服务重启后首工作日观察"
causal_links:
  from:
    - F20261014cwsp
intent:
  problem: "F20261014cwsp 统一 cwd 到对话工作区后，注入面（SYSTEM.md/prompts/skills）中指向主仓的相对路径引用失效——命令形态（node scripts/*）会在工作区找不到文件静默失败，文档指针被 read 消费时落空。且 bash 无状态提示（BASH_STATELESS_SUFFIX）自 9/22 起休眠从未生效（S9），需以新语义激活。"
  expected_effect: "注入面命令形态相对路径清零；SYSTEM.md R4.5 告知獭 cwd=对话工作区语义；writing-skills 引用约定防新增回流"
  verify_by:
    type: human_judge
    reason: "prompt 文档改动无自动断言面；生效判据由主服务重启后首工作日人工观察（scheduled prompt 内 cd 前缀命令执行成功）+ daily-health-check 对账豁免集 {static_only, human_judge} 语义对齐"
---

## 背景

F20261014cwsp（PR #1480）实现层审视 round-1 S3 判「交付面 vs 方案 v10.1 偏差」：T4（SYSTEM.md 无状态提示）、命令形态相对路径扫改、lint-prompt-paths 护栏不在 PR 内且未声明拆分。拆分声明落档后由 issue #1481 跟踪，本特性是兑现。

## 改动清单

1. **SYSTEM.md 新增 R4.5「bash 工作目录」**：cwd=对话工作区 + cd 不跨命令保持 + 绝对路径写 worktree。T4 落地——原 BASH_STATELESS_SUFFIX 休眠（调用点缺参），此处以新语义激活（注入面无 F 编号，lint-prompt-anchors 管辖）。
2. **命令形态相对路径扫改**（17 处，round-1 审视实证补齐）：
   - prompts/scheduled：daily-health-check ×3（node scripts×2 + grep data/logs×1）、每日-issue-处理 ×1、daily-ai-radar ×3（绝对路径化 + 工作区相对口径标注 ×2）
   - .pi/skills：post-merge-cleanup（alpha.sh stop）、worktree-isolation（git worktree add 绝对路径 + alpha.sh + ID 查重 grep）、code-implementation（otter-buddy.sh + ID 查重 grep）、adversarial-review/references（git diff 路径限定 + 文档定位 grep）、code-implementation/references/commit-convention（ID 查重 grep）
3. **writing-skills 新增「主仓文件引用约定」**：命令形态/工具目标/文档指针三档规则——防新增回流的知识层护栏。
4. **daily-health-check.md 体积出清**：cd 前缀顶超 9600B 预算，止损线/golden 对账两段压缩表述出清（B8）。

## 审视处置

round-1（检视獭-followup · mimo-pro）：8 严重 2 建议——扫改不穷尽（12 处漏改补齐）、补档口径裁定（独立 F 文档，禁止回改已合入主文档）、R4.5 语义一致（补 _system 兜底与部署时序说明）、lint 降级裁定（第 ③ 条 lint-prompt-paths 拆独立跟踪，见下）、B8 体积出清、commit/PR body 措辞订正。

## 不目标

- 纯文档指针（「参考 xx 文档」给獭看的指引，不经工具消费）不逐条改——references/ 相对自身位置的指针安全；指向主仓的指针失效面接受（round-1 建议 2：skill 自身 references 安全，指向主仓的文档指针被 read 消费时失效——该面由獭绝对路径习惯兜底，不扫改）。
- lint-prompt-paths 机械闸不在本特性——round-1 裁定「视执行观察」不可接受，改为：观察期 = 主服务重启后 2 周，若注入面新增相对路径回流 ≥1 次则立项上闸（跟踪载体：healing 台账 guard_intercept 族 + daily-health-check 日报）。

## 部署时序

本特性随主服务 rebuild+重启生效（注入面在 session 启动时读取）。
