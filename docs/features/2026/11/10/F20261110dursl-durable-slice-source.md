---
id: F20261110dursl
title: 前世切片读取适配 durable（修换世档案恒机械转储）
summary: "#1783 迁移后前世对话住进 durable sqlite，而叙事合成的原料读取器仍是 JSONL 实现（只认 .jsonl）→ 换世档案 100% 降级机械转储（「前世 session 文件读取失败」）。修复：readCurrentSessionEntries 增加 durable 分支——零副作用直读 sqlite（readonly 连接，不走 Harness.open 以防 probeFirstTurn 在正常 invoke 期触发 recoverAfterReopen 误 abort 在跑任务），投影当前世代 entries（head 边界=最新 reset/compaction）为 coding-agent SessionEntry 面（含 compaction→summary 跨代种子），真空/缺失语义保留（[] vs undefined）。"
change_type: bugfix
capability_test: "tests/frameworks/agent/durable-slice-source.test.ts 7 例：投影形状/parentId 链/时间戳单调、世代边界、真空 vs 缺失、compaction 映射、切片器端到端 keptEntries、工厂 durable 分支接线"
created_in_conversation: b4e05359-7a17-4478-8774-162360569279
causal_links:
  from: [F20261109pidrx, F20261110genrs]
  supersedes: []
tags: [session, durable, handoff, narrative-synthesis]
modules:
  - src/frameworks/agent/durable-slice-source.ts
  - src/frameworks/agent/pi-session-factory.ts
---

# 前世切片读取适配 durable（F20261110dursl）

## 问题（M-9af49d4a R2，#1783 迁移欠账）

换世「前世档案」的叙事合成需要读前世完整对话做原料。#1783 后前世在 durable
sqlite，读取器（readCurrentSessionEntries）只认 `.jsonl` → 恒拿不到原料 →
2026-11-10 08:04 迁移生效以来每次换世档案都降级「机械转储」。质量降级
（缺 LLM 叙事摘要层），无正确性损失；由 #1811 排查顺带发现。

## 方案

readCurrentSessionEntries 增 durable 分支（jsonl 分支原样保留服务未迁移账本）：

1. **零副作用直读**：better-sqlite3 readonly 连接查 entries 表（根 conversation），
   不走 Harness.open——probeFirstTurn（正常 invoke 期 buildDynamicContext）也调
   此处，open 的 recoverAfterReopen 会误 abort 在跑任务。
2. **世代边界**：最新 head 持有条目的 head 值 = 活动上下文首条（reset/compaction
   语义），投影仅当前世代——与换世「前世=当前 session」语义对齐。
3. **投影形状**：coding-agent SessionEntry 面（session-slicer/buildSessionContext
   消费）：{type:"message", id/parentId 链/合成单调 timestamp, message}；pi.compaction
   → {type:"compaction", summary}（getLatestCompactionEntry 跨代谱系种子）；
   无 model 载荷的记账条目跳过。durable 无 timestamp——合成单调值仅骨架/展示用。
4. **降级归因语义保留**：undefined（无库/读失败）vs []（真空 session）——
   collectJsonlSlice 据此区分 jsonl-read-fail / empty-session。

## 已知边界

- 直读耦合 durable 1.5.0 entries 表结构（kind/model/head 字段），表结构由
  durable_schema 版本化；上游 breaking 时本投影属显式适配点（与运维查库同模式）。
- 保留段截断锚（getCurrentSessionFile）返回账本路径——durable 下即 plain 库路径，
  新世獭 read/bash 可直接定位，无需改动。

## 验收

- 7 例回归全绿（形状/边界/真空/compaction/切片器端到端/工厂接线/缺失降级）
- 全套 agent+otter 679/680（唯一失败 SIGKILL 为已知环境抖动，检视獭-1811 于
  12:19 在同 head 单跑通过 557ms）
