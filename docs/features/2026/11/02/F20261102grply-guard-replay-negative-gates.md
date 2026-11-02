---
id: F20261102grply
title: 守卫回放库补 2 条 11-01 实录负门用例
created: 2026-11-02
created_in_conversation: 3241317b-99d6-4d78-9248-ff208a7461bc
change_type: feature-update
status: shipped
modules:
  - tests/guard/replay/cases-2026-10-29.ts
summary: "守卫回放库覆盖面补齐：11-01 healing 实录 3 条全 BLOCK 真负门，其中 2 条形态缺位固化——①curl 管道进 python 解释器（库内原只有 curl|sh/bash；定性政策性拦截·已知摩擦·精细化候选，非结构负门）；②长命令后段凭证字面量（commandHead 120 截断窗外，fixture 垫长 189 字符钉位）；另补 1 条非泛拦 companion 用例（同形态去字面量=ALLOW）。88 用例全绿。"
intent:
  problem: "守卫回放库铁律「守卫行为以真实使用为准」——但 11-01 实录 3 条真负门中 2 条形态库内缺位（curl 管道进 python 解释器变体、长命令后段凭证字面量）；不固化则未来守卫改动可能静默放宽这两类拦截而回放库不报警（回放库是守卫改动的唯一回归防线）"
  expected_effect: "mustBlock 新用例逐条 BLOCK（含 fixture 垫长钉住截断窗外属性）；falsePositiveCases companion 用例 ALLOW（同形态去字面量）；全量回放绿"
  verify_by:
    type: capability_test
    description: "npx vitest run tests/guard/replay/replay.test.ts 全绿（87→88 用例）；mustBlock 新用例逐条 BLOCK、companion ALLOW；钉位验证 fixture len=189 token pos=169>120"
source_issue: null
related_prs: ["1724"]
causal_links: []
tags: [guard, replay, negative-gate, regression]
---

# F20261102grply 守卫回放库补 2 条 11-01 实录负门用例

## 背景与来源

2026-11-02 晨检（每日对话健康检查守卫回放段）按流程跑 `generate-guard-replay.mjs`：11-01 拦截 3 条 → 去重 3 候选 → 逐条裁决全 BLOCK 真负门。其中 2 条形态回放库（tests/guard/replay/cases-2026-10-29.ts，F20261030gblkv 建立）缺位，按「非 SKIP 追加用例」规则固化。

## 变更内容

mustBlockCases 组 +2：

1. **curl 管道进 python 解释器**（healing 99f96502，11-01/11-02 两日复现）：库内原有 `curl|sh`、`curl|bash`，python 解释器变体缺位。定性为**政策性拦截·已知摩擦·精细化候选**（下载内容是数据进固定脚本，与 curl|sh 下载即代码不同构；两日 4 次拦截全是獭自查 settings/trends 的良性工作流）。
2. **长命令后段凭证字面量**（healing 364f8e76/37ad93a5）：凭证字面量位于 commandHead 120 字符截断窗外——fixture 垫长至 189 字符（token 首现位置 169）钉住「截断窗外」属性。判别实录：纯 `grep "heredoc"` 无字面量 ALLOW、带字面量 BLOCK，非泛拦。

falsePositiveCases 组 +1（处置轮增补，检视獭建议 3）：

3. **非泛拦回归钉**：与用例 2 同形态但去凭证字面量的 companion 用例（仅末段一个 token 之差）——把「守卫只认字面量非泛拦」的主张从已删 probe 转为库内常驻断言。

## 验证

- 回放全量：88/88 绿（含 3 新用例）
- 判别探针（probe 脚本跑完即删，结论在用例 note）：纯 heredoc grep=ALLOW；带凭证字面量=BLOCK；命令后段（>120）字面量=BLOCK
- PR #1724 CI 四 job 全绿

## 取舍与教训

- 初版 case1 fixture 82 字符——`.ssh` 实际落在 commandHead 120 截断窗**内**，与 note 声称的「截断窗外」属性不符（检视獭初轮建议 1 抓到）；处置轮垫长钉位。
- 初版 case2 note 自称「真负门」过誉——政策命中≠结构负门（检视獭初轮建议 2），处置轮改定性。
- 编造 ID 教训（晨检獭 11-01 自身踩坑两次）：8 位前缀 + 凭印象补 UUID 尾段 = 必错；处置事件一律 sqlite 直读完整 ID 再操作。

## 后续机制预测

无新机制。若未来放宽「管道进解释器」规则（精细化候选），用例 1 的 expect 需随政策同步修订——这是库锁现状的既定语义，非缺陷。
