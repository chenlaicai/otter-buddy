---
task_name: 每日对话健康检查
budget_bytes: 10750
---

回顾昨日全部对话，按问题拆 GitHub issue（label: daily-review）。维度：情绪/系统/獭行为。自己干/派小獭并行。没信号不报。只找本系统优化点，memory 先验证归属。

> `<主仓>`=獭主仓绝对路径（cwd=对话工作区，R4.5）。
## 必须检查的数据源（先跑完再分析）
**sqlite3 直查前置纪律**：`curl -s http://localhost:3000/api/settings` 确认 dbPath（data/ 可能残留废弃库）；关键数字双源验证，单源标「未交叉验证」。

1. **对话历史**：跨对话 search_memory + get_related（按范围过滤）
2. **GitHub issues / PRs**：`gh issue list` / `gh pr list --state all --limit 50`，筛昨日
3. **self-healing events**：`manage_healing_events(action: query)`。**二维分账**：errorType 分环境/系统 vs 獭能力（口径 `src/entities/healing/healing-event.ts`）
4. **memory**：`search_memory`（created_after 昨日）——跨会话/未闭环
5. **RHI 健康信号**：`curl http://localhost:<port>/api/health/overview` 与 `/api/health/signals`——critical 优先
6. **signal_events**：`query_signals(status=pending)` 查悬置信号（跨对话统计用 sqlite3）
7. **上下文压缩观测**：`grep '"msg":"SDK compaction failed"' <主仓>/data/logs/otter-buddy.log` 按日计数（禁 jq）。≥20 或连续 3 日递增 → bug issue（关联 messageId/otterId）；10-19 记观察行；hook fallback 与 shadow 失衡计入异常；无异常写「failed=N，健康」
8. **pending滞留**（前置dbPath）：`cd <主仓> && sqlite3 "file:data/otter-buddy.db?mode=ro" "SELECT p.id,t.name,p.role,p.triggered_at FROM scheduled_task_pending_items p LEFT JOIN scheduled_tasks t ON t.id=p.task_id WHERE p.status='pending' AND datetime(p.triggered_at)<datetime('now','-24 hours')"`。逐条提醒；超48h升issue附id；无行写「滞留0」

## RHI 信号处置段（看见≠处置，禁止只列数字；必调 triage_signal）
1. **全部 critical**：`list_rhi_signals(status=open, severity=critical)` 逐条处置
2. **逐条三选一**：开 issue/并入 → `bind_issue, note=依据`；不处置 → `dismiss, note=必填`；在途 → `in_progress`。同类型 >10 条 `batch_bind`（连调 >5 次撞同构守卫，穿插 list_rhi_signals/分组）
3. **未接**：`list_rhi_signals(status=open, triageStatus=null)` 全归口；warning 同类型 ≥5 条同模块 → 按 critical，零散汇总一行
4. **闭环自检**：critical N → 开 M/并入 K/dismiss D，M+K+D=N；不等=有信号被跳过，补查

## 产物清单对账段（类型×终态矩阵的 L2 机械兜底）
**范围**：近 7 天活跃对话逐个 `list_artifacts(status: active)`。
1. **机械可判 → `update_artifact_status` 归档**：
   - **pr 类**：解析 PR 号 → `gh pr view <N> --json state` 为 MERGED/CLOSED → archived；解析不出跳过不判
   - **worktree 类**：url 路径不存在 / PR 已合入 → archived；**branch 类**：PR 已合入 → archived
   - **「合入事实」类 fact**：title 含「合入」且 PR 已合入 → archived
2. **纪律类**：file/fact/url 类单对话 > 10 → 日报清单提醒大獭归档
3. **报告**（产出表固定行）：`产物对账: 归档 N ｜ 存量 active M ｜ 待人工 K`

## worktree/分支收敛段（判定矩阵真相源：post-merge-cleanup）

