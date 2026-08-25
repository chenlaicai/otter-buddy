---
id: F20260825m422a
title: 特性 ID 日期臆断三层修复：identity 注入日期锚点 + commit 钩子日期校验 + skill 流程提示
summary: |
  Issue #422（BugFix）：干净 session（含定时任务）的海獭无日期锚点，凭臆断生成特性 ID 日期，
  连续 3 次写错（偏差 1-7 天）。三层修复：①系统层 identity-builder 注入当前日期时间段；
  ②工具层 commit-msg 钩子 + CI PR 标题追加日期语义校验（F 类偏差 > 2 天拒绝）；
  ③流程层 skill 提示「先跑 date 再生成特性 ID」。
change_type: bugfix
status: active
capability_test: "n/a: 日期注入是 deterministic 逻辑（toLocaleString），钩子/CI 是 shell/node 脚本，无 LLM 参与行为"
created_in_conversation: 3241317b-99d6-4d78-9248-ff208a7461bc
---

# 特性 ID 日期臆断三层修复

## 背景与需求

### 问题描述

海獭在干净 session（新 session 或定时任务无人类首轮消息）中无日期感知能力，生成特性 ID 时凭臆断标日期。issue #422 记录了 3 连发事故：

1. 偏差 1 天（跨午夜边界，session 从昨天延续）
2. 偏差 2 天（定时任务触发，session 无人类注入上下文）
3. 偏差 7 天（长时间未清理的 stale session）

根源：系统 prompt 无日期段 → 海獭只能靠训练数据中的"大致日期"推测。

### 方案选择

单层修复（只改 prompt 或只改钩子）不足以闭环——prompt 注入可能被忽略，钩子只能事后拦截。
三层方案覆盖了"预防-拦截-教育"全链路：

| 层 | 职责 | 失效场景 |
|---|---|---|
| 系统层（identity-builder） | 每个 turn 注入日期，海獭主动感知 | 理论上 LLM 可忽略注入（实测未发生） |
| 工具层（钩子 + CI） | 事后拦截偏差 > 2 天的 ID | `--no-verify` 可绕过钩子 |
| 流程层（skill 提示） | 人工兜底，养成习惯 | 依赖海獭遵守 |

## 方案设计

### 层 1：系统层——identity-builder 日期锚点注入

`src/frameworks/agent/identity-builder.ts` 的 `buildIdentityPrefix` 方法新增一个日期段：

- 使用 `toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' })` 格式化
- 输出格式：`## 当前日期时间\n- 今天是 YYYY-MM-DD HH:MM（Asia/Shanghai）`
- 注入位置：与 userIdentity、modelIdentity 等并列，filter(Boolean).join("\n\n")
- 每个 turn 注入一次（不在 segment 级重算）

**时区选择 Asia/Shanghai 的理由**：项目运营时区。skill 提示"跑 date"在本地时区——±2 天容忍兜住了任意两时区最大 ~1 天错位。

### 层 2：工具层——commit-msg 钩子 + CI PR 标题日期校验

**commit-msg 钩子**（`.githooks/commit-msg`）：
- 格式校验通过后，解析首行 `[F` 后 8 位日期
- **仅对 F 类 ID 校验**——R 类 ID 日期是研究文档创建日（frontmatter 锚点），跨天迭代追加 commit 时日期必然不同，校验无意义且会阻断合法工作流
- 与系统日期（Asia/Shanghai）偏差 > 2 天则拒绝，提示"跑 date 确认"
- ±2 天容忍的推导：最大时区差 ~1 天 + 跨午夜边界 ±1 天 = 2 天

**CI PR 标题校验**（`.github/workflows/ci.yml`）：
- 同样仅对 F 类 ID 校验，R 类跳过
- 时区统一为 `TZ=Asia/Shanghai`（与系统层、钩子一致）
- 日期解析失败（非法日期如 13 月 40 日）→ fail-closed（exit 1），与本地钩子判定一致

### 层 3：流程层——skill 文件提示

- `worktree-isolation/SKILL.md` 步骤 3：生成特性 ID 前必须先跑 `date`
- `code-implementation/SKILL.md` 步骤 8：同上

### 不改的东西（边界）

- identity-builder 的整体结构不变（数组拼接模式），只新增一个段
- commit-msg 钩子的模板格式校验不变，日期校验追加在格式校验通过之后
- CI 的其他步骤不变
- 其他 issue / 历史追溯不在本 PR 范围

## 影响范围

| 文件 | 变更类型 | 说明 |
|---|---|---|
| `src/frameworks/agent/identity-builder.ts` | 修改 | 新增日期段注入 |
| `tests/frameworks/agent/identity-prefix.test.ts` | 修改 | 新增日期锚点断言 |
| `.githooks/commit-msg` | 修改 | 追加 F 类日期语义校验 + R 类跳过 + Asia/Shanghai 时区 |
| `.github/workflows/ci.yml` | 修改 | 追加 F 类日期语义校验 + R 类跳过 + fail-closed + Asia/Shanghai 时区 |
| `.pi/skills/worktree-isolation/SKILL.md` | 修改 | 步骤 3 加日期提示 |
| `.pi/skills/code-implementation/SKILL.md` | 修改 | 步骤 8 加日期提示 |

行为变化：
- 海獭每个 turn 可感知当前日期（此前完全无锚点）
- F 类特性 ID 日期偏差 > 2 天的 commit 被钩子拒绝（此前只校验格式）
- PR 标题 F 类 ID 日期偏差 > 2 天被 CI 拦截（新增）
- R 类 ID 不受日期校验约束（跨天迭代是合法工作流）

## 验证

- [x] identity-prefix 测试：10/10 通过（含新增日期锚点断言 `YYYY-MM-DD HH:MM（Asia/Shanghai）` 格式）
- [x] commit-msg 钩子自测：F 类今天/±1/±2 通过、±3/±7 拒绝、R 类 7 天通过（跳过校验）、无 ID 走模板校验
- [x] CI workflow 日期校验：ubuntu runner 上 success（F 类校验 + R 类跳过）
- [x] 全量测试 123 文件 1501 用例通过
- [x] lint + build 通过

## Discovered Issues

无。

## 决策史

- 2026-08-25：初始实现（开发獭-422，mimo）。三层方案由 issue #422 描述 + 大獭任务简报确定；±2 天容忍阈值由大獭指定；钩子/CI 对 R 类跳过日期校验由检视獭-435 建议；三层时区统一为 Asia/Shanghai 由检视獭-435 建议
