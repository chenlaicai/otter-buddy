---
task_name: 每日对话健康检查
budget_bytes: 9200
---

请回顾昨天的所有对话，发现系统和海獭们的问题，按问题拆分提交 GitHub issue（label: daily-review）。

请判断如何处理：自己干 / 派小獭并行。参考 otter-summon skill 的判断示例。

关注点：用户情绪信号、系统问题、海獭行为。没信号就不报，宁缺毋滥。

## 范围约束（2026-09-04 搭档定调）

只找 otter-buddy 自身系统的优化点。其他项目（如 Echo agent 等）的对话反馈、UX 讨论、报错，一律忽略。跨对话 memory 检索到的候选信号，上报前先验证对话归属（引用的路径/PR/issue 是否指向 otter-buddy）；无法确认归属的，不报。

## 必须检查的数据源

**sqlite3 直查前置纪律（2026-09-04 定）**：直查前先 `curl -s http://localhost:3000/api/settings` 确认 dbPath——data/ 下可能残留同名废弃库，错查得出「零事件」假象。关键数字双源验证（SYSTEM.md A1①），单源标注「未交叉验证」。

1. **对话历史**：所有对话的消息（跨对话用 search_memory + get_related 覆盖，勿声称「只能查当前对话」；按「范围约束」过滤归属）
2. **GitHub issues / PRs**：`gh issue list` / `gh pr list --state all --limit 50`，筛昨天创建/更新/合入的——用户自建也是重要信号
3. **self-healing events**：`manage_healing_events(action: query)`。**二维分账**：errorType 分布按「环境/系统失败」vs「獭能力失败」分列（口径真相源：`src/entities/healing/healing-event.ts`）
4. **memory**：`search_memory`（created_after 过滤昨日）——跨会话问题脉络、未闭环任务状态
5. **RHI 健康信号**：`curl http://localhost:<port>/api/health/overview` 与 `/api/health/signals`——critical 是优先素材；也可 search_memory 检索 `[RHI信号]` 前缀
6. **signal_events**：`query_signals(status=pending)` 查悬置獭间信号（细则见「signal 对账段」；跨对话统计用 sqlite3）

## RHI 信号处置段（闭环硬规则，已机制化，2026-09-17）

「看见」≠「处置」。拉取后逐条处置，禁止只列数字。处置动作**必须调 `triage_signal` 留痕写库**（对账公式自动生成）：

1. **全部 critical**：`list_rhi_signals(status=open, severity=critical)` 拉清单逐条处置
2. **逐条三选一**（选完立即留痕）：开 issue/并入 → `bind_issue, issueNumber=N, note=判断依据`；不处置 → `dismiss, note=必填（观察期语义在 note）`；在途 → `in_progress`（前置已 bind_issue）
3. **未接单存量**：`list_rhi_signals(status=open, triageStatus=null)` 全部归口
4. **warning 扫视**：同类型 ≥5 条指向同一模块 → 按 critical；零散汇总一行
5. **闭环自检**：「critical N → 开 M/并入 K/dismiss D，M+K+D=N」自动生成；对不上 = 有信号被沉默跳过，补查

## 观测器信噪比自监控（2026-09-17，观测器自己也被观测）

观测器自己也被观测——误报率比检出率更决定告警系统生死：

1. **昨日信噪统计**（日报末尾固定段）：healing 处置 resolve X / dismiss Y（dismiss 率 = Y/(X+Y)）；RHI 不处置率 L/(M+K+L)（M/K/L 取昨日日报闭环自检行，非 RHI DB）；产给搭档物件数。healing 侧 SQL 与 stale 排除口径见体积预算闸特性文档「出清明细」（关键：人工 dismiss 用时间差 <30 天分离，不能按 resolution IS NULL 判）
2. **趋势对比**：与近 7 日均值比，dismiss 率/不处置率突增 → 标注「信号源可能劣化」（检索近 7 日日报，覆盖率 <4/7 标注置信低）
3. **降级建议触发线**：任一信号源/healing 类型连续两周 dismiss 率或不处置率 >50% → 日报显式给「建议降级/关停/调阈值」行（含数据锚点）。RHI 侧依赖历史日报链，覆盖率 <10/14 显式记「数据不足不得硬给结论」。未达线时本段一行数字

## 锚点真实性抽查（证据锚点规则的外部强制）

锚点规则（SYSTEM.md A1②）靠自觉存在「真假锚点混合」绕过——本段每日抽查，抓编造现形：

