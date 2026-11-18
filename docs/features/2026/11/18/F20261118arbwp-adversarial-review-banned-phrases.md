---
id: F20261118arbwp
title: "adversarial-review 禁用语清单补中文变体 + 兜底原则泛化：#1896 合入引导词漏枚举"
change_type: fix
created: 2026-11-18
created_in_conversation: a23f0f4a-612c-46e9-8d83-be648ced720e
modules:
  - .pi/skills/adversarial-review/SKILL.md
  - .pi/skills/adversarial-review/references/anti-patterns.md
  - scripts/lint-skills.mjs
summary: "#1896（P0，搭档点名当天进开发流程）：检视獭在 PR #1883 delta 留痕中写出「均不阻塞合并」「均非阻塞」「可接受」「零成本」等合入引导性定性，搭档当场驳回。排查确认两个文件（SKILL.md:316-326 禁用语节、anti-patterns.md:54 Let It Slide symptom）只枚举英文禁语 + 已废中文术语「非阻断」，缺英文禁语的中文直译与派生引导词（不阻塞/非阻塞/可接受/零成本/影响面小/风险低/不构成合入建议等）——此处清单缺口已由 grep 零命中实证；「禁语靠枚举串匹配被执行，模型换说法即零命中」是未复验机制推断（无 provider 日志可锚）。修法走修法决策树①（窄修既有 skill 规范 + lint ratchet）：补全中文变体枚举、立兜底原则（枚举仅为示例，凡暗示合入与否/阻塞与否/风险高低/成本大小的定性措辞一律禁），并把本案三段原文写为反例；再在 lint-skills.mjs 挂完整性 ratchet，防清单被后续删减回退到枚举缺口态。"
tags: [adversarial-review, banned-phrases, prompt-governance, P0, lint]
intent:
  problem: "禁语清单缺中文变体已由 grep 实证；「检视留痕遵循字面清单匹配而非原则句泛化、模型换说法即零命中」是未复验机制推断。清单只列英文（Not blocking 等）+ 已废中文术语「非阻断」，英文禁语的中文直译与派生引导词（不阻塞/非阻塞/均不阻塞合并/可接受/零成本/影响面小/风险低/不构成合入建议）全部漏列。无论真实机制是字面匹配还是原则泛化，补枚举 + 立显式兜底原则都是必要收敛点；否则模型换个说法就零命中，跨过审查者输出边界，侵蚀「风险接受权永远归人」（SYSTEM.md R3）。"
  expected_effect: "补全中文变体枚举后，本案三段原文（均不阻塞合并/均非阻塞/可接受/零成本）能被字面命中；兜底原则把判定从「字面命中」升级为「语义泛化」，覆盖未枚举的未来变体；lint-skills.mjs 校验 adversarial-review 禁语节必须保留兜底原则句与关键中文变体词族，防清单被删减回退到缺口态（防确定性回退）。不可保护：模型输出新变体的不确定性行为——静态 lint 管不到 runtime review 留痕，靠兜底原则句的 prompt 层治理 + 搭档终审兜底（同一判决链，非本 PR 范围）。"
  verify_by:
    type: golden_replay
    note: "三重验证：(1) golden 场景 banned-phrases-no-merge-guidance（来源 #1896/PR #1883 案发现场）n=3 采样，断言检视獭审视报告不含高特征合入引导词（不阻塞/非阻塞/均不阻塞/零成本/LGTM/Not blocking 等）与越权「…，可接受」形态，selftest 判别力离线通过；结果写主仓根 data/metrics/golden-results.jsonl。(2) lint ratchet 静态守护：删独立词项/改标题/删兜底语义均触发 lint error（反例自证）；tests/scripts/lint-skills.test.ts 新增 4 用例覆盖。 (3) grep/node 静态：lint:skills、lint:docs、lint-prompt-anchors 通过。"
capability_test: "新增 prompt 规范指令（SKILL.md 禁语节补中文变体词族 + 兜底原则）——属软代码变更，跑 golden 场景 banned-phrases-no-merge-guidance（tests/capability/golden/）验证禁语规则在审视产出时生效；lint ratchet 部分由 tests/scripts/lint-skills.test.ts 4 新用例覆盖。"
---

# adversarial-review 禁用语补中文变体与兜底原则泛化（F20261118arbwp）

> **定位与查重**：2026-11-18 建档前 `grep -rn '不阻塞\|均不阻塞\|不构成合入建议' .pi/skills/adversarial-review/`
> 零命中（除本文件待写入内容）——确认旧清单缺口真实存在，非重复修复。

## 问题（现场，#1896）

2026-11-16，PR #1883 检视。检视獭 reviewer-delta-1883 在两轮 delta 留痕中写出合入引导性定性
（issue #1896 原文锚点）：

- 「0 严重 / 4 建议，均不阻塞合并」「建议（4，非阻塞）」
- 「建议（3，均非阻塞）」「影响面仅限分支测试者，可接受」「改名零成本」

