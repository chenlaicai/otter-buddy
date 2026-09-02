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

## 对抗审视处置（glm-flash，4 严重 3 建议）

| # | 发现 | 处置 |
|---|---|---|
| S1 | 分支落后 main（freshness gate 红灯） | rebase 到 60245cc8 |
| S2 | CI `\|\| true` 吞退出码 + EMBEDDING_ENABLED 幽灵变量 + 跑全 suite 非 selftest-only | 重写：删 `\|\| true`（退出码交给 vitest）；删幽灵变量；bge-m3 缓存下载（boot 禁降级，无锚点推测 → 实测路径 a+缓存）；OTTER_TEST_LLM_API_KEY 置空 → boot 检测无 key → 采样 skip + selftest 全跑（runner L243 语义） |
| S3 | 出生证明未兑现（results.jsonl 不存在） | 本地真跑全场景：r4-summon 3/3、yield-handoff 3/3、talking-stone 3/3（passed=true 落盘 pr:712）；seriousness manualReview 采样信号 structuredSignal=true structuredTool=true，检视判定 pass |
| S4 | lint 打印分母错（4/394=44% 自相矛盾） | 打印分母改 intent 存在数：4/9=44% |

## 出生证明跑出来的三个场景层真缺陷（顺带修复）

1. **talking-stone 查错表**：assert 查 conversation_otters（建会话初始名单表），但 create_otter 的 join 链路写 conversation_participants（manage-participant.ts）——生产路径永不命中；selftest 自插旧表所以绿灯（构造/生产分叉）。修复：assert + selftest 构造同改 conversation_participants（joined_at_turn_id 取真实 turn 过 FK 约束）
2. **runner 多跳等待缺口**：runOneSample 只等第一跳 completed，链引擎派发的第二 hop（小獭回合 30-60s）永远等不到。源测试用 afterSeq 两段式，golden 漏抄。修复：settle 窗口（首终态后每 5s 探测，终态数两轮不动或 180s 上限）
3. **seriousness input 残缺**：只发闲聊半段「今天天气怎么样」，漏了「严肃点」触发轮——等于没测。修复：input 直发「严肃点。我想分析一下这个项目的目录结构。」，assert 补源测试同款 structuredSignal 信号词

三处均为测试代码修复，未触碰任何生产路径。

## 机制首次真实运行读数（2026-09-02）

- 首跑 2 场景 fail（r4 1/3、talking-stone 0/3）→ 复跑 3/3 全过：申诉规则（fail 复跑一次）的统计设计首次实战验证（r4 首跑 1/3 属 p≈0.7 的正常波动；talking-stone 0/3 是场景缺陷非行为回归）
- manualReview 场景的采样信号 detail 已进 MANUAL_REVIEW 控制台输出（检视判定有据可查）
- results.jsonl 落盘主仓 data/metrics/（记录链修通验证）