1. **抽样**：跨对话检索昨日含 file:line 锚点的断言，抽 5-10 条（含大獭/小獭；不足 5 全量）。途径：search_memory（message + created_after）或 sqlite3 直查；**禁止 search_messages**——只搜当前对话，本任务独立 session 会空集假阳性
2. **异体核对（硬规则）**：抽查獭与被抽查发言的獭**必须不同模型**（消息模型经 otter_sessions.model_alias 对照；查不到的跳过）。同模型样本 → 改派异体复核；无条件时降级标注「同模型抽查，置信降级」（依据：同源评审对 AI 产出接受率 1.91 倍于人类）
3. **核对**：每条用 read 打开对应文件行——①文件存在；②行号在文件内；③内容与断言实质相符
4. **产出**：「锚点抽查段」——抽查 N/通过 M/失败 K（失败附对话 ID + 断言原文 + 实际内容）+ 模型对照行
5. **处置**：任一不通过 → 开 P1 issue（[prompt]，标题含「编造锚点」）；同一獭 7 日 ≥2 次 → 升 P0

## 分析纪律

调查纪律全量按 SYSTEM.md A1 执行（先收集数据再归纳 / 关键数字双源验证 / 不确定的因果不写 / 能力边界先测试再声明 / 对话归属先验证再上报）。此处只留任务特有约束：**先跑完上方全部数据源再开始分析**。

## 产出前检查清单（硬门禁）

产出前先列数据源引用清单逐项自查，漏一项不许产出（每项注明来源：issue 编号/对话 ID/事件 ID；无异常写"无异常"）：

```
[ ] 1. 对话历史
[ ] 2. GitHub issues / PRs
[ ] 3. self-healing events
[ ] 4. memory
[ ] 5. RHI 健康信号（overview + open signals）
[ ] 6. signal_events
[ ] 7. RHI 信号处置：critical N → M+K+D=N，逐项已调 triage_signal 留痕
[ ] 8. 锚点抽查：抽查 N/通过 M/失败 K + 模型对照行
[ ] 9. 观测器信噪比：dismiss 率/不处置率/物件数
```

## healing events 消费即处置（不留悬空状态）

分析过的 self-healing events 必须在本次产出内处置完毕：

- **无需修复**（自愈按设计拦截/单次偶发）：立即 `resolve` 批量处置，notes 写判定依据
- **需要修复**：证据写进 issue body 后**立即 resolve**（notes 引用 issue 编号）。「留 open 等修复」已废除——修复进度是 issue 的职责
- **处置权**：首个消费任务拥有处置权，后续任务不得推翻，存疑在 issue 评论
- **覆盖核实**：query 默认 50 条 + 单 status——errorType 过滤逐一排查；处置完重跑 query 确认无遗漏，产出写「昨日 N → resolved M / open K」

## signal 对账段（獭间信号协议消费方闭环）

`query_signals(status=pending)` 扫悬置信号，逐项检查：

- **悬置异议**：pending 的 objection/blocked 超 24 小时未裁决 = 大獭违反裁决义务，单独提 issue（含 signal ID + 时长 + 对话）
- **异常异议率**：同一小獭单日 ≥3 条被 dismissed——日报列发起者统计，连续两日提 issue
- **裁决质量抽样**：抽 2-3 条已裁决信号，核实 resolution 有理由且锚点成立，不成立的提 issue
- **halt 台账扫视**：query_signals(type=halt) 看「谁停了谁」是否合理，无理由 halt 提 issue

无悬置、无异常写「signal 对账：无异常」。

## 分析维度

- **用户情绪信号**：对话吐槽、issue 标题强烈措辞（「红线」「不对」「错误」）
- **系统问题**：bug、工具故障、流程缺陷
- **海獭行为**：违反规则、遗漏流程、判断失误

## issue 产出规范

每个 daily-review issue 必须有具体修复方案（不能只写「留评论跟踪」，SYSTEM.md R2）。

**标签/标题/聚合硬规则**（详规与 lint 单一真相源：`scripts/lint-issue-labels.mjs`）：type 一个 + priority 一个 + daily-review；标题 `[模块] 一句话摘要`（模块枚举/聚合红线/拿不准宁降一级见 lint 头注）；同根因合一条不拆条。产出对照自查，不完整率 >5% 日报标红。

**验证断言必填**：每个 issue body 含「验证断言」段，三字段——`断言`（具体可证伪、含数据源）/ `检查方式`（sqlite / gh / 人工）/ `到期`（创建日 +30 天，YYYY-MM-DD）。写不出断言 = 问题定义不清，重写。回查由 regression-verify 定时任务到期执行，结果回写 issue 评论。

## 止损线检查（P0-c）

每日检查评测机制止损线（详规见评测止损线特性文档（2026-09-02）；脚本：`node scripts/lint-intent.mjs`）：①观察期新增文档 intent 率 <80% → 触发；②`data/metrics/golden-results.jsonl` 从未执行 → 触发；③≥5 个 PR 的自动场景记录且 passed 全 true → 触发复审（复审「保留」→ 静默 ≥8 周；样本 <5 PR 顺延记「样本不足」）。

触发 → 开 issue（owner=大獭）；处置路径（golden 目录删除 → capability test 承接 → results.jsonl 归档）与复审判据见该特性文档。
