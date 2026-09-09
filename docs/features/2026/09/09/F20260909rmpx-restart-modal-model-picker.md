---
id: F20260909rmpx
title: RestartModal 补模型切换下拉（restart 切模型 UI 闭环）
summary: 搭档点「重启獭生」发现没有模型切换入口——F20260908efmd 把后端链路（restart_otter 工具 modelAlias 参数、HTTP API、session 快照、转世履历武器展示）全部交付，但 RestartModal UI 层遗漏（方案改动范围表含 Modals.tsx 但只兑现了转世履历武器行，restart 弹窗本身未加下拉）。本特性补上 UI：restart 弹窗增加模型下拉（默认「不换模型（当前：alias）」），api.restartOtter 增第三参透传。
change_type: feature
capability_test: "n/a: 纯 UI 表单补全，走组件测试断言（web/src/pages/conversation/Modals.test.tsx），无可采样对话行为断言点"
created_in_conversation: d335d3e1-bb66-4713-9346-caa70cf6afbd
tags: [web-ui, restart, model-routing]
intent:
  problem: "F20260908efmd 后端已支持 restart 带 modelAlias（HTTP POST /otters/:id/restart body 校验 + config 写回），但搭档在 UI 点「重启獭生」时弹窗只有前情摘要输入框，没有模型选择入口——功能链路断在最后一环"
  expected_effect: "restart 弹窗可选模型：默认「不换模型（当前：alias）」不换武器；选中其他模型时确认携带 modelAlias，新一世以新模型启动"
  verify_by:
    type: behavior_check
    detail: "打开 restart 弹窗可见模型下拉；不选模型重启行为与之前一致；选模型重启后武器栏/下一世身份注入变更"
modules:
  - web/src/pages/conversation/Modals.tsx
  - web/src/pages/conversation/index.tsx
  - web/src/api/client.ts
from: [F20260908efmd]
supersedes: []
created_at: 2026-09-09
---

# RestartModal 补模型切换下拉

## 背景

搭档原话（意图锚）：

> 「我点击 重启獭生 但没看到可以切换模型，你看下昨天的功能是否做漏啦」

排查结论（2026-09-09）：F20260908efmd 后端链路完整交付——

- `restart_otter` 工具 modelAlias 参数 + hasModel 校验 ✅
- `ManageSession.restartSession` 三参 + config 写回顺序守护 ✅
- HTTP `POST /otters/:id/restart` body modelAlias ✅
- `otter_sessions.model_alias` 快照 + 转世履历武器行展示 ✅

**唯独 UI 入口遗漏**：F20260908efmd 改动范围表列了 `web/src/pages/conversation/Modals.tsx`，但实际只兑现了 T3 的转世履历武器行（`Modals.tsx` 的 `⚔️ {s.modelAlias}`），T2 的 restart 弹窗模型选择没有实现。`RestartModal` 仍是「只有摘要输入框」的旧版，`api.restartOtter` 也只接受 (otterId, summary) 两参。

## 方案

纯前端补全，后端零改动（API 已就绪）：

1. **`web/src/api/client.ts`**：`restartOtter(otterId, summary?, modelAlias?)` 增第三参，组装 body 时空值不携带（保持不传 modelAlias 时请求体与旧版逐字节一致）
2. **`web/src/pages/conversation/Modals.tsx` RestartModal**：新增模型下拉
   - 数据源 `GET /api/settings`（与 CreateOtterModal 同款，含加载失败降级 console.warn）
   - 默认项：「不换模型（当前：{otter.modelAlias}）」——otter.modelAlias 已是有效模型（F20260908efmd T1 默认解析），空值时省略括号段
   - 语义：空串 = 不换模型（`onConfirmRestart(summary, undefined)`），选中 alias = 换模型
   - 提示文案：「模型配额耗尽时可在此应急换武器，新一世以新模型启动」
3. **`web/src/pages/conversation/index.tsx` confirmRestart**：签名扩展 `(summary, modelAlias?)`，透传至 api

## 非目标

- 不动后端任何文件——`POST /otters/:id/restart` 的 modelAlias 校验（400 附可用列表）已在 #848 交付
- 不动 CreateOtterModal 的模型下拉逻辑（两者独立 state，样式同源但无共享组件需求）
- 不做「restart 后自动刷新参与者 badge」——既有 confirmRestart 已重拉 session 链，badge 走 participants 刷新路径（既有行为，不在本特性范围）

## 影响范围

- UI 行为变化：restart 弹窗多一个模型下拉（默认不换模型，无打断）
- API client 签名扩展（向后兼容，可选参数）
- 零后端改动、零 DB 改动

## 验证

- 根 `npx tsc --noEmit` — 0 错误
- web `pnpm test` — 46 文件 / 400 测试全绿（含新增 2 条 RestartModal 模型切换用例：选模型携带 modelAlias / 不换模型传 undefined）
- 后端 `npx vitest run tests/api/otter.test.ts` — 17 通过（无回归）

**pre-existing 声明**：worktree 干净安装下 `web pnpm build`（tsc --noEmit）报 `MessageList.tsx(4,45): Cannot find module 'hast'`——主仓能 build 是因为 node_modules 里残留 2026-07-20 安装的 `@types/hast`（不在当前 package.json 依赖树，pnpm 干净安装不会出现）。属环境漂移 pre-existing，与本特性无关；web 测试（vitest，不做全量类型检查）不受影响。

**手工验收**：重启 dev server 后打开任一对话 → 右栏大獭卡片 → 详情 → 「重启獭生」→ 可见模型下拉，默认「不换模型（当前：kimi）」；选 glm 确认后，武器栏显示 glm 且新世身份注入为 glm。

## 改动范围

| 文件 | 操作 | 说明 |
|------|------|------|
| web/src/api/client.ts | M | restartOtter 增第三参 modelAlias，body 组装 |
| web/src/pages/conversation/Modals.tsx | M | RestartModal 模型下拉（settings 数据源 + 默认「不换模型」项） |
| web/src/pages/conversation/index.tsx | M | confirmRestart 签名扩展透传 |
| web/src/pages/conversation/Modals.test.tsx | M | 新增 2 条 RestartModal 模型切换测试 |
