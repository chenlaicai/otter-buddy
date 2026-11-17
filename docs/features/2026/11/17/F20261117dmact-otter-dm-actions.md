---
id: F20261117dmact
title: 海獭 CoLink App 改声明 colink.dm.actions（撤销 colink.topic.actions）
doc_type: feature
summary: |
  CoLink 平台拆出独立扩展点 colink.dm.actions（PR #3341），Agent 私聊顶栏不再复用
  colink.topic.actions。海獭 manifest 随之撤销 otter.topic（colink.topic.actions）、改声明
  otter.dm（colink.dm.actions），manifest 0.5.1 → 0.5.2。根因：colink.topic.actions 是话题操作
  扩展点，平台在频道话题标题栏/消息操作栏/DM 顶栏三处渲染，声明一次即三处全出现，且 personal
  兜底会把个人空间海獭带进未安装海獭的项目频道话题栏。
change_type: feature
tags: [colink, extension, manifest, dm]
modules:
  - extensions/colink-agent-app
capability_test: "n/a: 声明性 manifest 改动，契约测试已覆盖断言（entry 拆分为 colink.dm.actions 且不再含 colink.topic.actions）"
created_at: 2026-11-17
intent:
  problem: "海獭声明 colink.topic.actions 以获得 DM 私聊顶栏入口，结果按钮同时出现在频道话题标题栏与消息操作栏，个人空间安装经兜底泄漏进项目频道话题栏（搭档实测确认，拍板修正）"
  expected_effect: "海獭只声明 colink.dm.actions，入口仅出现在 Agent 私聊顶栏；频道话题标题栏与消息操作栏不再出现海獭；契约测试全绿"
  verify_by:
    type: behavior_check
---

# F20261117dmact：海獭改声明 colink.dm.actions

## 背景

F20261113clink 为让海獭出现在 DM 私聊顶栏，声明了 `colink.topic.actions`（当时 CoLink 平台
采用「DM 顶栏复用话题操作扩展点」的方案，PR #3176）。搭档实测发现问题并拍板「复用是错误决策」：

- `colink.topic.actions` 是话题操作扩展点，平台在**频道话题标题栏**、**消息操作栏**、**DM 私聊顶栏**
  三处宿主渲染，manifest 入口无宿主限定字段——声明一次即三处全出现；
- 项目语境 personal 兜底规则（项目没装该 App 时由查看者本人 personal 安装顶上、标「仅你可见」）
  把个人空间的海獭带进了未安装海獭的项目频道话题栏。

CoLink 平台侧已拆出独立扩展点 `colink.dm.actions`（CoLink PR #3341，特性文档 F20261116dmpoint），
本特性同步修正海獭侧声明。

## 变更

| 文件 | 改动 |
| --- | --- |
| `src/manifest.mjs` | version 0.5.1 → 0.5.2；`otter.topic`（colink.topic.actions）→ `otter.dm`（colink.dm.actions，side_panel，otter.embed view） |
| `test/app-contract.test.mjs` | 版本断言 0.5.2；入口断言改 colink.dm.actions；新增「不再声明 colink.topic.actions」断言 |

## 验证

`node --test test/app-contract.test.mjs`：3/3 通过。

## 联动

- CoLink 平台 PR #3341：拆出 `colink.dm.actions` 扩展点、DM 顶栏渲染点切换、topic.actions 恢复纯频道话题操作。
- 本特性与 CoLink 侧 F20261116dmpoint 同一特性，需先后合入（平台先、App 后），中间窗口期旧版海獭在 DM 顶栏暂不显示入口。