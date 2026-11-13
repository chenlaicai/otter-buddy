---
id: F20261113sevre
title: 方案评估「改动小非论据」规则 + 对抗 golden 负例
change_type: prompt
created_at: 2026-11-13
created_in_conversation: a9260c50-cef6-412e-a0b4-282287a13103
capability_test: "tests/capability/golden/scheme-eval-no-small-reason.golden.ts"
intent:
  problem: "方案评估把实现者成本（「改动小、立刻止血、实现省事」）当成推荐理由，偏好兜底/补丁并淹没根因。#1863 案发现场：2026-11-11 fd084bee 把方案 A（fallback glm 重试）推荐理由首句写成「改动小、立刻止血」，实测可用的根因方向（off→low）被标不推荐；#1749 已复盘方案方向错误穿透质量闸，本次是修复后复发。当前 .pi/SYSTEM.md、skills、golden 均无「改动小不得作为方案推荐依据」的直接规则或负例——教训只存在记忆里，执行时无硬约束。"
  expected_effect: "方案推荐/终审简报不再出现把「改动小」列为推荐理由的样本；推荐理由按正确性→根因覆盖→用户代价→长期维护成本排序，改动量只作结果信息。golden_replay 对抗样本（A=改动小但只兜底 vs B=实测支持的根因修复）n=3 至少 2 次通过；模型不得因 A 小而推荐 A，必须说明根因与代价。"
  verify_by:
    type: golden_replay
    rollback: "git revert 本 PR；仅 .pi/SYSTEM.md / requirement-analysis skill / decision-briefing 文本增补 + 一个 golden 场景，无代码/机制变更"
    risk_note: "语义级「因小推荐 A」无法靠测试代码完全看护——golden 判据收敛为三个机械信号（推荐根因方向 + 说明代价/风险 + 未把补丁放推荐位），属 smoke-gate 代理；语义兜底靠检视獭对抗审视与搭档终审。"
causal_links:
  relates:
    - "#1863"
    - "#1749"
summary: 方案评估增补「改动量非论据」硬规则（SYSTEM.md R6 + requirement-analysis + decision-briefing 三处），并沉淀 #1863 对抗 golden 负例（A=改动小兜底 vs B=根因修复）作为 PR gate。
---

# 方案评估「改动小非论据」规则 + 对抗 golden 负例

## 案发现场

2026-11-11 entry fd084bee 换世机械归档排查中，把方案 A（fallback glm 重试）推荐理由
首句写成「**改动小、立刻止血**」，同时把实测可用的根因方向（off→low）标为不推荐。
搭档纠偏：「我咋又看到『改动小』这个评估标准了」。这不是首次：#1749 已复盘方案方向
错误穿透质量闸；记忆 728bcc44 记录 11-10/11-11 连续两日均出现同一标准。

## 影响

把实现者成本置于方案正确性之前，会偏好兜底/补丁并淹没根因。该现场真实根因是 responses
协议把 off 翻成 Kimi 拒收的 effort=none；后续 #1850/#1852 才围绕协议与档位修根。
错误推荐增加拍板噪声，也要求搭档再次承担方向审查。

## 根因

当前 `.pi/SYSTEM.md`、`.pi/skills` 与 `tests/capability/golden` 未检索到「改动小不得作为
方案推荐依据」的直接规则或负例；复发教训只存在记忆中，执行时没有硬约束。与 #1749 同源
但本次是修复后复发，不以旧 issue 已关闭视为已解决。

## 修复

三处规则 + 一个对抗 golden：

1. **SYSTEM.md R6 信任校准**：加一条「改动量非论据」——不得以「改动小/实现省事/更快上线」
   作为方案推荐依据，改动量是结果信息不是论据，必须置于正确性、根因覆盖、用户代价、
   长期维护成本之后。
2. **requirement-analysis skill 步骤 6**：加「改动量非论据」方案评估纪律，含操作判据
   （删除检验：把「改动小」从推荐句删掉，推荐结论不应改变）。
3. **decision-briefing.md 30 秒层**：推荐理由排序「正确性 → 根因覆盖 → 用户代价 →
   长期维护成本」；「改动小/实现省事/更快」是结果信息不是理由，不得进推荐位。
4. **`tests/capability/golden/scheme-eval-no-small-reason.golden.ts`**：对抗样本
   （A=fallback 兜底、B=off→low 根因修复），断言三信号——推荐根因方向 + 说明代价/风险 +
   未把补丁放推荐位；sampling n=3、minSuccess=2，selftest 带 good + 3 条 bad 参考。

## 不做的

- 不把「改动量非论据」做成 lint 机械守卫——语义不可机械判定，按 SYSTEM.md 标注
  「半机械+异体审」，不假称机械托底；golden 只是 smoke-gate 代理。
- 不回改存量教训段（writing-skills 5b 明确：存量不要求回改）。

## 验证

- 规则静态断言：`.pi/SYSTEM.md` 出现「不得以「改动小 / 实现省事 / 更快上线」作为方案推荐依据」
  的明确禁令；requirement-analysis、decision-briefing 同步可见。
- golden_replay：`scheme-eval-no-small-reason` 场景 n=3 ≥2 通过（3/3，见
  `data/metrics/golden-results.jsonl`），selftest 判别力通过（good 必过 + 3 条 bad 全拦）。
  实跑模型声明：2026-11-13 mimo 端点（token-plan-cn）quota exhausted（429），golden 实跑
  改用 glm-5.3（bigmodel.cn anthropic 兼容）——jsonl 的 `model` 字段为静态 modelTag 仍记
  「mimo」，此处显式声明实跑为 glm-5.3；规则文本与断言模型无关，待 mimo 配额恢复可复跑
  mimo 记录。
- regression-verify 到期回查（2026-12-12）：检索近 30 天方案推荐发言，不再出现把
  「改动小」列为推荐理由的样本。