---
id: F20260828ptun
title: P1 prompt 改动：最简实现自检 + 批评→测试用例
summary: 把 R20260828pntr（ponytail 深度研究）的两条可迁移思想落到 skill prompt 层：① code-implementation 自检步新增「最简实现检查」必答项（阶梯：仓库已有→stdlib→已装依赖→才写新代码），对抗 LLM 过度建设偏差；② review-protocol 处置节新增「批评→测试用例」提示，行为类检视发现优先沉淀为 golden 场景（good/bad 参考轨迹），一次性修复堵当前漏洞、永久场景防未来复发。
change_type: feature
status: implemented
capability_test: "n/a: 纯 prompt/skill 文档改动，无 LLM 参与行为、无代码逻辑；效果属 P2 A/B 对照范畴（暂不排期）"
created_in_conversation: 325ef7b7-8e42-4edc-9abf-eae8f332a2c4
---

# P1 prompt 改动：最简实现自检 + 批评→测试用例

## 背景

R20260828pntr（ponytail 深度研究，PR #552 已合入）提炼了四条可迁移思想（§5，
selftest-first / 污染隔离 / 批评→测试用例 / SUPERSEDED 不删），另在 §0 记录了
overbuilding 偏差的阶梯应对。P0 落地 §5 思想 1（golden selftest 层，见
F20260828gssf / PR #556）；本 PR（P1）落地两处：

1. **最简实现检查**（源自 §0 阶梯，非 §5 四条之一）：LLM 训练偏差天然导致"我要一个
   函数，它给我一个框架"
   （date picker 404 行 vs `<input type="date">` 23 行）。ponytail 的核心是用 7 级阶梯
   （YAGNI → 仓库已有 → stdlib → 平台原生 → 已装依赖 → 一行 → 最小实现）在第一个
   能站住的台阶停下。
2. **批评→测试用例**（§2.5 / §5 思想 3）：Colin Eberhardt 的四点批评被 ponytail 作者转化为
   永久的 `critic-email` 测试任务——"把尖锐批评转化为永久测试场景，比十篇反驳文章有价值"。
   我们的对应物：行为类检视发现（可描述为消息轨迹/工具调用序列的期望行为）应沉淀为
   golden 场景，而非只修当前 PR。

## 改动

| 文件 | 改动 |
|------|------|
| `.pi/skills/code-implementation/SKILL.md` | 步骤 6 自检清单新增「最简实现检查」必答项：先过阶梯（仓库已有实现 → stdlib/平台原生 → 已装依赖 → 才写新代码），更简且不改语义则采简弃繁，结论记入特性文档「验证」节 |
| `.pi/skills/_shared/review-protocol.md` | 「处置审视报告」节新增「批评→测试用例」提示：处置中发现行为类问题时优先沉淀为 golden 场景（`tests/capability/golden/`，含 good/bad 参考轨迹）；非行为类发现走常规单测，不强转 |

### 设计取舍

- **为何放 skill 层而非 SYSTEM.md**：两处都是流程行为指引（实现自检 / 审视处置），
  SYSTEM.md 是全局 SDK base，不塞具体流程细节；改动落在对应流程 skill 内，谁触发
  谁读到。
- **为何"必答记录结论"而非硬 gate**：最简检查无法机械验证（不像 CI），设计为自检报告
  必答项——利用"要求 LLM 显式回答"本身提高执行率，与 ponytail 的 check-mandate 同型。
- **为何 golden 场景要"含 good/bad 参考轨迹"**：PR #556（F20260828gssf，截至本 PR
  提交时待搭档终审合入）将把 selftest-first 落进 runner——合入后新场景自动获得零
  LLM 判别力校验，两条改动互相咬合。合入顺序建议：#556 先于 #561；若 #561 先合，
  「含 good/bad 参考轨迹」的指引本身仍成立（golden 场景本就该有参考轨迹），只是
  判别力校验要等 #556 到位。
- **不迁移的部分**：ponytail 的三档 intensity、ladder 人格化叙事（R20260828pntr §6
  边界），A4/A5 弹性约定已是我们的内置版本。

## 验证

- 两文件 diff 通读，措辞与所在 skill 既有风格一致
- 锚点核对：R20260828pntr §0（阶梯/过度建设）、§2.5（#126 案例）、§5（思想列表）、
  §6（边界）直接读原文核对；初稿曾将 §5 列表第 3 项误写为小节号"§5.3"、且把
  "最简实现"误归入四条思想，检视指出后修正（见 PR #561 审视发现 1）
- `npm test` 不受影响（纯文档改动，无代码路径）——CI 已复验通过

## 后续

- P2（记录不排期）：A/B 对照验证两条改动的实际效果 + 污染隔离基建，依赖 P0 落地后的
  使用经验