`git worktree list --porcelain` + `git branch --format='%(refname:short)'` 全量扫（保护分支除外；勿用 glob 漏形态），逐分支 `gh pr list --head <b> --state all --json number,state --limit 1` 关联 PR，按 post-merge-cleanup 矩阵：已终结+干净→自动清理+产物 archived（硬验证）；dirty 一律不自动删→待裁决；OPEN→跳过；无 PR→两证核验；detached→待裁决注 sha。报告：`worktree 收敛: 自动清 N ｜ OPEN M ｜ 待裁决 K ｜ 登记缺失 L`（逐项列 K）。对账：active 产物 url 不在盘→archived；登记缺失计 L。

## 观测器信噪比自监控（误报率比检出率更决定告警生死）
1. **昨日统计**（日报末尾固定段）：healing resolve X / dismiss Y（dismiss 率 = Y/(X+Y)）；RHI 不处置率 L/(M+K+L)（取昨日闭环自检行）；产给搭档物件数；人工 dismiss 用时间差 <30 天分离
2. **趋势**：与近 7 日均值比突增 → 标「信号源可能劣化」（<4/7 标置信低）
3. **降级触发线**：任一信号源/healing 类型连续两周 dismiss/不处置率 >50% → 日报建议降级/关停/调阈值（含数据锚点）；未达线一行数字

## 锚点真实性抽查（证据锚点规则的外部强制）
1. **抽样**：昨日含 file:line 锚点的断言抽 5-10 条（含大/小獭；不足 5 全量；跨对话 search_memory（message + created_after）或 sqlite3；**禁 search_messages** 空集假阳性）
2. **异体核对（硬规则）**：抽查獭与被抽查獭**必须不同模型**（otter_sessions.model_alias 对照）；同模型样本改派异体，无条件异体时降级标「同模型抽查，置信降级」
3. **核对/处置**：每条 read 对应文件行核对（存在/行号有效/内容实质相符）；产出 N/通过 M/失败 K（失败附断言原文+实际内容）+ 模型对照行；任一不通过开 P1 issue（标题含「编造锚点」）；同獭 7 日 ≥2 次升 P0

## 噪声带对照
指标涨跌对照近 7 日序列（`/api/health/trends`）今日值 vs min-max：带内不作信号（写「带内」），超带才进 issue。仅限比率/均值/日增量；累积量只报日增量；<7 日标「基线不足」
## 产出前检查清单（硬门禁）
产出前列清单逐项自查，漏一项不许产出（每项注来源；无异常写「无异常」）：```
[ ] 1. 对话历史  [ ] 2. GitHub issues/PRs  [ ] 3. self-healing events  [ ] 4. memory
[ ] 5. RHI 健康信号  [ ] 6. signal_events  [ ] 7. RHI 处置：critical N → M+K+D=N 已调 triage_signal
[ ] 8. 锚点抽查：N/M/K + 模型对照  [ ] 9. 信噪比：dismiss 率/不处置率/物件数  [ ] 10. 压缩观测：failed 计数
[ ] 11. 产物对账：归档 N ｜ 存量 active M ｜ 待人工 K
[ ] 12. worktree 收敛：自动清 N ｜ 跳过 OPEN M ｜ 待裁决 K
[ ] 13. 循环熔断拦截：门拦截 N（误拦 M/真复犯 K/待判 L）｜ terminate J
```