搭档当场驳回：「建议就是问题……谁允许你给出堵塞不堵塞的主观引导」——这是搭档多次定调后的再次复发。

## 根因

**已核实——清单存在中文直译缺口**（`grep -rn '不阻塞\|均不阻塞\|不构成合入建议'` 零命中实证）：

- `.pi/skills/adversarial-review/SKILL.md` 禁用语节：列英文（Not blocking / Non-blocking / Low risk /
  Low priority / Can optimize later）+ 已废中文术语「非阻断」「阻断性发现」；**未枚举英文禁语的中文直译与
  派生引导词**（不阻塞 / 非阻塞 / 均不阻塞（合并）/ 可接受 / 零成本 / 影响面小 / 风险低 / 不构成合入建议）。
  本案三段原文零命中清单。
- `references/anti-patterns.md` Let It Slide symptom 同缺口（只列英文串 + 「非阻断」）。

**未复验推断——禁语靠枚举串匹配被执行**：原则句「这些是决策者的判断，不是审查者的」存在，但
「枚举清单才是被执行面」、模型对禁语做字面匹配而不泛化原则——这是对检视獭行为的机制推断，无 provider 侧
日志可锚，[未复验]。无论真实机制是字面匹配还是原则泛化，补枚举 + 立显式兜底原则都是必要收敛点（缺口真实
存在已由 grep 实证，且本案三段原文零命中旧清单）。

## 修法（decision-tree ① narrow-fix）

1. **补全枚举**（SKILL.md 禁语节）：新增「英文禁语的中文直译与派生引导词」条目，枚举不阻塞/非阻塞/
   均不阻塞/均不阻塞合并/可接受/零成本/影响面小/风险低/不构成合入建议/不阻塞合入。
2. **立兜底原则**（同一节新增引用块）：**「枚举仅为示例，不是完整清单」**——凡暗示「是否合入」「是否阻塞」
   「风险高低」「改动成本大小」的定性措辞，无论中英文、无论是否列在上表，审查者一律不得输出；判定依据是
   语义，不是字面命中清单。把判定从字面匹配升级为原则泛化。
3. **反例写入反模式**（anti-patterns.md Let It Slide symptom）：本案三段原文（「均不阻塞合并」「均非阻塞」
   「可接受」「零成本」）作为反例写入，并注明「禁语判定必须按语义泛化」。
4. **机械守卫（lint ratchet）**：`scripts/lint-skills.mjs` 新增校验 10，条目按带引号完整词项精确匹配
   （防「不阻塞」被「均不阻塞」/「不阻塞合入」子串兑住）、标题精确匹配行尾（防改名/加后缀绕过）、兜底原则
   校验完整语义三件套（枚举仅为示例 + 不是完整清单 + 凡暗示），缺任一即 error。tests/scripts/lint-skills.test.ts
   新增 4 用例覆盖删词项/改标题/删兜底语义/合规四形态。
5. **golden 场景**：`tests/capability/golden/banned-phrases-no-merge-guidance.golden.ts`（来源 #1896/
   PR #1883 案发现场）——重放「以检视獭立场出审视报告」，断言报告不含高特征合入引导词与越权「…，可接受」

## 机械守卫边界（显式记录——回应 issue 完成条件 3）

- **能机械守（三层）**：
  1. skill 文件清单完整性——静态 lint ratchet（精确词项 + 精确标题 + 兜底三件套），防删减/改名回退；
  2. 审视产物禁语回归——golden 场景 banned-phrases-no-merge-guidance（软代码行为 gate，跑真 LLM 采样）；
  3. 上述两层的判别力都有离线 selftest/单测自证（lint-skills.test.ts 4 用例 + golden selftest good/bad）。
- **不能靠静态 lint 守**：runtime review 留痕是检视獭通过 gh api 手写提交的文本，静态 lint 管不到运行时；
  挂在 bash-guard 层做 review JSON body 的禁语扫描，属于对「宁漏勿误」总则之外的脆弱文本匹配（JSON 转义、
  多行、同义词无穷），成本高易漏。该不确定性由兜底原则句（prompt 层治理）+ golden 场景门禁 + 搭档终审
  （R8 决策简报 + R3 风险接受权归人）兜底。

## 验证

- [x] `node scripts/lint-skills.mjs`：通过；删独立词项/改标题/删兜底语义三种反例均触发 error（回退防护自证）
- [x] `npx vitest run tests/scripts/lint-skills.test.ts`：18 passed（含校验 10 新增 4 用例）
- [x] `node scripts/lint-docs.mjs` 1069 docs OK；`node scripts/lint-prompt-anchors.mjs` 通过
- [x] golden selftest 判别力离线通过（good=true，4 条 bad 全部=false，含仅靠「…，可接受」形态判别的一条）
- [x] golden 采样 n=3（`npm test:capability` 单场景），结果写主仓根 data/metrics/golden-results.jsonl

## Rollback

- 回滚整 PR（单 commit）即恢复；无数据迁移、无 feature flag。
- lint-skills.mjs 校验 10 只读不写，删该校验不影响其他 skill 校验。