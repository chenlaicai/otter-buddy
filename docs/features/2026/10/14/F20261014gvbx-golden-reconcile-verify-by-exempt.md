---
id: F20261014gvbx
title: "golden 执行对账 verify_by 豁免——static_only/capability_test 类软代码 PR 不计缺记录"
summary: "每日体检 P0-c 的 golden 执行对账按路径筛软代码 PR 但不按 verify_by 类型豁免，verify_by=static_only 的 PR（如 #1404）被系统性误判「缺记录」（issue #1419）。本特性在 daily-health-check.md 对账段补 verify_by 豁免规则：特性文档 intent.verify_by.type ∈ {static_only, capability_test} 的 PR 判「豁免」并日报标注，不计缺记录；verify_by 未声明者不豁免（lint-intent 缺声明拦截是上游闸门）。"
change_type: prompt
capability_test: "n/a: 改动为 daily-health-check.md 对账规则文案（prompt 层流程约定），无可执行 LLM 行为断言面——行为验证 = 次日每日体检对账段按新口径执行（static_only PR 标注豁免而非开 issue），由 issue #1419 验证断言到期回查（2026-11-09）"
created_in_conversation: a9260c50-cef6-412e-a0b4-282287a13103
causal_links:
  - "F20260825evgl"
modules:
  - prompts/scheduled/daily-health-check.md
tags:
  - daily-review
  - golden
  - verify_by
  - prompt
created_at: "2026-10-14T10:25:00+08:00"
intent:
  problem: "golden 执行对账（daily-health-check.md P0-c）口径错位：按路径（modules 含 prompts//.pi/）筛近 24h 合入软代码 PR × golden-results.jsonl 对账，不按 verify_by 类型筛——verify_by=static_only 的 PR 按 F20260825evgl 分层设计本来就不要求 golden 落账，却被系统性判「缺记录」开 issue（#1419 即 #1404 PR 的误报实例）。"
  expected_effect: "对账口径与 verify_by 分层设计对齐：static_only/capability_test 类 PR 判「豁免」并日报标注留痕，不再误报缺记录；真正缺记录的 PR（golden_replay/metric_probe/behavior_check/human_judge 类无记录者）仍被对账抓住。30 天验证断言：豁免后同类误报 issue 零新增。"
  verify_by:
    type: static_only
    rationale: "prompt 层规则文案修改，验证靠次日每日体检实际执行口径 + issue #1419 验证断言到期回查"
---

# golden 执行对账 verify_by 豁免

## 排查结论（troubleshooting，issue #1419）

### 预注册

- 预期根因方向：对账口径错位——对账按路径筛 PR 但不按 verify_by 类型豁免，static_only PR 被系统性误判「缺记录」
- 验证标准：#1404 特性文档 verify_by.type=static_only，且 daily-health-check.md 对账段无 verify_by 豁免逻辑
- 反例方向：若 golden-results.jsonl 在 10/8 后其实有对应落账、或对账段已有豁免但未生效，则放弃口径错位说

### 证据链

1. **#1404 特性文档**（docs/features/2026/10/09/F20261009fpeq-form-parity-agent-side.md frontmatter）：`intent.verify_by.type: static_only`——按设计不要求 golden 落账，且 capability_test 字段含 golden 豁免声明（沿 #1318/#1377 先例）
2. **对账段口径**（prompts/scheduled/daily-health-check.md L101，修复前）：「筛 modules 含 prompts//.pi/」——按路径筛，无 verify_by 豁免逻辑
3. **golden-results.jsonl**：10/8 后有 selftest 批次落账（10/12 批次实测），但无 #1404 关联记录——与 static_only 声明一致，属「按设计不落账」而非「漏跑」
4. **issue 评论**（#1419 comment，2026-10-10）：搭档处置时已定位同根因并建议本修复方向（豁免 static_only/capability_test）

### 预期 vs 实际对照

预期命中：证据 1+2 证实口径错位，证据 3 排除反例方向 Z（jsonl 有落账但与本 PR 无关）。

### 修法决策树

