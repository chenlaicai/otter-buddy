---
task_name: 每日对话健康检查
budget_bytes: 10500
---

回顾昨日全部对话，发现系统和海獭的问题，按问题拆分提 GitHub issue（label: daily-review）。分析维度：用户情绪、系统问题（bug/工具故障/流程缺陷）、海獭行为（违规/漏流程/误判）。自己干 / 派小獭并行。没信号就不报，宁缺毋滥。只找本系统优化点，跨对话 memory 信号先验证归属。

## 必须检查的数据源（先跑完再分析；调查纪律按 SYSTEM.md A1）

**sqlite3 直查前置纪律**：直查前先 `curl -s http://localhost:3000/api/settings` 确认 dbPath——data/ 可能残留同名废弃库。关键数字双源验证，单源标「未交叉验证」。

1. **对话历史**：所有对话消息（跨对话用 search_memory + get_related，勿声称「只能查当前对话」；按范围约束过滤归属）
2. **GitHub issues / PRs**：`gh issue list` / `gh pr list --state all --limit 50`，筛昨日创建/更新/合入
3. **self-healing events**：`manage_healing_events(action: query)`。**二维分账**：errorType 按「环境/系统失败」vs「獭能力失败」分列（口径：`src/entities/healing/healing-event.ts`）
4. **memory**：`search_memory`（created_after 过滤昨日）——跨会话问题脉络、未闭环任务状态
5. **RHI 健康信号**：`curl http://localhost:<port>/api/health/overview` 与 `/api/health/signals`——critical 是优先素材
6. **signal_events**：`query_signals(status=pending)` 查悬置獭间信号（跨对话统计用 sqlite3）
7. **上下文压缩观测**：`grep '"msg":"SDK compaction failed"' data/logs/otter-buddy.log` 按日计数（禁 jq）。≥20 或连续 3 日递增 → bug issue（关联 messageId/otterId）；10-19 记观察行；hook fallback 与 shadow 失衡计入异常；无异常写「failed=N，健康」

## RHI 信号处置段（闭环硬规则：「看见」≠「处置」禁止只列数字；处置必调 triage_signal 留痕）

1. **全部 critical**：`list_rhi_signals(status=open, severity=critical)` 逐条处置
2. **逐条三选一**（立即留痕）：开 issue/并入 → `bind_issue, note=依据`；不处置 → `dismiss, note=必填`；在途 → `in_progress`。同类型 >10 条用 `batch_bind`（纯 triage_signal 连调 >5 次撞「同构」守卫——穿插 list_rhi_signals 或分组 batch_bind 打散）
3. **未接单存量**：`list_rhi_signals(status=open, triageStatus=null)` 全部归口；**warning 扫视**：同类型 ≥5 条指向同一模块 → 按 critical，零散汇总一行
4. **闭环自检**：「critical N → 开 M/并入 K/dismiss D，M+K+D=N」；对不上 = 有信号被沉默跳过，补查

## 产物清单对账段（类型×终态矩阵的 L2 机械兜底）

**范围**：近 7 天活跃对话，逐个 `list_artifacts(status: active)`。

1. **机械可判 → 直接归档**（`update_artifact_status`）：
   - **pr 类**：解析 PR 号 → `gh pr view <N> --json state` 为 MERGED/CLOSED → archived；解析不出**跳过不判**
   - **worktree 类**：url 路径不存在 / 对应 PR 已合入 → archived
   - **branch 类**：对应 PR 已合入 → archived
   - **「合入事实」类 fact**：title 含「合入」且关联 PR 已合入 → archived（长期载体是记忆系统）
2. **纪律类 → 只提醒**：file/fact/url 类单对话 > 10 → 日报列清单提醒大獭人工归档
3. **报告**（产出表固定行）：`产物对账: 归档 N ｜ 存量 active M ｜ 待人工 K`

## worktree/分支收敛段（判定矩阵真相源：post-merge-cleanup）

`git worktree list --porcelain` + `git branch --list 'feature/*' 'fix/*' 'feat/*' 'chore/*' 'refactor/*' 'hotfix/*'` 全量扫，逐分支 `gh pr list --head <b> --state all --json number,state --limit 1` 关联 PR 终态，按矩阵处置：MERGED/CLOSED + 干净 → **自动清理**（先停实例再删目录，走 post-merge-cleanup 含硬验证闸）+ 产物 archived；MERGED/CLOSED + dirty → 日报列待搭档裁决；OPEN → 跳过；无 PR + 干净 → mtime >7 天且无 otter-claim 认领（两证缺一即保留标「疑似在途」）→ 废弃候选；无 PR + dirty → WIP 待认领。报告行：`worktree 收敛: 自动清 N ｜ 跳过 OPEN M ｜ 待裁决 K`。对账：active worktree 产物 url 不在 `git worktree list` → archived。

## 观测器信噪比自监控（误报率比检出率更决定告警生死）

1. **昨日统计**（日报末尾固定段）：healing resolve X / dismiss Y（dismiss 率 = Y/(X+Y)）；RHI 不处置率 L/(M+K+L)（取昨日日报闭环自检行）；产给搭档物件数。人工 dismiss 用时间差 <30 天分离
2. **趋势**：与近 7 日均值比突增 → 标「信号源可能劣化」（<4/7 标置信低）
3. **降级触发线**：任一信号源/healing 类型连续两周 dismiss 率或不处置率 >50% → 日报给「建议降级/关停/调阈值」（含数据锚点）；<10/14 记「数据不足」；未达线一行数字

## 锚点真实性抽查（证据锚点规则的外部强制）

