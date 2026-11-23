---
id: F20261123grdls
title: "durable 前世读取、身份与技能接线确定性修复"
summary: "从已关闭的 #1830 拆出低成本、可确定验证的修复：前世切片改走公开只读 Storage 契约，身份每轮进入模型 system 面且池刷新不再清空，普通档接回 skills 而 restricted 外部档不泄露内部技能清单。不带入 base/head 各 17 轮的真 LLM 统计协议。"
change_type: fix
capability_test: "tests/frameworks/agent/durable-model-visible.test.ts + durable-slice-source.test.ts + durable-runtime.test.ts + external-session-profile.test.ts"
intent:
  problem: "durable 会话的前世读取消费者直接依赖 SQLite 表结构，身份未稳定进入模型 system 面，skills 未显式接回；池刷新还会用 undefined 清空已有身份。"
  solution: "用公开 Storage 当前世代查询替换消费者拼 SQL；每轮调用刷新 identity，options 局部刷新保留旧身份；普通档显式注入 skills，restricted 档传空。"
  expected_effect: "重启后能读取当前世代真实原料，模型稳定收到身份与普通档技能列表，受限外部会话看不到内部技能名称、描述和路径；全部验证为零外部 LLM 调用。"
  verify_by:
    type: static_only
created_in_conversation: c2f347c6-7e59-4e2e-ab48-10f64a5a1258
causal_links:
  from: []
  supersedes: []
tags: [durable, session, identity, skills, storage, cost-discipline]
modules:
  - src/frameworks/agent/durable-slice-source.ts
  - src/frameworks/agent/durable-session.ts
  - src/frameworks/agent/pi-session-factory.ts
  - tests/frameworks/agent/durable-slice-source.test.ts
  - tests/frameworks/agent/durable-runtime.test.ts
  - tests/frameworks/agent/external-session-profile.test.ts
---

# durable 前世读取、身份与技能接线确定性修复

## 编号溯源与产出比决策

原 #1830 把真实 bug 修复、faux CI、parity、共享提示词行为改动和 base/head 各 17 轮真 LLM 非劣协议捆在一起。搭档于 2026-11-23 决定按产出比处理：关闭 #1830，只拆出有用且能确定验证的修复；本编号使用当天日期 `20261123`，旧分支历史保持原样。

本 PR 不带入那套全量真 LLM 统计考试，也不借机降低其他现有门禁。验证全部使用 faux 模型、真实 SQLite 和装配断言，外部 LLM 调用为零。

## 修复范围

1. **前世读取不再认识 SQLite 表结构**：通过 pi-durable 公开 `findLatestHeadMarker` 与分页 `scanEntries` 读取根会话当前世代；只读连接不开 Harness、不执行写迁移，缺文件仍为 `undefined`、真空仍为 `[]`。
2. **身份稳定进入模型 system 面**：每次 invoke 都刷新 `identity`；池命中只刷新 invoke/prompt 时，`identity=undefined` 不再清空既有身份。
3. **skills 显式接回但受限档隔离**：普通 durable 会话通过 ResourceLoader 注入技能清单；restricted 外部会话传空，避免泄露内部 skill 名称、描述与绝对路径。

## 明确不带入

- base/head 各 17 轮、共 34 轮的全量真 LLM 非劣运行及其证据框架。
- faux 全量 CI job、parity 许可文件和共享提示词行为改造。
- wait 时序、stop-word、signal 协议等与本组 durable 修复无直接关系的变更。

## 验证

- `tests/frameworks/agent/durable-model-visible.test.ts`：本地录音网关捕获两轮共 4 次真实 wire 请求，逐次断言 system 含身份，首轮另断言 `<available_skills>` 与实际 skill 名；零外部 LLM。
- `tests/frameworks/agent/durable-slice-source.test.ts`：公开 Storage 下界与翻页、真实会话投影、重启世代边界、压缩、空/缺失语义。
- `tests/frameworks/agent/durable-runtime.test.ts`：options 局部刷新保留身份，并跑既有 durable 运行回归。
- `tests/frameworks/agent/external-session-profile.test.ts`：同一装配面断言 restricted 的 `skillsPrompt` 为空、普通档接回技能清单。
- `npm run build` / `npm run lint` 与全仓单测作为最终机器门；结果以 PR 当前 HEAD 的 CI 为准。

## 回滚

revert 本 PR 的 squash commit 即恢复旧读取与装配方式；不改数据库 schema，不执行数据迁移。
