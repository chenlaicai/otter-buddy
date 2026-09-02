---
id: F20260902gact
title: 评测机制激活方案 P0 实现
summary: 实现评测机制激活方案 v6.3 的 P0 部分，包括三路接线、记录链修通、声明率上墙
change_type: feature
created_in_conversation: 7370138e-632d-4292-9394-4f360c8b36bf
intent:
  problem: "评测机制 8/25 建成后零使用，病根最深一层是 intent 协议本身空心化（277 个文档仅 3 个 intent 块）"
  expected_effect: "P0 落地当日：CI golden selftest 独立入口绿灯；lint-intent 汇总输出分层声明率（存量 intent 存在率约 3% 可见）；golden gate 在本 PR 真实执行一次并落 results.jsonl 于主仓 data/metrics（机制出生证明）"
  verify_by:
    type: golden_replay
capability_test: tests/capability/golden/golden.runner.ts
modules:
  - .pi/skills/code-implementation
  - .pi/skills/adversarial-review
  - .github/pull_request_template.md
  - tests/capability/golden/golden.runner.ts
  - scripts/lint-intent.mjs
  - prompts/scheduled/daily-health-check.md
  - .github/workflows/ci.yml
---

# 评测机制激活方案 P0 实现

## 背景

评测机制 8/25 建成后零使用。病根最深一层：intent 协议本身空心化（277 个文档仅 3 个 intent 块，全是评测体系自己写的）。本方案不建新能力，把已有机制接进海獭必经之路（skill 步骤 + PR 模板 + CI + lint 增量硬卡点），修通记录链（results.jsonl 写主仓不写 worktree），judge 立项为独立评测原语，并设止损线防再次超前建设。

## 变更内容

### P0-a 三路接线 + 职责分离

1. **code-implementation SKILL.md**：
   - 新增 Golden Gate 自检步骤（软代码改动必须）
   - 新增 Intent 块生成步骤（软代码改动必须）
   - 新增 fail 处置闭环规则（复跑主体 = 实现者，三出口）

2. **adversarial-review SKILL.md**：
   - 新增 B6 维度：Intent 块存在性（软代码改动必须）
   - 新增 B7 维度：Golden Gate 记录（软代码改动必须）
   - 明确检视獭不重复跑 gate，只核验记录存在性 + fail 已处置

3. **PR 模板**：
   - Verification 节新增两项 checklist：
     - Intent 块存在（软代码改动必须）
     - Golden Gate 已跑且 fail 已处置（软代码改动必须）

### P0-b 记录链修通 + CI 通电

1. **golden.runner.ts**：
   - RESULTS_PATH 改为默认解析主仓根（git rev-parse --git-common-dir）
   - 新增 fail-fast 检查（写入目标不在主仓根下报错拒跑）
   - 新增 `passed` 三值字段：
     - 自动场景：passed = successes >= minSuccess
     - manualReview 行：passed = null（不参与零 fail 统计）
     - selftest 行：passed = selftestResult.passed

2. **CI 新增 golden-selftest job**：
   - 零 LLM 调用、不配置 LLM 端点
   - 应用仍需 boot 供 talking-stone selftest 的 db/app
   - 只跑 selftest 层（good/bad 参考序列校验）

### P0-c 声明率上墙

1. **lint-intent.mjs**：
   - 新增 `computeDeclarationStats` 函数
   - 输出分两层（intent 存在率 / verify_by 率）× 两口径（存量参考 / 本期判定）

2. **daily-health-check.md**：
   - 新增止损线检查章节
   - 检查项：intent 生成率、golden gate 执行记录、条件 3（效果外标）
   - 处置规则：止损线触发 → owner=大獭，daily-review 开 issue

## 验证

- [ ] `npm run lint` 通过
- [ ] `npm run build` 通过
- [ ] `npm test` 通过
- [ ] `npm run lint:intent` 输出声明率统计
- [ ] CI golden-selftest job 可运行（零 LLM）
- [ ] results.jsonl 写入主仓根 `data/metrics/golden-results.jsonl`
- [ ] PR 模板新增两项 checklist 可见

## 最简实现检查

已过最简检查：
- RESULTS_PATH 解析使用 git rev-parse --git-common-dir（仓库已有依赖）
- 声明率统计复用 lint-intent.mjs 现有框架（新增函数，不改结构）
- CI job 复用现有 vitest.capability.config.ts（新增 job，不改现有流程）

## 影响范围

- 技能文档：code-implementation、adversarial-review
- PR 模板：.github/pull_request_template.md
- 代码：golden.runner.ts、lint-intent.mjs
- CI：.github/workflows/ci.yml
- 定时任务：daily-health-check.md
