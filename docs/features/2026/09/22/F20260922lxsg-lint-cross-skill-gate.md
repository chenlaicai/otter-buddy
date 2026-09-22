---
id: F20260922lxsg
title: lint 跨 skill 裸写引用非法化（#773）：E1c 门禁 + ../ 前缀写死
change_type: fix
status: implemented
created: 2026-09-22
created_in_conversation: a9260c50-cef6-412e-a0b4-282287a13103
modules:
  - scripts/lint-skills.mjs
summary: "#773：lint 的 resolveRefToAbs 对跨 skill 裸写引用（`other-skill/references/x.md`）按 skills 根解析放行，但 SDK 系统提示明确「相对路径从当前 skill 目录解析」——lint 认存在、SDK 读不到 = 错误安全感（#726 28 次 ENOENT 同族病灶）。按 issue 倾向方案（机械可校验）把约定写死成门禁：E1c 拦截跨 skill 裸写 + 报错附 ../ 迁移指引；存量 2 处裸写（signature-convention）改 ../ 前缀；E2 可见性豁免 SKILL.md 目标（skill 名引用由 agent 的 skill 加载机制直接消费，md 可见性实证不适用——否则 signature-convention 的存量索引引用会误报 error）。"
tags: [lint, skills, cross-skill, sdk-alignment]
capability_test: tests/scripts/lint-skills.test.ts
from: [F20260903sdcp]
---

# lint 跨 skill 裸写引用非法化（#773）

## 问题

`resolveRefToAbs` 对跨 skill 裸写引用（`other-skill/references/x.md`、`other-skill/SKILL.md`）按 `.pi/skills` 根解析放行——但 SDK（pi-coding-agent skills.js）给 agent 的系统提示明确「skill 文件的相对路径从 SKILL.md 所在目录解析」。两者不一致：lint 放行的形态 SDK 解析必然 ENOENT = 错误的安全感（#726 的 28 次 ENOENT 正是同族病灶）。

## 修复（issue 倾向方案：把约定写死成门禁，机械可校验）

1. **E1c 门禁**：`BARE_CROSS_SKILL_RE` 拦截跨 skill 裸写，error 附迁移指引（`改写为 \`../<raw>\``）
2. **REF_LINE_RE 收紧**：合法宇宙 = `references/`（本 skill）+ `../` 前缀（跨 skill），裸写移出合法宇宙
3. **resolveRefToAbs 简化**：全部按当前 skill 目录解析（与 SDK 规则字面一致），skills 根解析分支删除
4. **E2 豁免 SKILL.md 目标**（修复中发现的存量误报，L1 拍板）：skill 名引用（`adversarial-review` = 「先 read 该 skill」的指令对象）由 agent 的 skill 加载机制直接消费——E2 的 md 文件可见性实证（索引引用零读取）不适用。signature-convention 的存量索引引用 `../adversarial-review/SKILL.md` 属此类。references/*.md 目标不适用豁免
5. **存量迁移**：signature-convention 的 2 处裸写改 `../` 前缀

## 测试

`tests/scripts/lint-skills.test.ts`（12/12）：
- E1c：裸写 → error + 报错含 `../` 迁移指引
- `../` 前缀形态 → 放行（与 SDK 对齐）
- E2 豁免：索引-only 的 SKILL.md 目标不误报
- 旧「裸写放行」2 用例按新语义改写；E1/E1b/E2/校验 7 存量全绿

## 验证

lint:skills OK（0 error，13 warning 全存量）、npm run lint 0 error、tsc 0 错。

## 影响范围

- 新写 skill：跨 skill 引用必须 `../` 前缀，裸写 commit 即拦（报错附正确形态）
- 存量：2 处已迁移；`../` 前缀形态行为不变
- 运行时 agent 行为零变化（lint 层规则对齐，SDK 侧无改动）

## 关联

- issue #773（PR #772 审视建议）；F20260903sdcp（_shared 拆解，引用规范前身）；#726（ENOENT 实证）
