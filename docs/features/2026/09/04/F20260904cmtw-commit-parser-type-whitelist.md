---
id: F20260904cmtw
title: commit-parser 类型白名单与 hook/convention 三方对齐
summary: |
  Issue #671（并入 #425 三项建议）：health 域 commit-parser 类型白名单仅 3 种，
  与真相源 commit-convention.md/.githooks/commit-msg 的 5 种漂移（#427/#432 两次
  收口未同步 parser 侧）。实测近 200 commit 中 34 个 FID 可提取的真实特性 commit
  被误判 non_standard_format，changeType 分布失真。修复：白名单 5 种收口（常量
  生成正则防再漂移）+ FeatureUpdate 笔误归一化 + unrecognized_change_type 与
  non_standard_format 语义区分。误判 34→18：16 个（Refactor 11+Design 5）转合规，
  3 个未知类型显式归类，15 个真·缺类型段维持原口径。
change_type: fix
capability_test: "n/a: 纯正则与解析逻辑改动，无 LLM 参与行为；vitest 单测覆盖（commit-parser.test.ts）"
created_in_conversation: e9b71eec-679e-4380-947d-8e641c4b90d5
tags: [health, commit-parser, commit-convention, whitelist, drift]
modules:
  - src/usecases/health/commit-parser.ts
  - tests/usecases/health/commit-parser.test.ts
---

# commit-parser 类型白名单与 hook/convention 三方对齐

## 背景与需求

### 问题描述

commit 规范的类型白名单存在三处载体：真相源 `.pi/skills/code-implementation/references/commit-convention.md`
Type Tags 表、校验侧 `.githooks/commit-msg`、识别侧 `src/usecases/health/commit-parser.ts`。
历史收口轨迹：

- #427（F20260825cmhg）：hook 白名单 3 种补录至 5 种（改钩子方向，搭档拍板）
- #432（F20260825cdef）：commit-convention.md 删除 `Feature` 历史别名，文档收敛 5 种
- **parser 侧两次均未同步**——白名单停留在 3 种（`New Feature|BugFix|Feature Update`），
  即 #671 报告的漂移

实测影响（`git log -200`，199 条 commit 样本，修复前）：

- 34 个 FID 可提取的真实特性 commit 被误判 `non_standard_format`（isCompliant=false）
  —— Refactor×11、Design×5、`[Feature]`×1、`[Enhancement]`×1、`[Tests]`×1、
  两段式缺类型段×15
- changeType 分布失真：Refactor/Design 类 commit 在健康报告的 changeTypeDistribution
  中完全不可见；hotspot_imbalance 检测的 feature 计数亦受影响（detect-signals.ts:350）

### 语义决策点：`[Feature]` 简写的处理（派工时大獭留的判断题）

读 commit-convention.md 核实：Message Format 节明文——「`Feature` 为 `New Feature`
的历史别名，2026-08-25 起不再收录，存量提交见 #432」。**约定未改为简写**，故按派工
预案执行：parser 白名单对齐 hook 的 5 种，`[Feature]` 归 `unrecognized_change_type`
（与 `[Enhancement]`/`[Tests]` 同类处理，均不再误判 non_standard_format）。

## 方案设计

单文件改动 `src/usecases/health/commit-parser.ts`，四点：

1. **白名单收口为单一常量** `CHANGE_TYPE_WHITELIST`（5 种），正则类型段由它生成
   （`TYPE_PATTERN`）——消除「常量与正则两处字面量」的再漂移风险（#671 的根因正是
   两处维护失同步）
2. **FeatureUpdate 归一化**（#425 建议 2）：正则侧 `Feature ?Update` 兼容无空格笔误，
   解析侧 `normalizeChangeType` 归一为标准名 `Feature Update`，isCompliant=true。
   大小写敏感——`featureupdate` 不归一化，归 unrecognized_change_type
3. **skipReason 语义区分**（#425 发现 7）：新增 `STRUCTURED_TYPE_SEGMENT_REGEX`
   （捕获组结构与标准正则对齐：1=FID、2=module、3=类型任意值），三段结构完整但类型
   未识别 → `unrecognized_change_type`；缺类型段等纯格式问题 → 维持
   `non_standard_format`。unrecognized 时 module 一并提取（此前一律 null）
4. **白名单外类型不再产出 changeType**：`[Feature]`/`[Enhancement]`/`[Tests]` 的
   changeType=null（isCompliant=false 分支），下游 changeTypeDistribution 不再收录
   未定义类型

真相源不变：仍为 commit-convention.md + .githooks/commit-msg。hook 无法 import ts
（shell 环境），与 fid-format.ts 的元测试同步模式（tests/entities/document/fid-format.test.ts）
同理，本次以单测锁死 parser 白名单与 5 种类型的一致性。

## 存量影响（修复前后对比，同 199 条样本）

| 指标 | 修复前 | 修复后 |
|------|--------|--------|
| 合规 | 163/200 | 179/200 |
| FID 可提取但误判 | 34 | 18 |
| — Refactor/Design 误判 | 16 | 0（转合规） |
| — 未知类型（Feature/Enhancement/Tests） | 3 | 0（归 unrecognized_change_type） |
| — 两段式缺类型段 | 15 | 15（维持 non_standard_format） |

skipReason 分布（修复后）：unrecognized_change_type×3、non_standard_format×15、
research_document×3。

## 测试

`tests/usecases/health/commit-parser.test.ts` 新增 8 用例（存量 245 测试全过，
含 #667 字母表回归）：

- 白名单新类型 Refactor/Design 解析为合规（存量真实 commit 作样本）
- `[Feature]`/`[Enhancement]`/`[Tests]` → unrecognized_change_type（isCompliant=false、
  featureId/module 可提取、changeType=null）
- 缺类型段两段式 → 仍 non_standard_format（与新 skipReason 区分）
- `[FeatureUpdate]` 笔误 → 归一化 Feature Update 且合规
- `[featureupdate]` 大小写不匹配 → 不归一化，归 unrecognized_change_type

## 验证

- `npx vitest run tests/usecases/health/`：19 文件 245 测试全过
- `npx vitest run tests/entities/`：12 文件 212 测试全过（fid-format 契约无回归）
- `npx tsc --noEmit`：0 错误；`npx eslint`（两改动文件）：0 问题
- 存量对比实测：见上表（临时 vitest 脚本跑 `git log -200 --pretty=format:'%h|%s'`，
  修复前后各跑一次，脚本已删）
- **最简实现检查**：已过——单文件 + 白名单常量生成正则 + 一个探测正则 + 一个归一化
  函数，无新依赖/新文件；曾考虑给 hook 与 parser 建共享真相源文件，但 hook 是 shell
  无法 import ts（#667 已确认此约束），维持人工同步 + 单测锁定

## 明确不做

- 不收录 `Feature`/`Enhancement`/`Tests` 为合法类型（无成文约定，#432 已裁决
  Feature 为废弃别名；Enhancement/Tests 仅存量孤例，见 #671 样本）
- 不改 hook 与 CI（两者已与文档一致，#427/#432/#437 已收口）
- 不回填历史快照数据（health snapshot 存量失真属历史事实，修复自本 PR 合入后生效）

## 涉及文件

| 文件 | 改动 |
|------|------|
| src/usecases/health/commit-parser.ts | 白名单 3→5 种（常量收口）、FeatureUpdate 归一化、unrecognized_change_type 区分、文件头注释更新 |
| tests/usecases/health/commit-parser.test.ts | 新增 8 用例（#671 回归） |
| docs/features/2026/09/04/F20260904cmtw-commit-parser-type-whitelist.md | 本文档 |
