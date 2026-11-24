---
id: F20261124msprt
title: M3 协议真相源与核心 Prompt 只降 ratchet
summary: 消除 SMALL_OTTER 与 SYSTEM/speak 工具之间的 signal 通道矛盾，并把 SYSTEM、BIG、SMALL 纳入现有 prompt 体积与一致性门禁。
change_type: fix
doc_type: feature
created_at: 2026-11-24
created_in_conversation: a23f0f4a-612c-46e9-8d83-be648ced720e
capability_test: "n/a: 纯 A 类静态 prompt 契约与 lint CLI 行为，由 tests/scripts/lint-prompt-size.test.ts 真实子进程测试覆盖"
tags: [prompt, signal, lint, ratchet]
modules:
  - prompts/identity/SMALL_OTTER.md
  - scripts/lint-prompt-size.mjs
  - tests/scripts/lint-prompt-size.test.ts
intent:
  problem: "SYSTEM 与 speak 工具已规定 signal 走结构化参数，SMALL_OTTER 却仍要求把 <signal> 标签嵌进 body；同时核心常驻 prompt 不在现有体积门禁内，旧协议回流和体积膨胀都缺少机械阻断。"
  expected_effect: "三份核心 prompt 不再含肯定式 body <signal> 指令，SYSTEM/SMALL 指向 speak.signal；SYSTEM=24089B、BIG=16143B、SMALL=8442B 建立只降预算，任一文件增加 1B 或旧 SMALL 指令回流时 lint exit 1。"
  verify_by:
    type: static_only
    rollback: "git revert 本 PR 的 prompt、lint 与测试变更；无运行时状态或数据迁移。"
    risk_note: "ratchet 是有意的只降维护约束；未来确需增加核心 prompt 体积时，必须单独评审预算，而不是顺带抬高。"
---

# M3 协议真相源与核心 Prompt 只降 ratchet

## 背景与基线

实施基线为 `origin/main@cdbb786788d6bf20984d2307dd0d95e2eddef6e8`。该版本中：

- `.pi/SYSTEM.md` 与 speak 工具 schema 已使用结构化 `signal` 参数；
- `prompts/identity/SMALL_OTTER.md` 仍指示在 speak body 内嵌 `<signal>`，并给出旧标签示例；
- `prompts/identity/BIG_OTTER.md` 只规定大獭裁决义务，无旧发送指令，无需修改；
- `scripts/lint-prompt-size.mjs` 只覆盖 scheduled prompt，核心三文件没有体积或协议一致性约束。

## 设计取舍

复用现有 `lint-prompt-size.mjs`，不新增平行脚本或运行时抽象。核心文件按本分支实际 UTF-8 字节数设置只降上限，不借机压缩或改写其他规则。协议检查只扫描 SYSTEM/BIG/SMALL：否定式提及旧标签合法，肯定式指令与旧示例均失败；另检查 `SPEAK_SIGNAL_PARAM_SCHEMA` 定义及 tool-factory 接线仍存在。

`--core-root` 只用于对另一份核心 prompt 树执行同一 lint，使测试能在临时目录构造旧协议和超预算输入，而不改写仓库真相源。工具 schema 始终从当前仓库读取，避免 fixture 自证。

## 变更

1. SMALL_OTTER 改为 speak 的 `signal` 结构化参数，保留 objection 锚点、blocked 已试清单、severity、yield 与 halt 边界。
2. 现有 prompt lint 纳入三份核心文件及只降预算，并校验结构化 speak.signal 契约。
3. 测试通过真实子进程验证旧 SMALL 会失败、当前三文件与工具 schema 会通过、三个核心文件分别增加 1B 都会失败。

## 非目标

- 不实现 PromptComposer，不修 H1/H2，不改运行时工具或数据格式。
- 不改 SYSTEM/BIG 的其他 prompt 语义，不顺手压缩核心 prompt。
- 不处理 P1/P2，也不重开终版审视中的其他发现。

## Acceptance Test

| 场景 | 操作 | 预期结果 |
|---|---|---|
| 旧协议负例 | 在临时 SMALL 写入原 body `<signal>` 指令，运行 lint | exit 1，指出 SMALL 与旧 body 标签 |
| 当前真实资产 | 对仓库运行 `npm run lint:prompt-size` | exit 0；三文件纳入预算，speak.signal schema 检查通过 |
| 核心预算负例 | 分别给临时 SYSTEM/BIG/SMALL 追加 1B 后运行 lint | 三次均 exit 1，并指出对应文件超 ratchet |
| scheduled 回归 | 重跑原 lint-prompt-size 测试 | 原预算、警告、frontmatter、override、不可读目录用例保持通过 |

## Verification

### 失败用例证据（bugfix）

先只加入新测试、尚未修改 lint 与 SMALL 时执行：

```text
npx vitest run tests/scripts/lint-prompt-size.test.ts --disable-console-intercept
Test Files  1 failed (1)
Tests  5 failed | 5 passed (10)
```

五个新增 M3 用例全部失败：旧 SMALL 未被拒绝、无结构化参数检查输出、三个核心文件追加字节后仍 exit 0。修复后同一命令为 `1 passed / 10 passed`，`npm run lint:prompt-size` 为 exit 0。

### 回归与最简检查

已过最简检查：复用现有脚本、Node 标准库和既有子进程测试设施，无新依赖、无新运行时代码。负面向核查：未删除 scheduled prompt 的 10000B 上限、8000B 警告线或 per-file override；核心检查只增加阻断，不放宽任何既有保护。

Golden Gate / 锚点重放：`n/a`（`verify_by=static_only`）。本批是由真实文件与工具 schema 可完全判别的协议矛盾修复及静态预算门禁，不引入需要模型措辞质量评判的新场景；旧协议负例、真实资产和超预算行为均由真实脚本执行验证。

## 回滚

整体 revert 本 PR 即可恢复 SMALL 旧文案及原 scheduled-only lint；无数据库、durable session 或配置迁移，无运行时副本需要回填。回滚会重新引入已知的 prompt 协议矛盾，因此若后续 C1 已依赖本契约，应先回滚 C1 或提供等价替代门禁。