## 循环熔断拦截观测段（昨日=UTC 日界）
loop_tool_block = 门拦截观测源（b2 残余误伤面唯一数据）：
1. **计数分布**：manage_healing_events(query, errorType=loop_tool_block) 昨日全量——总数/工具 TOP3/otter 数；N=去重事件数（每 execute 每签名 1 条）非拦截次数；0 条写「门拦截：0」
2. **误拦/真复犯**（context+同 invoke 转录）：误拦旁证=拉黑后同 invoke 有 speak/yield 求援或换工具推进；真复犯=跨 execute 反复撞同签名无纠正（execute 内撞门被去重吞掉）
3. **告警**：单日 >20 标红「b2 残余面失控早期信号」，提拉黑上限/TTL/签名区分度议题
4. **处置**：误拦 resolve 附依据；同工具误拦 ≥3 天复发开 issue（标 1399）；真复犯 resolve（防线正常）
5. **全景行**：`门拦截 N（误拦 M/真复犯 K/待判 L）｜ terminate J（circuit_break 事件）`
## 守卫误拦样本固化段（昨日=UTC 日界）
guard_intercept 样本 = 修复-回归循环原料：
1. `cd <主仓> && node scripts/generate-guard-replay.mjs --db <dbPath（curl /api/settings 取）>`；无拦截写「固化：0」
2. 逐条 verdict：`ALLOW`（误拦）/ `BLOCK`（负门）/ `SKIP`（一次性/敏感/不可复现）；误拦旁证 = 后续换写法绕过
3. **非 SKIP 追加** `<主仓>/tests/frameworks/agent/guard-v2-real-replay.test.ts`（对齐 it 块，断言=裁决值）并跑（`cd <主仓> && npx vitest run <该文件>`）；期望不符先疑裁决错勿凑绿，双链不一致提 issue
4. 日报「拦截 N → 候选 M → 固化 K / SKIP S」；同 ruleId ≥3 条误拦开 issue

## healing events 消费即处置（分析过的必须本次产出内处置完毕）

- **无需修复**（自愈按设计/单次偶发）：立即 `resolve`，notes 写判定依据
- **需要修复**：证据写进 issue body 后**立即 resolve**（notes 引用 issue 号）
- **同族批量归口**：同 ruleId 族 >10 条 → `batch_bind`（issueNumber + filterErrorType/filterRuleId）；修复合入后 `batch_resolve`+`filterBoundIssue=<N>` 收尾，逐条仅限异质
- **处置权**：首个消费任务拥有，后续不得推翻，存疑在 issue 评论
- **覆盖核实**：query 默认 50 条 + 单 status，errorType 逐类排查；处置完重跑验证无遗漏，产出「昨日 N → resolved M / open K」

## signal 对账段（獭间信号协议消费方闭环）
`query_signals(status=pending)` 逐项：objection/blocked 超 24h 未裁决 → 提 issue；同小獭单日 ≥3 条 dismissed → 列发起者统计，连续两日提 issue；抽 2-3 条已裁决信号核 resolution 有理由且锚点成立，不成立提 issue；query_signals(type=halt) 核「谁停了谁」，无理由 halt 提 issue。无异常写「signal 对账：无异常」。

## issue 产出规范
issue 必含案发现场（证据真实、含锚点）与影响。方案须标「已排查结论」（附证据链）或「排查方向（假设）」（标置信度）；写不出标「暂不修复」。**标签/标题/聚合**：type+priority+daily-review 各一；标题 `[模块] 一句话摘要`；同根因合一条。不完整率 >5% 日报标红
**验证断言/关闭标准必填**：每个 issue body 含「验证断言」段（可证伪含数据源/检查方式/到期+30天，regression-verify 到期回查）；每个 issue body 含「关闭标准」段（可验证，搭档拍板）——断言写不出=问题不清重写；关闭标准写不出=不该存在（并入/转文档）；纯决策/容器型断言段首行标 `暂不验证：<原因>` 回查跳过。
**候选池**：观察/评估类发现不立案，进日报末尾「候选池」段（细则见 9:30 任务）。
## 止损线检查（P0-c）
每日查评测止损线（`cd <主仓> && node scripts/lint-intent.mjs`）：①新增 intent 率 <80%；②golden-results 从未执行；③≥5 PR 场景 passed 全 true。触发 → 开 issue（owner=大獭）

**golden 执行对账+豁免**：近 24h 合入软代码 PR（`gh pr list --state merged` 筛 modules 含 prompts//.pi/）× golden-results.jsonl——缺记录/fail 悬置/pending 超 72h → 开 issue（owner=大獭）；先读特性文档 `intent.verify_by.type`——∈ {static_only, human_judge} 判豁免并标注「豁免：#<PR> (<type>)」，capability_test/golden_replay 应落账，缺声明照判缺记录
