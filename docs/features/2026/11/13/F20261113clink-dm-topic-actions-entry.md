---
id: F20261113clink
title: CoLink Agent App 增加 DM 私聊顶栏入口与 iframe 页面接入
doc_type: feature
summary: |
  extensions/colink-agent-app 补齐 UI 扩展点声明与 iframe 页面：新增 colink.topic.actions
  （DM 私聊顶栏）入口，解决海獭在私聊窗口右上角不显示 iframe 按钮的问题；manifest 0.4.1 → 0.5.1。
change_type: feature
tags: [colink, extension, manifest, dm, iframe]
modules:
  - extensions/colink-agent-app
capability_test: "n/a: 扩展 manifest 与自托管 iframe 服务的声明性/服务性改动，无 LLM 参与行为（A 类），契约测试已覆盖断言"
created_at: 2026-11-13
intent:
  problem: "海獭 CoLink App 在 DM 私聊窗口右上角不显示 iframe 入口按钮：manifest 只声明了 colink.app.home 与 colink.navigation.modules 两个扩展点，漏了 DM 私聊顶栏使用的 colink.topic.actions 扩展点"
  expected_effect: "manifest 声明 colink.topic.actions 入口后，海獭在 DM 私聊顶栏（「联系人信息」按钮旁）渲染 iframe 入口；app.home、项目导航、私聊顶栏三入口统一走 otter.embed view，契约测试断言全部通过"
  verify_by:
    type: behavior_check
---

# F20261113clink：CoLink Agent App DM 私聊顶栏入口 + iframe 页面

## 背景

海獭以 CoLink Agent App 形态接入在线 colink，通过 `extensions/colink-agent-app` 自托管 manifest 与
iframe 页面。0.5.0 已完成 iframe 页面接入（`app.home` 侧边面板 + 项目导航整页两个入口）并部署到 ECS。
搭档验证时发现：colink 应用里能打开 iframe，但**海獭私聊窗口右上角没有 iframe 按钮**。

CoLink 平台侧已合入 PR #3176（https://github.com/colink-group/CoLink/pull/3176）：Agent 私聊顶栏复用
`colink.topic.actions` 扩展点渲染对端 App 入口。海獭侧 manifest 当时未声明该扩展点，所以按钮不出现。

## 根因

manifest 的 `ui.entries` 只声明了 `colink.app.home` 与 `colink.navigation.modules` 两个入口，
漏了 DM 私聊顶栏使用的 `colink.topic.actions` 扩展点——平台渲染能力已就绪，海獭侧缺声明，属声明遗漏而非平台缺失。

## 变更

| 文件 | 改动 |
| --- | --- |
| `src/manifest.mjs` | 版本 0.4.1 → 0.5.1；`ui.entries` 新增 `colink.topic.actions`（DM 私聊顶栏，side_panel），与既有 `colink.app.home`（side_panel）、`colink.navigation.modules`（page_content）三入口统一走 `otter.embed` view |
| `src/app.mjs` | 自托管三个 GET 路由：`/colink/embed.html`（iframe 页面）、`/colink-browser.mjs`（浏览器 SDK 包）、`/page-config.json`（页面握手配置） |
| `src/embed-page.html` | 新增 iframe 页面：`connectPage` 桥接 + 连接状态展示 |
| `assets/otter-icon.svg` | 恢复单色线条图标（CoLink 图标契约禁止渐变/opacity 元素） |
| `test/app-contract.test.mjs` | 契约测试同步 0.5.1 与 `ui` 声明断言（三个扩展点 + view + contractVersion） |

## 验证

- 扩展契约测试全绿：`npm test`（24/24 pass，含 manifest 版本与三个入口断言）。
- 已部署在线环境并由搭档验证：私聊窗口右上角 iframe 按钮正常显示、iframe 页面握手成功。

## Acceptance Test

### 需求推导

- 需求 1：manifest 声明 `colink.topic.actions` 入口，且指向 `otter.embed` view。
- 需求 2：三个入口（app.home / 项目导航 / 私聊顶栏）齐全，契约测试断言覆盖。
- 需求 3：manifest 版本从 0.4.1 升到 0.5.1。

### 权威证据

| 需求 | 证据类型 | 证据 |
| --- | --- | --- |
| 需求 1 | 文件内容 | `manifest.mjs` 中 `extensionPoint: { id: 'colink.topic.actions' }` + `openView.container: 'side_panel'` |
| 需求 2 | 测试结果 | `npm test` 24/24 通过，含三个扩展点断言 |
| 需求 3 | 文件内容 | `manifest.version === '0.5.1'`，契约测试 `assert.equal(manifest.version, '0.5.1')` |
| 需求 1（行为） | 运行时状态 | 搭档在在线环境确认私聊右上角按钮出现、iframe 握手成功 |