选 **① 既有机制语义内修**：对账机制（每日体检 prompt 规则段）已存在，缺的只是豁免口径——补一句豁免规则即对齐 verify_by 分层设计（F20260825evgl），不新增机制。

机制识别检查点逐项未命中：无新配置字段/状态生命周期/定时任务/信号类型/持久化存储/持久决策分支/跨模块调用——纯 prompt 文案补豁免规则。命中清单但不涉净新增机制论证：n/a（全部未命中，默认①②③）。

### 已排除路径

- issue 原列方案 1（合入事件自动评论提醒 + 24h 升级 issue）：成本高且不治本——static_only PR 仍会被提醒轰炸
- issue 原列方案 2（main push 触发 golden 全量跑）：成本最高，且 static_only PR 无场景可跑，跑了也是空转
- 排除理由（搭档评论同判断）：先修口径再谈加强，否则 static_only 类 PR 永远在对账里报缺

## 改动

prompts/scheduled/daily-health-check.md 对账段追加「verify_by 豁免」小节：

- 对账前读 PR 对应特性文档 frontmatter `intent.verify_by.type`
- ∈ {static_only, human_judge} → 不产生 golden 记录（静态检查/人工观察即验证面，无自动断言面），判「豁免」，日报标注「豁免：#<PR> (<type>)」，不计缺记录
- capability_test/golden_replay → 按 F20260825evgl 分层设计应落账，不豁免
- frontmatter 缺 verify_by 声明 → 不豁免（lint-intent 缺声明拦截是上游闸门），照判缺记录

## Delta（round1 检视处置，PR #1477）

round1 检视（检视獭-1477，kimi-k28）抓 3 严重/2 建议，全部采纳处置：

1. **严重 1（已修）**：压缩误删 `2. **GitHub issues / PRs**` 的空格，撞破纪律锁测试 `tests/usecases/scheduler/daily-health-check-prompt-discipline.test.ts:41` 正则——还回空格，本地 7/7 通过。教训：该文件存量措辞压缩前须先跑 discipline 测试，pre-commit 的 npm run check 不含此测试导致首轮自报「通过」不实
2. **严重 2（已修）**：豁免集合初版写 {static_only, capability_test}，方向反了——按 F20260825evgl 分层表，不产生 golden 记录的是 {static_only, human_judge}（human_judge=人工观察无自动断言面）；capability_test 语义是「跑 capability/golden 套件采样断言」=应产生记录。已改豁免集合为 {static_only, human_judge}
3. **严重 3（已处置）**：与 PR #1413（同改 daily-health-check.md，budget 9600→10700）撞车——仲裁结论：#1413 先合入，本 PR 后合入并负责 rebase 处置 budget 冲突（压缩后的文本可自然吸收 +1100B 增量，#1413 合入后本 PR 的体积出清压力解除）
4. **建议 4（已修）**：sqlite3 前置纪律行与列表间恢复空行，可读性还原
5. **建议 5（已修）**：锚点抽查段「read 打开对应文件行核对」恢复「打开」二字消歧

## 影响范围

- 行为面：次日及以后每日体检 golden 对账段执行口径变化——static_only/capability_test PR 不再开「缺记录」issue
- 覆盖损失评估：golden_replay 类 PR 缺记录仍会被抓（lint-intent.mjs:336 已有 golden_replay 弱核对做第一道闸，对账是第二道）；static_only PR 的验证面本来就由静态检查承担，豁免不损覆盖
- 失败固化（步骤 5a）：豁免理由——本改动为 prompt 规则文案，「失败证据」即 issue #1419 本体（误报实例）+ 本文档证据链；无可测断言面（LLM 流程执行不可单测），行为验证走 issue 验证断言到期回查

## 验证

- lint：`node scripts/lint-intent.mjs`（本文档 intent 块合规自检）
- 行为验证：次日每日体检对账段按新口径执行（static_only PR 标注豁免而非开 issue）
- 到期回查：issue #1419 验证断言（2026-11-09 到期，口径改为「豁免留痕或记录 ≥80%」）
