---
id: F20261110genrs
title: 换世改为 durable 同库 reset（修复压缩=交接空转与水位循环）
summary: "#1783 迁移后换世登记 ${otterId}-${uuid}.sqlite 世代文件而打开路径恒用 plain 库，换世只翻账本不换 transcript——水位交接反复触发成循环、7 行幽灵账本、前世档案恒机械转储。修复：世代物化为库内 pi.reset entry + head（durable 原生多世代），账本恒指 plain 库，reset 后边界守护（校验失败=响亮失败），旧 JSONL 账本行换世时归一。"
change_type: bugfix
capability_test: "tests/frameworks/agent/durable-handoff-reset.test.ts：断崖（reset 后模型上下文不含前世 marker）/重开持久/多世代/账本恒指 plain+零世代文件/存量 JSONL 账本归一"
created_in_conversation: b4e05359-7a17-4478-8774-162360569279
causal_links:
  from: [F20261109pidrx]
  supersedes: []
tags: [session, durable, handoff, compaction, p0]
modules:
  - src/frameworks/agent/pi-session-factory.ts
  - src/frameworks/agent/durable-session.ts
---

# 换世改为 durable 同库 reset（F20261110genrs）

## 问题（2026-11-10 生产，issue #1810）

搭档报告：大獭触发压缩（=水位交接）后上下文仍 400k+。

**架构前提**：海獭的压缩=交接（F20260920uhuc）——应用层水位线（1M 窗口 ≈340K 触发）
不走原地压缩，走「封存前世→换 session」。

## 根因（第一性原理）

JSONL 时代会话身份有**单一事实源**：账本（agent_sessions.session_file）。换世（写者）
登记新文件、打开（读者）读账本，身份变更天然一致。#1783 迁移把读者改成硬编码
`durableFile(otterId)`=plain 库、写者仍登记 `${otterId}-${uuid}.sqlite` 世代文件——
「必须一致的两份记录，从此没有强制一致机制」：

- 世代文件从未被创建（磁盘 0 个双 UUID 文件）；
- 新世 invoke 打开 plain 老库继续长（106a95b6：765 entry 单 conversation 连穿 ≥3 世代，
  0 个 pi.reset、0 个 head）；
- 换世一切可见信号全是绿的（✅前世已封存/世代数+1/账本翻新）——失效完全静默。

### 三连伤

1. **水位循环**：上下文不降 → 每隔几轮再触发交接（11/10 晨 8 场，同一獭 40 分钟三连）
2. **幽灵账本**：7 行 agent_sessions 指向不存在文件
3. **前世档案 100% 机械转储**：合成引擎读前世文件拿到 ghost/旧 JSONL 路径恒失败

### 为什么审视/CI 没拦住

- 测试盲区：无任何 durable 路径换世测试；断言停在「流程跑通」，无「换世后上下文必须清零」硬断言
- 审视焦点错位：#1783 四项发现全在 invoke 链；交接链被当「沿用既有机制」未重审
- 成功假象：换世可见反馈全正面；水位是唯一报警器，而它报警的方式是再换一次世

## 方案（评估标准：不变量恢复/基座一致性/故障收敛/可审计/可验证，五维全优）

**世代物化为库内 reset 边界**（durable 原生多世代语义）：

1. `_resetInternal`：账本恒指 plain 库（`registerDurableSession(otterId, durableFile(otterId))`），
   删除世代文件登记；随后对会话执行 `conversation.reset()`（写 pi.reset entry + head，
   前世=reset 点之前 entries 同库可审计）。
2. 活句柄优先：池内有句柄直接用（免二次开库）；冷启动走 `openResetOnlySession`
   轻量开（无工具面/不入池/不注册活跃集），reset 后即关。
3. **守护（把静默空转变成响亮失败）**：`resetForGeneration` 落盘后校验最新可见
   entry 为 pi.reset 且 head 非空，不满足即抛错——unifiedHandoff 捕获后向搭档
   显式报「交接未能完成」。流中到达同样抛错（接线错误不该静默带病）。
4. 换世时旧 JSONL 账本行归一到 plain durable 路径（存量账本自愈）。
5. 多世代语义保留：应用层 Session Chain（otter_sessions 世代行/reason/档案摘要）
   原样不动；世代在运行时层从「文件链」变为「同库 reset 边界链」。

### 已知语义差异（有意取舍）

- pi.provider 会话身份（provider prompt-cache 亲和键）跨 reset 不变——换代后 cache
  反正 miss，无正确性问题；fork 可换新身份但需「当前 conversation 书签」＝重回双记录。
- rawContext 只含活动上下文：世代边界历史用库查询（entries 表 kind=pi.reset）。

## 验收（回归断言）

- 换世后：库内存在 pi.reset 且 head 非空（守护内建+测试直查库）
- 换世后下一轮：模型上下文对前世 marker **断崖**（不是流程成功而是水位清零）
- 账本 session_file 与实际打开文件一致、零世代幽灵文件
- 重开库世代边界持久、前世不回流；连续多世代只含最新世代
- 旧 JSONL 账本行换世归一

## 范围外（后续独立 PR）

- R2 前世切片读取适配 durable sqlite（修「档案恒机械转储」；A 方案下前世=同库
  reset 点之前 entries，天然可读）
- R3 存量修复：7 行幽灵账本矫正 + 2 只 400k 大獭修后手动换世恢复
- R5' 观测补强：换世后水位进 metrics（本次已含边界守护，metrics 为增量）

## 证据锚点

- 引入提交：8e562834（PR #1783）；失配点 pi-session-factory.ts:553（登记） vs :1384（打开）
- 生产实库：data/durable-sessions/{106a95b6,94d41f8d}*.sqlite（0 reset/0 head 连穿世代）
- 日志：.otter-buddy.log 11/10 段（「Durable session opened」恒 plain 路径 ×57；
  「generation replaced」×28 全空转；水位交接 8 场）
- matter：M-9af49d4a
