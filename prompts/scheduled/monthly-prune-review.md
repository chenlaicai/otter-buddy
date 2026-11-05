---
task_name: 月度剪枝审视（D3 剪枝出口）
---

月度剪枝审视（RRSI 纪律移植自 D3 剪枝出口设计）。生成候选清单呈搭档裁决，判断委托：候选不足 3 项或代理信号均不可靠时，如实报「本月无需剪枝」不硬凑。

三层候选源（全部附检索方式与命中明细，供裁决者质疑）：
1. skill 层：对 .pi/skills/ 全量 skill，逐个 search_memory 检索「skill 名」的最后实质引用 + list_messages 检索对话流提及——静默超 90 天入候选。注意代理信号局限：命中可能是「讨论」而非「使用」，清单必须附命中明细原文。
2. 机制层：sqlite3 直查 otter-buddy.db——RHI stalled/regressed 态特性链（链长期无推进/出过回退）+ scheduled_task_executions 长期零产出任务。
3. **守卫层（拦截审计已接通）**：对 `healing_events` 近 30 天 `guard_intercept` 按 ruleId/层/保证等级聚合，至少列出：拦截数、涉及獭数、high 数、最近发生时间、已处置误报数；file-tool-guard 另按 toolName/operation 分组。无分母时只报计数，不编造误报率。输出保留/退化/删除候选及替代物理/结构化证据；新增或解冻 bash 规则族必须呈搭档 L2 裁决，普通 PR 不得自批。已知 known-hole 与超边界样本入核销，不自动转成新规则。
   **活跃/历史分层口径**：现行活跃规则清单 = file-tool-guard*（结构化前缀族）+ self_kill_main / self_kill_byname / self_kill_process_group / cred_dir_access / network_exfil / download_exec（guard-v4 七条；nonliteral 详见下句）。**不在清单内的 ruleId（如 self_kill_indirect / self_kill_script_stop / main_write / script_file_exec 等 v3 退役规则，及下句所列退役规则的历史归因）为已处理封存账**——数据原样保留（审计连续性，历史事件按当时 ruleId 落库），但聚合时单列「历史归因」分层展示，不进活跃候选、不再作为待归口/清理对象反复呈报。活跃清单与 src/frameworks/agent/guard-intercept-classify.ts FINGERPRINTS 同维护（规则增删时同步本口径，同 PR）。另：guard bounce 流程观测（二拦终态回发/疑似误拦降级）已拆至独立 error_type `guard_bounce_flow`，非拦截事件，不在本口径内；其历史数据仍留 guard_intercept+context.bounce:true，聚合时同样单列不入拦截账。退役规则（拦截本体已删、指纹保留仅历史归因）：self_kill_nonliteral——2026-11-05 kill 守卫政策 A（非字面量目标能确认才拦，确认不了放行）随拍板退役，存量 healing 归因分类仍可用，详见同日特性文档。
   参考查询：`SELECT json_extract(context,'$.ruleId') AS rule_id, json_extract(context,'$.ruleLayer') AS layer, json_extract(context,'$.assurance') AS assurance, count(*) AS hits, count(DISTINCT otter_id) AS otters, sum(severity='high') AS high, max(created_at) AS last_seen FROM healing_events WHERE error_type='guard_intercept' AND json_extract(context,'$.bounce') IS NOT true AND created_at >= datetime('now','-30 days') GROUP BY rule_id,layer,assurance ORDER BY hits DESC;`（若无 assurance 字段，按空值分组即可；`bounce IS NOT true` 过滤历史 bounce 计数记录——它们是流程记录非拦截，混入会污染拦截聚合）。
4. **issue 层**：全量 open issue，实质静默超 14 天入候选（统一阈值）——「实质静默」判定：无认领、无关联 open PR、无评论推进，例行 ping / 标签补齐 / 重开不算实质更新。判定材料：`gh issue list --state open --json number,updatedAt,comments --jq` 取最后评论时间（gh comments 最后评论日作「最近活动」代理，不逐条判实质/例行，判读成本高——月度频率可接受）；P0/P1 bug 类 issue 不入剪枝候选（高优排期项，不是剪枝对象）。候选项附：静默天数 / 有无验证断言与关闭标准 / 最后实质动作。批量处置：可合并（同域同根因）/ 可关闭（关闭标准已满足或已被取代）/ 待搭档特赦（写明为何留）——批量操作一律呈卡裁决后执行，不自行关。
5. 禁用项：orphan 态是 doc-gap 语义不是僵尸组件，不进候选；prompt 段落层首轮不实现（F 文档决策）。

产出：html-card 候选清单卡（组件名/最后引用时间/静默天数/命中明细/删除影响面/建议动作：删/留观/保留），逐项留 otterCard.submit 按钮交搭档裁决。删除一律走 PR 可回滚（剪枝 PR 与功能 PR 同标准：同签名同审视）。

退役条件（自动监测）：连续 3 个月清单为空，或搭档连续 3 轮全部拒绝候选 → 报告搭档建议撤销本任务，留 feature 文档记录退役原因。

边界：只做候选生成与呈报，不自行删除任何组件；裁决权恒在搭档。
