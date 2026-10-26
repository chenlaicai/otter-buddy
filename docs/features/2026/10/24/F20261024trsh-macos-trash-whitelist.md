---
id: F20261024trsh
title: macOS 废纸篓正道白名单：mv → ~/.Trash 目的端豁免（#1418）
change_type: fix
status: implemented
created: 2026-10-24
created_in_conversation: a9260c50-cef6-412e-a0b4-282287a13103
modules:
  - src/frameworks/agent/bash-safety-guard.ts
  - tests/frameworks/agent/issue1418-probe.test.ts
summary: "issue #1418（P1）：探针实证 rm workspace 沙箱误拦已被 F20261014cwsp sessionCwd 豁免修好，当前唯一真实误拦 = mv workspace 文件 → ~/.Trash（macOS 删除正道）命中 classifyDestructiveTarget 的 ~ 前缀保守拦截。修法收窄：~/.Trash 精确前缀白名单放行（仅目的端受益），源端主仓 data 仍拦（case6/case9 钉死）。"
tags: [bash-guard, data-destructive, macos-trash, workspace, fix]
capability_test: tests/frameworks/agent/issue1418-probe.test.ts + tests/frameworks/agent/bash-safety-guard.test.ts + tests/frameworks/agent/guard-touchstone-exam.test.ts
from: [F20261014cwsp, F20261016gdfv]
---

# macOS 废纸篓正道白名单：mv → ~/.Trash 目的端豁免（#1418）

issue #1418（P1，10-09 回放候选 3 条误拦实证）。本单交付：案发现场重判定 + 收窄修复 + 9 条探针测试钉死边界。

## 1. 案发现场重判定（探针实证，非 issue 原样照单）

issue 列了 3 条误拦（bcb118fb rm 绝对路径 / ded4a536 cd+rm / 21cee677 mv→~/.Trash）。探针测试在当前代码（含 F20261014cwsp sessionCwd 豁免）下重跑：

| 探针 | 形态 | 当前裁决 | 结论 |
|---|---|---|---|
| case1 | `rm` 绝对路径 workspace | ALLOW ✅ | F20261014cwsp 已修好 |
| case2 | `cd ws && rm` 相对 | ALLOW ✅ | F20261014cwsp 已修好 |
| case3 | `mv ws/file ~/.Trash/` | **BLOCK** ❌ | **唯一真实误拦** |
| case4 | `cd ws && mv file ~/.Trash/` | **BLOCK** ❌ | 同 case3 |

**结论**：rm 部分已自愈，只剩 mv→~/.Trash 一条。修法比 issue 原方案收窄——不需要动 rm 分支。

## 2. 误拦根因

`classifyDestructiveTarget`（bash-safety-guard.ts:414）对任何 `~` 前缀路径保守判 data 面（`~/…/otter-buddy/data` 可能指向主仓，静态展开判不了安全）。`~/.Trash/` 命中此条 → zone=data → BLOCK。

## 3. 修法（收窄版）

`classifyDestructiveTarget` 加 `~/.Trash` 精确前缀白名单：

```ts
if (target === "~/.Trash" || target.startsWith("~/.Trash/")) return null;
if (target.startsWith("~")) return "data"; // 其余 ~ 仍保守拦
```

**边界钉死**：
- 目的端豁免：`mv ws/file ~/.Trash/` / `mv ws/file ~/.Trash/old.md` → ALLOW（case3/4/8）
- 源端不豁免：`mv /repo/data/metrics ~/.Trash/x` / `cd /repo && mv data/metrics ~/.Trash/x` → BLOCK（case6/9）
- 守旧行为不破：无 sessionCwd 时 `rm /repo/data/workspaces/…` → BLOCK（case7）
- 真主仓删除不破：`rm -rf data/metrics`（cwd=主仓）→ BLOCK（case5）

## 4. 验证

| 层 | 命令 | 结果 |
|---|---|---|
| 探针 9 用例 | `vitest run tests/frameworks/agent/issue1418-probe.test.ts` | 9/9 绿 |
| 守卫全量 | `vitest run tests/frameworks/agent/bash-safety-guard.test.ts` | 581/581 绿 |
| touchstone 考试 | `vitest run tests/frameworks/agent/guard-touchstone-exam.test.ts` | 3/3 绿 |
| tsc / eslint | `tsc --noEmit` / `eslint <两文件>` | 清 |

## 5. 遗留与边界

- **mv 双端判定设计缺陷**（本单未动）：zoneOf 取最高风险，mv 目的端为 null 时拉低源端 data 判定。`mv data/metrics /tmp/x`（sessionCwd=主仓）仍 ALLOW——这是既有行为，非本单引入。若需收口另立 issue。
- **~ 展开保守面**（GAP 键 TS-21cee677/TS-a32f51e7）：其余 `~/Desktop` 等形态仍 fail-closed，另单治理（issue #1418 已注明）。
- 30 天回查断言：data_destructive 规则下 workspace 沙箱前缀误拦零新增（issue #1418 验收口径）。

## 6. 现世因果链

- F20261014cwsp（sessionCwd 豁免）→ 修好 case1/2 → 本单只需处理 case3/4
- F20261016gdfv（目标域扩主仓内容树）→ mv 双端判定引入 → 本单在其边界上开口子
