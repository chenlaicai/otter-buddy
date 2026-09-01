---
id: F20260901rhdt
title: "健康面板重设计 PR1：信号与链数据修真"
summary: "为复发模式卡/泳道时间线补结构化数据——evidence_detail 全类型 commit 序列、chain_stall 置信分层（规则甲）、active 值止血收编、链详情端点、upsert UPDATE 侧刷新、存量库补列迁移。UI 形态不变。"
change_type: feature
status: development
created_at: 2026-09-01
created_in_conversation: 7c6e78b5-6fdc-462e-9383-4d96cf95dcd7
capability_test: "n/a: 纯数据层改动（schema迁移+检测器补结构化详情+端点透出），无 LLM 行为涉及"
intent:
  problem: "UI 层（复发模式卡 bug●→fix● 时间轴、链泳道）依赖的数据形态不存在——复发信号只有文本 evidence（sha 塞字符串里），链 DTO 无 commit 数组；18 条 chain_stall 全是「干完没归档」误报（实查 18/18 有 commit、0 doc-only）；41 篇 status:active 文档被链判定白名单静默豁免。先把模式存成结构化数据，UI 才画得出模式。"
  why_now: "chen 确认三期方案方向（效果图已过目）+ 大獭×论衡合议定稿（review-lunheng.md）。数据修真是 PR2/PR3 的前置——不先补数，复发卡和泳道都是无米之炊。"
  expected_effect: "前端可从 evidenceDetail.commits 画交替时间轴、从链详情端点取泳道数据、按 confidence 折叠 18 条假警报；active 文档参与病态判定消除现网盲区。"
---

## 方案

### 数据设计

- "signals 表新增 evidence_detail TEXT（JSON：{kind, windowDays, commits[{sha,date,changeType,message}]}）+ confidence TEXT（normal/low，NULL=normal 兼容存量）"
- "detail 语义=窗口整体重算覆盖（窗口滑动后旧 commit 出窗），非 append；调用方未传时 COALESCE 保留旧值（旧行为调用方不受影响）"
- "置信规则甲：chain_stall ∧ commitCount≥1 → low（「干完没归档」大概率误报）；zombie 与 doc-only 滞留保持 normal（异常更实）——原方案「有合入证据=低置信」在 main-only 扫描下无区分度（链上 commit 全已合入），合议废弃"

### 关键改动

- "detect-signals.ts：bug_recurrence 触发后第二遍收集窗口内全类型 commit 序列（含 changeType 标注）——只有 bugfix 画不出交替节奏；chain_stall 附 confidence"
- "signal-repository.ts：upsert UPDATE 分支同步刷 evidence_detail/confidence（只刷旧三字段的 bug 会让存量信号置信分层永远不更新）；INSERT 分支写入两列"
- "signal-pipeline.ts：processOne 拆出（lint 行数限制），透传 detail/confidence"
- "chain-builder.ts：ACTIVE_DOC_STATUSES 收编 active（41 篇文档止血；值域系统性归一见 Issue #646）"
- "rhi-controller.ts：signals 端点透出 evidenceDetail（safeParseJson 降级）+ confidence；新增 GET /api/health/chains/:featureId 链详情（全类型 commits 序列，sha 截 8 位）"
- "migration.ts：ensureSignalsEvidenceColumns 存量库 ALTER 补列（PRAGMA 检测幂等，与 introduced_by_pr 同模式）；schema.ts 新库 CREATE 含两列"
- "web client.ts：RhiSignalDTO 增 evidenceDetail/confidence 字段；新增 RhiChainDetailDTO + getRhiChainDetail"

### 范围说明

"Issue #644 = 合议定稿五期之首（A 数据修真）；#645 检测器指标 / #646 状态机 / #647 总览UI / #649 泳道后续。计数口径统一项实查降级：overview 与 web 已是 open 口径，无需改码，本文档记录验证结论。"

## 验证

### 测试与自检

- "detect-signals.test.ts 新增 4 用例：detail 全类型序列（5 节点含 New Feature/BugFix 交替、时间升序）、窗口滑动出窗 commit 不入 detail、置信规则甲（stalled+commit→low / doc-only→normal）、active 收编后不再豁免"
- "signal-repository.test.ts 新增 4 用例：首插落列、UPDATE 分支刷新（合议 §3.1 坑）、COALESCE 不覆盖、存量库补列迁移幂等"

"根仓 194 files / 2406 tests 全绿；web 36 files / 311 tests 全绿；tsc --noEmit 0 错误；eslint 0 error（5 warning 均为存量 no-console）"

"已过最简检查——未新造表/依赖，复用 signals 表加列（JSON 列而非 commit 专表：单文件序列数据量小，与 evidence 文本同级）；链详情复用 buildChainsOnce 内存过滤而非新查询路径"

"无 pre-existing 失败（基线全绿）"

## 后续

"PR 审视通过后呈搭档终审；后续 Issue B(#645)/C(#646) 可并行开工，D(#647) 依赖本 PR 合入"

"PR2 复发模式卡消费 evidenceDetail.commits；PR3 泳道消费链详情端点；低置信抽屉消费 confidence=low"

关联 issue：

"https://github.com/chenlaicai/otter-buddy/issues/644"