1. **抽样**：跨对话检索昨日含 file:line 锚点的断言，抽 5-10 条（含大獭/小獭；不足 5 全量）。途径：search_memory（message + created_after）或 sqlite3；**禁 search_messages**（独立 session 空集假阳性）
2. **异体核对（硬规则）**：抽查獭与被抽查发言的獭**必须不同模型**（otter_sessions.model_alias 对照）。同模型样本改派异体，无条件时降级标「同模型抽查，置信降级」
3. **核对/处置**：每条 read 打开对应文件行核对（文件存在/行号在文件内/内容与断言实质相符）；产出 抽查 N/通过 M/失败 K（失败附断言原文+实际内容）+ 模型对照行；任一不通过开 P1 issue（[prompt]，标题含「编造锚点」）；同獭 7 日 ≥2 次升 P0

## 噪声带对照

指标涨跌声明对照近 7 日序列（`/api/health/trends`）今日值 vs min-max：带内不作信号（一行「带内」），超带才进 issue。仅限比率/均值/日增量；累积量只报日增量；<7 日标「基线不足」

## 产出前检查清单（硬门禁）

产出前列数据源引用清单逐项自查，漏一项不许产出（每项注来源；无异常写「无异常」）：

```
[ ] 1. 对话历史  [ ] 2. GitHub issues/PRs  [ ] 3. self-healing events  [ ] 4. memory
[ ] 5. RHI 健康信号  [ ] 6. signal_events  [ ] 7. RHI 处置：critical N → M+K+D=N 已调 triage_signal
[ ] 8. 锚点抽查：N/M/K + 模型对照  [ ] 9. 信噪比：dismiss 率/不处置率/物件数  [ ] 10. 压缩观测：failed 计数
[ ] 11. 产物对账：归档 N ｜ 存量 active M ｜ 待人工 K
[ ] 12. worktree 收敛：自动清 N ｜ 跳过 OPEN M ｜ 待裁决 K
```

## 守卫误拦样本固化段（「昨日」= UTC 日界）

昨日 guard_intercept 样本是「修复-回归循环」的原料，每日：

1. `node scripts/generate-guard-replay.mjs --db <curl /api/settings 得到的 dbPath>`；无拦截日报写「固化：0 条」
2. 逐条填 verdict：`ALLOW`（误拦）/ `BLOCK`（规则内负门样本）/ `SKIP`（一次性/敏感/不可复现）；误拦旁证 = 查后续是否换写法绕过
3. 非 SKIP 追加到 `tests/frameworks/agent/guard-v2-real-replay.test.ts`（对齐既有 it 块，断言 = 裁决值）并跑该文件；期望不符先疑裁决错勿凑绿，双链不一致提 issue
4. 日报留痕「拦截 N → 候选 M → 固化 K / SKIP S」；同 ruleId ≥3 条成规模误拦改开 issue 修规则

## healing events 消费即处置（分析过的必须在本次产出内处置完毕）

- **无需修复**（自愈按设计/单次偶发）：立即 `resolve`，notes 写判定依据
- **需要修复**：证据写进 issue body 后**立即 resolve**（notes 引用 issue 号）
- **同族批量归口**：同 ruleId 族 >10 条 → `batch_bind`（issueNumber + filterErrorType/filterRuleId）；修复合入后 `batch_resolve`+`filterBoundIssue=<N>` 收尾，逐条仅限异质
- **处置权**：首个消费任务拥有，后续不得推翻，存疑在 issue 评论
- **覆盖核实**：query 默认 50 条 + 单 status，errorType 逐类排查；处置完重跑验证无遗漏，产出写「昨日 N → resolved M / open K」

## signal 对账段（獭间信号协议消费方闭环）

`query_signals(status=pending)` 逐项：悬置 objection/blocked 超 24h 未裁决 → 提 issue；同一小獭单日 ≥3 条被 dismissed → 列发起者统计，连续两日提 issue；抽 2-3 条已裁决信号核实 resolution 有理由且锚点成立，不成立提 issue；query_signals(type=halt) 核「谁停了谁」合理，无理由 halt 提 issue。无异常写「signal 对账：无异常」。

## issue 产出规范

每个 daily-review issue 必须有具体修复方案（SYSTEM.md R2）。**标签/标题/聚合硬规则**（真相源：`scripts/lint-issue-labels.mjs`）：type + priority + daily-review 各一；标题 `[模块] 一句话摘要`（枚举/聚合红线见 lint 头注）；同根因合一条。自查不完整率 >5% 日报标红。

**验证断言必填**：每个 issue body 含「验证断言」段，三字段——`断言`（可证伪、含数据源）/ `检查方式`（sqlite / gh / 人工）/ `到期`（创建日 +30 天，YYYY-MM-DD）。写不出 = 问题定义不清，重写。回查由 regression-verify 到期执行。

**关闭标准必填**（搭档拍板）：每个 issue body 含「关闭标准」段——可验证的关闭条件。写不出 = 不该存在（并入其他 issue 或转文档）。断言管「修没修好」，关闭标准管「什么时候可以关」。

**断言豁免标注**：无法写断言的 issue（纯决策型/容器型），「验证断言」段首行标 `暂不验证：<原因>`——regression-verify 回查跳过。豁免不是免写，是显式声明关闭不依赖断言回查。

## 止损线检查（P0-c）

每日查评测机制止损线（详规：评测止损线特性文档 2026-09-02；脚本 `node scripts/lint-intent.mjs`）：①观察期新增 intent 率 <80%；②golden-results 从未执行；③≥5 PR 场景 passed 全 true（<5 样本记「样本不足」）。触发 → 开 issue（owner=大獭）。

**golden 执行对账**：对账近 24h 合入的软代码 PR（`gh pr list --state merged` 筛 modules 含 prompts//.pi/）× golden-results.jsonl——缺记录 / fail 悬置 / pending 超 72h → 开 issue（owner=大獭）。不阻断合入，软曝光驱动。
