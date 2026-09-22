---
name: signature-convention
description: >-
  Use when: 任何 commit/PR/报告/评审场景需要署名标识责任主体时.
  Not for: 审视流程的编排（召唤检视獭、处置报告、复审循环）→ review-protocol.
  Output: 正确署名的 commit author / PR description 署名行 / review 评论署名行 / 报告署名行.
  能力摘要：外部留痕签名的唯一格式真相源——三处署名格式定义 + 平台快照同步义务.
co_loads: []
category: reference
---

# 海獭署名约定

外部留痕（GitHub commit/PR/review）签名的**唯一格式真相源**。无论大獭还是小獭，在交付物上署名以标识责任主体。本 skill 是查表约定：遇到署名场景时先 read 本 skill，照抄对应格式。

其他文件（skill 模板、参考文档）不保留署名行实体，一律以指针指向本 skill——改格式只改这里。

## 触发

**触发条件**：需要署名标识责任主体时——commit、PR description、review 评论、评审意见。

**排除**：审视流程的编排（召唤检视獭、处置报告、复审循环）→ `review-protocol`。

**输入**：
| 输入 | 必选 | 缺失时 |
|------|------|--------|
| 海獭身份（名号） | 是 | 向父 agent 确认后再署名，不得自行猜测 |

## 工作流

1. **确认身份**：
   - **大獭**（Claude Code 主进程）：身份为"大獭"，从 MEMORY.md 或用户指令中确认
   - **子 agent**（检视獭、开发獭等）：身份由父 agent 在启动时通过 prompt 显式指定，格式示例："你是检视獭，对 PR #N 进行对抗检视"
   - **缺失身份时**：子 agent 不得自行猜测，必须向父 agent 确认后再执行署名操作

2. **按位置署名**（`[海獭名号]` 为占位符，整体替换为实际名号——禁止保留原样或写成 `[海獭名号: xxx]` 填空格式）：

   1. **Commit author**：用 `--author` 参数指定，格式 `名号 <otter-buddy>`
      - 大獭：`git commit --author="大獭 <otter-buddy>"`
      - 开发獭：按召唤时的 name 署名，例如 `开发獭-需求名 <otter-buddy>`（连字符是名号的一部分，非邮箱格式）

   2. **PR description 末尾署名行**：

      ```
      🤖 Generated with [Otter Buddy](https://github.com/chenlaicai/otter-buddy) by [海獭名号]
      ```

      人类在 GitHub 网页创建 PR 时由 `.github/pull_request_template.md` 自动预填（平台快照，见下方同步义务）；獭走 `gh pr create --body-file` 时模板**不会**自动附加，必须手动带上本格式行。

   3. **Review 评论 / 对话内完整报告末尾署名行**：

      ```
      🤖 Generated with [Otter Buddy](https://github.com/chenlaicai/otter-buddy) by [海獭名号]
      ```

      作用域：`gh pr review` 的 comment body、无 gh 工具时的对话完整报告、文档审视报告。

## 快照同步义务（两处，无法消除）

格式实体在真相源之外存在两处快照，机制上均无法指针化，同步义务成文如下：

1. **平台快照** `.github/pull_request_template.md` 尾部署名行——GitHub 网页创建 PR 依赖模板自动预填（`gh pr create --body-file` 不加载模板）。
2. **管道快照** `src/frameworks/agent/identity-builder.ts` 头部「你的身份」段——署名行成品与 commit author 格式随身份每轮注入，是运行时署名格式的实际供给源（格式在场性事实源）。名字（身份）由 otter.name 动态填充。

同步义务：**修改本 skill 的署名格式时，必须同 commit 同步上述两处快照**，反之亦然。

## 指针使用方（本 skill 的消费方清单）

修改署名格式时，下列文件只含指针不含实体，无需改动；若发现下列文件私自内联了署名行实体，视为双源漂移，须改回指针：

- `../code-implementation/references/commit-convention.md` — PR Description 模板署名行
- `../adversarial-review/SKILL.md` — review 评论模板、对话完整报告模板（3 处）
- `prompts/identity/BIG_OTTER.md`「你的名号」节 — 指向身份段的运行时注入（大獭静态路径）

运行时注入关系：skill 文件在运行时不加载——署名行的实际供给源是 identity-builder.ts 管道快照（见上节）。本 skill 是格式定义书与变更流程真相源。

## 产出

| 产出 | 下一步 | 执行者 |
|------|--------|--------|
| 署名完成的 commit / PR / 报告 | 随宿主流程继续（审视/终审） | 当前獭 |

## 参考

- 无外部参考——本文件即格式真相源
