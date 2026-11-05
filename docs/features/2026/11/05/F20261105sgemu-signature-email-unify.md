---
id: F20261105sgemu
title: 署名邮箱统一到搭档 noreply 地址（人/獭区分收敛到名号维度）
summary: 2026-11-05 搭档裁决「名字是名字，邮箱是邮箱」——GitHub 头像点亮/账号归属/贡献图只认邮箱，獭的身份标识靠名号字段（大獭/开发獭-xx）已足够；commit author 邮箱从裸标签 otter-buddy 统一为搭档账号 noreply 地址 41982931+chenlaicai@users.noreply.github.com，同步快照三处（identity-builder.ts 管道注入、signature-convention skill 格式定义、identity-prefix 测试断言）
change_type: prompt
capability_test: "tests/frameworks/agent/identity-prefix.test.ts"
intent:
  problem: "仓库历史 author 邮箱 4 种形态并存（noreply 756 / otter-buddy 裸标签 95 / QQ 邮箱 10 / 杂项 9），搭档核查 colink 提交身份时发现并要求统一；獭的 commit 因邮箱不关联账号而头像灰、贡献图不计"
  expected_effect: "增量 commit 全部统一挂 chenlaicai 账号 noreply 邮箱（头像点亮/贡献归属一致），人/獭区分收敛到名号维度；存量历史不动。新会话身份注入携带新格式"
  verify_by:
    type: behavior_check
    detail: "tests/frameworks/agent/identity-prefix.test.ts 断言身份段含新邮箱格式（vitest 16/16）；合入后新会话首个 commit 的 author 邮箱为新格式"
created_in_conversation: e2819402-5088-4e64-9420-fca091d3e040
created_at: 2026-11-05
tags: [signature, identity, git]
---

# 背景

2026-11-05 对话中搭档核查 colink 提交身份，发现仓库历史上 author 邮箱有 4 种形态（noreply 756 / otter-buddy 裸标签 95 / QQ 邮箱 10 / 杂项 9）。搭档问「能统一起来吗」，并进一步指出「名字是名字，邮箱是邮箱，獭的身份不能通过名字来吗」。

裁决要点（搭档原话：「就这样呢」确认执行）：
- 邮箱维度：统一为 chenlaicai 账号的 noreply 地址——头像点亮、贡献归属一致
- 身份维度：靠 author 的 name 字段（大獭 / 开发獭-xx）区分人/獭，邮箱不再承担身份标识职能
- 存量历史 commit 不动（filter-repo 重写断锚点，负收益）；只改增量

## 改动清单

| 文件 | 改动 |
|---|---|
| `.pi/skills/signature-convention/SKILL.md` | commit author 格式定义 `名号 <otter-buddy>` → `名号 <41982931+chenlaicai@users.noreply.github.com>`，附设计说明与裁决记录 |
| `src/frameworks/agent/identity-builder.ts` | 管道快照（运行时实际供给源）同步：身份段 commit author 行同步改邮箱 |
| `tests/frameworks/agent/identity-prefix.test.ts` | 注入断言同步（大獭/检视獭两行） |

PR description / review 评论的署名行（`🤖 Generated with ... by 名号`）不含邮箱，无需改动。`.github/pull_request_template.md` 平台快照同为纯名号署名行，无需改动。

## 不改的东西（明确边界）

- 存量历史 commit：不 filter-repo、不 force-push（756 个 SHA 变更会断特性文档锚点/healing 台账/PR 引用）
- 署名行格式（Generated with Otter Buddy by 名号）：身份标识职能不变
- `tests/guard/replay/cases-2026-10-29.ts`：回放测试用例记录的是历史命令原文（当时 author 确实是 otter-buddy），历史事实不改——这不是格式定义点

## 配套本地配置（非 git 追踪，随本特性一并落地）

- `~/.gitconfig` user.name: chensg → chenlaicai；user.email: QQ 邮箱 → 41982931+chenlaicai@users.noreply.github.com（2026-11-05 已改，见对话记录）
- colink-repo 工作区副本的本地残留配置（修复獭-交接落位）已清除

## 验证

- tests/frameworks/agent/identity-prefix.test.ts 更新断言后本地通过（CI 全量复核）
- 合入后新会话的身份注入段将携带新邮箱格式，首个新 commit 生效
