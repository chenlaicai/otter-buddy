---
id: F20261113anchr
title: 检视锚点规范：file:line 必带 commit + range 必须包含支撑句本身
change_type: prompt
created_at: 2026-11-13
created_in_conversation: a9260c50-cef6-412e-a0b4-282287a13103
capability_test: "n/a: 纯检视纪律静态规则增补，无可运行的生成式场景"
intent:
  problem: "anchor 真实性抽查连续三日（11-10/11-11/11-12）检出检视报告中的 file:line 锚点无法独立支撑断言：夹具顺序断言引 main.tsx:62-64 却是 <DmHeader> 组件调用点（顺序定义在 52-53）；models-factory.ts:249 被用来支撑遍历注册，该行是 logger 断言（遍历在 223、注册在 232）；pi-session-factory.ts:578 被用来支撑落盘校验，该行是注释（校验在 579-580）；synthesis-model-wire.test.ts:98 被用来支撑 mock，该行是另一个 stub（真 mock 在 89-91）；引测试名行当断言范围；修复后行号漂移因缺 commit 无法判定原断言真假。根因：adversarial-review skill 只对 node_modules 内文件要求带版本号，对仓库内文件既无 commit 要求、也无「range 必须包含支撑句本身」的硬规则——锚点写得「答案对就行、行号邻近即可」，真实反证与错误引用无法被机械抽查区分。"
  expected_effect: "检视獭写 file:line 锚点必须带 commit（pinned 或当日最近）；range 必须覆盖支撑断言的那一行/段本身，不得用测试名/注释/闭合括号/调用点代替定义点；无 commit 的锚点被读者视为不可审计。后续 anchor 抽查不再出现「缺 commit 导致修复前后无法判定」或「range 未含支撑句」的样本。"
  verify_by:
    type: static_only
    rollback: "git revert 本 PR；仅 .pi/skills/adversarial-review/SKILL.md 文本增补，无代码/机制变更"
    risk_note: "规则是执行层纪律（自觉 + 异体审），非机械守卫——不新增 lint 拦截；range 是否含支撑句语义不可机械判定，按 SYSTEM.md 标注「半机械+异体审」，不假称机械托底。"
causal_links: []
summary: 检视锚点规范增补两条硬规则：仓库内文件 file:line 必带 commit，range 必须包含支撑句本身——堵住 anchor 抽查连续三日检出的「行号邻近即可、范围不含支撑句」漏洞。
---

# 检视锚点规范：file:line 必带 commit + range 必须包含支撑句本身

## 案发现场

anchor 真实性抽查连续三日（11-10 / 11-11 / 11-12）检出检视报告里的
`file:line` 锚点无法独立支撑断言（抽查报告见
`data/workspaces/3241317b-99d6-4d78-9248-ff208a7461bc/anchor-spotcheck-*.md`）：

- 夹具顺序断言引 `main.tsx:62-64`，该范围实际是 `<DmHeader>` 组件，顺序定义在 52-53。
- `models-factory.ts:249` 被用来支撑遍历注册，该行是 logger 断言，遍历在 223、注册在 232。
- `pi-session-factory.ts:578` 被用来支撑落盘校验，该行是注释，校验在 579-580。
- `synthesis-model-wire.test.ts:98` 被用来支撑 mock DurableSession.open，该行是另一个 stub，真 mock 在 89-91。
- 引用测试名行（只有测试名称的那一行）当断言范围。
- 修复后行号漂移：缺 commit，无法判定「原时点成立 vs 实质编造」。

## 根因

`adversarial-review` skill 的锚点纪律只覆盖 `node_modules/` 依赖包文件
（要求带版本号），对仓库内文件的 `file:line` 锚点没有 commit 要求、也没有
「range 必须包含支撑句本身」的硬规则。检视獭写锚点时「答案对就行、行号
邻近即可」，真实反证与错误引用无法被机械抽查区分。

## 修复

`.pi/skills/adversarial-review/SKILL.md` 第 4 点「事实验证」增补「锚点 commit
与 range 支撑句纪律」两条硬规则：

1. **必带 commit**：仓库内文件（`src/`、`dev/`、`tests/` 等非 `node_modules/`）
   的 `file:line` 必须注明所读 commit（pinned commit 短 sha；回查原时点用当日
   最近 commit）。格式 `<file>:<range> @ <commit短sha>`，回查命令
   `git show <commit>:<file>`。
2. **range 必须包含支撑句本身**：范围必须覆盖支撑断言的那一行/段，不得只引
   测试名、相邻注释、闭合括号、或「调用点」代替「定义点」。写锚点前先读原
   文件确认 range 内确含支撑句；支撑句在 range 外 = 范围错误，按失败处置。

## 不做的

- 不加机械 lint 守卫（range 是否含支撑句语义不可机械判定，按 SYSTEM.md 标注
  「半机械+异体审」）。
- 不做三起 anchor issue 的逐条数据修正——那是各 issue 的独立闭环动作，不混入本规范 PR。
