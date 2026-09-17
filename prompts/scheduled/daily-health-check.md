---
task_name: 每日对话健康检查
---

请回顾昨天的所有对话，发现系统和海獭们的问题，按问题拆分提交 GitHub issue（label: daily-review）。

请判断如何处理：自己干 / 派小獭并行。参考 otter-summon skill 的判断示例。

关注点：用户情绪信号、系统问题、海獭行为。没信号就不报，宁缺毋滥。

## 范围约束（#778 教训，2026-09-04 搭档定调）

只找 otter-buddy 自身系统的优化点。其他项目（如 Echo agent 等）的对话反馈、UX 讨论、报错，一律忽略不上报。跨对话 memory 检索到的候选信号，上报前先验证对话归属——讨论的工作是否属于本仓库（otter-buddy 运行时/海獭系统）：看对话中引用的路径、PR、issue 是否指向 otter-buddy；无法确认归属的，宁缺毋滥，不报。

## 必须检查的数据源

**sqlite3 直查前置纪律（issue #791，2026-09-04 定）**：任何直接 `sqlite3 <path>` 查询前，第一步先 `curl -s http://localhost:3000/api/settings` 确认 dbPath（服务实际在用的库路径），用返回值核对你即将查的路径。data/ 下可能残留同名相似库文件（如已废弃的 otter.db）——结构完整、schema 齐全但全表空，错查会得出「零事件」假象并滑向错误结论（#791 现场：healing_events 查成 0 条，实际在用库有 245 条）。

1. **对话历史**：本系统所有对话的消息（用户吐槽、系统错误、小獭异常）。跨对话用 memory 检索（search_memory + get_related）覆盖，不要声称"只能查当前对话"——那是错误的能力边界声明（issue #352 教训）。检索结果按上方「范围约束」过滤归属
2. **GitHub issues**：用 `gh issue list --state all --limit 50` 获取最近 issue，筛选昨天创建/更新的 — 用户自建的 issue 也是重要信号，不在对话中吐槽不等于没有问题
3. **GitHub PRs**：用 `gh pr list --state all --limit 50` 获取最近 PR，筛选昨天创建/合入的 — 用户自建的 PR 说明遇到了需要修复的问题
4. **self-healing events**：用 `manage_healing_events(action: query)` 查看系统自愈记录 — 工具故障、检索缺失、格式异常都在这里，注意 otterId 字段可定位到具体海獭。**二维分账（#998）**：统计/呈报 errorType 分布时必须按「环境/系统失败」与「獭能力失败」两列分列——口径以 `src/entities/healing/healing-event.ts` 的 HEALING_ENVIRONMENT_TYPES 清单为准（单一真相源；当前：tool_failure/rate_limit/circuit_break/self_restart=环境，tool_use_feedback=主动反馈独立列不入分账，其余=能力）。混排会把工具故障误读成獭不行、把獭不行误读成工具故障（#791 同类：口径混排即数据不实）
5. **memory**：用 `search_memory` 检索昨天的记录（created_after 过滤）— 跨会话的问题脉络、未闭环的任务状态（按「范围约束」验证归属后再纳入）
6. **RHI 健康信号（F20260825rweb #404）**：用 `curl -s http://localhost:<port>/api/health/overview` 与 `/api/health/signals` 拉取 — critical 信号（bug 反复/链滞留/僵尸链）是日报的优先素材；RHI 的 critical 信号已自动写入记忆系统，也可用 `search_memory` 检索 `[RHI信号]` 前缀条目
7. **signal_events（F20260826mwrd C4）**：用 `query_signals(status=pending)` 查悬置獭间信号 — 对账细则见下方「signal 对账段」；注意 query_signals 只查当前对话，跨对话统计可用 `sqlite3` 或结合 memory 检索补足（sqlite3 直查先按上方前置纪律确认 dbPath）

## RHI 信号处置段（#406 闭环硬规则，2026-09-04）

「看见」不等于「处置」。拉取 RHI 信号后，逐条走完下面的处置流程，禁止只列数字不处置：

1. **列出全部 critical 信号**（severity=critical，含 bug_recurrence / chain_stall 等）：每条注明信号 ID、类型、严重度、指向的链/文件
2. **逐条给出处置动作**（三选一，不许留空）：
   - **开 issue**：信号指向的问题值得修复 → 提 daily-review issue（body 含信号 ID + 数据锚点），issue 编号回写本条目
   - **并入既有 issue**：问题已有 open issue 跟踪 → 注明 issue 编号 + 判断该信号是否改变了优先级
   - **明确不处置**：说明理由（如「误报，规则阈值问题」或「正在修复中，PR #xxx」）——「不处置」必须是判断结论，不能是沉默
3. **warning 信号扫视**：发现聚集（同类型 ≥5 条指向同一模块）按 critical 处理；零散 warning 汇总一行即可
4. **闭环自检**：日报结尾确认「critical N 条 → 开 issue M / 并入 K / 不处置 L（均附理由）」，M+K+L=N 才算闭环——数字对不上说明有信号被沉默跳过，补查

## 锚点真实性抽查（#981，证据锚点规则的外部强制）

证据锚点规则（SYSTEM.md A1②）靠 LLM 自觉，存在「真假锚点混合」绕过模式——本段是每日抽查机制，抓编造锚点现形：

1. **抽样**：跨对话检索昨日消息中含 file:line 锚点（如「.ts:」「.md:」模式）的断言，抽 5-10 条（含大獭/小獭发言；抽样不足 5 条时全量核对）。检索途径按上方数据源 #1 纪律——search_memory（content_type=message + created_after 过滤昨日）或 sqlite3 直查 messages 表（直查前先按前置纪律确认 dbPath）；**禁止用 search_messages**——它只搜当前对话，daily-review 独立 session 内无昨日消息，会产出空集假阳性
2. **异体核对（#1000 硬规则）**：抽查獭与被抽查发言的獭**必须不同模型**——消息模型经 otter_sessions.model_alias 对照（sender → session → model_alias；查不到模型的发言跳过不计入样本）。抽样后按模型分组：若某条样本与抽查执行者同模型，**改派异体模型獭复核该条**（daily-review 主任务用模型 X，则同模型样本由模型 Y 的獭复核）；无条件改派时（如单一模型可用）降级标注「同模型抽查，置信降级」并在产出中明示。依据：评审者与生产者同源时评审不可信（Red Queen GM 实测：同源评审器对 AI 产出接受率是人类的 1.91 倍）——同模型抽查者可能根本看不出那类编造，「7 日 ≥2 次升 P0」阈值永不触发
3. **核对**：每条用 read 工具打开对应文件对应行，核对——①文件是否存在；②行号是否落在文件行数内；③该行内容与断言声称是否实质相符（不苛求逐字，但声称「该行是 X 逻辑」而实际是无关代码 = 不通过）
4. **产出**：核对结果写入日报「锚点抽查段」——抽查 N 条 / 通过 M / 失败 K（每条失败附：对话 ID + 断言原文 + 文件实际内容一句话）+ **模型对照行**（「本次抽查用模型 X；样本模型分布 X:a 条 / Y:b 条；同模型样本 c 条已改派异体复核 / 降级标注」）
5. **处置**：任一不通过 → 开 P1 issue（type: bug，模块 [prompt]），标题含「编造锚点」，body 附全部证据锚点；同一獭 7 日内 ≥2 次编造锚点 → 升级为 P0 并在 issue 中标注「模式化幻觉」

抽查是 LLM 查 LLM 的软强制（非机器断言），价值在于固定流程 + 必产出 + 事后可追溯，不等于自动化校验。

## 分析纪律（issue #352 教训）

- **先收集数据再归纳结论**：先跑完上面 7 项数据源，再开始分析。禁止先推测一个"合理的故事"再找数据佐证
- **关键数字双源验证**：写入分析/issue 的关键计数（事件数、消息数、issue 数），用两个独立途径交叉核对（如 manage_healing_events 的 query 结果 vs sqlite3 直查同表 COUNT），单源数字标注「未交叉验证」——#791 现场：口径混排（error_type 字段值与 description 内容分类混排一表）把真实的 other:33 拆散隐去，呈现失真即数据不实
- **不确定的因果不写**：时间相邻 ≠ 因果关系。凡不能从数据直接得出的结论（数字、归属、因果链），要么查证，要么明确标注"未确认"
- **能力边界先测试再声明**：不确定工具能否做到时，先测试再下结论，不凭印象断言
- **对话归属先验证再上报**：跨对话候选信号必须验证是否属于 otter-buddy 系统（#778 教训——Echo agent 项目的 UX 反馈曾被误报为 daily-review issue）

## 产出前检查清单（硬门禁）

产出日报/issue 前，必须先列示**数据源引用清单**并逐项自查——漏一项不许产出：

```
数据源引用清单：
[ ] 1. 对话历史 — 已查/发现：…
[ ] 2. GitHub issues — 已查/发现：…
[ ] 3. GitHub PRs — 已查/发现：…
[ ] 4. self-healing events — 已查/发现：…
[ ] 5. memory — 已查/发现：…
[ ] 6. RHI 健康信号 — 已查/发现：…（overview 指标 + open signals；critical 信号处置结果见下方「RHI 信号处置段」，无新信号可写"无变化"）
[ ] 7. signal_events — 已查/发现：…（query_signals 对账段，无异常写"无异常"）
[ ] 8. RHI 信号处置 — 已处置：…（critical N 条 → 开 issue M / 并入 K / 不处置 L，M+K+L=N）
[ ] 9. 锚点真实性抽查 — 抽查 N 条 file:line 锚点断言 / 通过 M / 失败 K（失败已开 issue #xxx；昨日无锚点断言可写"无样本"）+ 模型对照行（抽查模型 X vs 样本模型分布；同模型样本改派/降级声明）
```

每项"发现"注明具体来源（issue 编号/对话 ID/事件 ID），无法定位的数据不上报。清单全部勾选后才写分析结论。

## healing events 消费即处置（issue #424）

分析过的 self-healing events 必须在本次产出内处置完毕，不留"已消费但未标记"的悬空状态：

- **无需修复**（真实退化被自愈机制按设计拦截、单次偶发无聚类）：立即 `manage_healing_events(action: resolve)` 批量处置，resolutionNotes 写明判定依据 + 引用 issue 编号（如"真实退化，重试自愈成功，无额外修复，见 #424"）
- **需要修复（转 issue 跟踪）——证据快照后立即 resolve（#600 方案 B）**：把事件证据（messageId/时间戳/关键描述）完整写进 daily-review issue body 后，**立即 resolve** 该事件（resolutionAction 对应预期修复方式，resolutionNotes 引用 issue 编号）。**「留 open 等修复」分支废除**——修复进度跟踪是 issue 的职责，healing event 只做发现记录，不留双轨状态
- **处置权归属（#600 口径协议）**：**首个消费该事件的任务拥有处置权**——本任务（9:00）处置后，后续任务（如 22:00 self-healing 分析）不得推翻；若后续任务发现处置存疑，在对应 issue 评论，不改事件状态
- **处置前核实范围**：query 默认只返回 50 条 + status 单一——用 errorType 过滤逐一排查，确认覆盖昨日全部新增事件（#424 现场：批量 resolve 漏了 1 起，靠下一个任务补上）
- 处置完成后重跑一次 query status=open 确认无遗漏，把"昨日事件 N 起 → resolved M 起 / open K 起（留修原因）"写进产出

## signal 对账段（F20260826mwrd C4，獭间信号协议消费方闭环）

用 `query_signals(status=pending)` 扫悬置信号，逐项检查：

- **悬置异议**：pending 状态的 objection/blocked 超过 24 小时未裁决 = 大獭违反裁决义务（SYSTEM.md 獭间信号协议），单独提 daily-review issue（含 signal ID + 未裁决时长 + 涉及对话）
- **异常异议率**：同一小獭近期 objection 密度异常（如单日 ≥3 条被 dismissed）= 滥用防线现形——在日报中列出发起者统计，连续两日异常则提 issue
- **裁决质量抽样**：随机抽 2-3 条已裁决信号，核实 resolution 是否有理由（空理由/敷衍理由 = 裁决义务未落实）；可疑锚点（编造的文档 ID/file:line）应在裁决时被 dismissed，若发现 resolved 但锚点不成立，提 issue
- **halt 台账扫视**：query_signals(type=halt) 看"谁停了谁"是否合理（发起者/目标/理由）；无理由 halt 提 issue

无悬置信号、无异常时写"signal 对账：无异常"即可，宁缺毋滥。

## 分析维度

- **用户情绪信号**：对话中的吐槽、GitHub issue 标题中的强烈措辞（如「红线」「不对」「错误」）
- **系统问题**：bug、工具故障、流程缺陷
- **海獭行为**：大獭/小獭违反规则、遗漏流程、判断失误

## issue 产出规范

每个提交的 daily-review issue 必须有具体修复方案（代码/配置/prompt/流程），不能只写「留评论跟踪」或「分析类不需要PR」——问题值得记录就值得有修复路径（SYSTEM.md R2 Issue 处理规范）。

**标签与标题硬约束（F20260907itri）**：

- **标签必打**：type 一个（bug=行为不符预期 / enhancement=新能力 / tech-debt=能用但结构烂 / question=待讨论/待分析）+ priority 一个（P0=正确性或数据安全 / P1=本周应修 / P2=等排期）+ `daily-review`。可选主题标签 ≤1（agent-evolution / observability）。判定拿不准时宁降一级（P1→P2），周一 backlog digest 搭档校准
- **标题格式**：`[模块] 一句话摘要`（模块枚举：signal-protocol / scheduler / web / memory / healing / im / stock / skill / prompt / docs / rhi / general）；F 特性 follow-up 用 `[F…-followup]` 占模块位——不用 [daily-review] 等与标签重复的前缀
- **聚合红线**：同根因或同模块同类型的多个问题，合并为一条 issue 分点陈述——例：同属 signal-protocol 的阻尼、墓碑、例外收口三题应合一条，不拆三条（#826/827/828 反例）
- 合规性由 `node scripts/lint-issue-labels.mjs` 每日审计，产出日报时自行对照上述四条自查；标签不完整率 >5% 日报标红

**验证断言必填（#1004，F20260917rgsv）**：每个 daily-review issue 的 body 必须含「验证断言」段——回答「修复后，什么可观测的证据出现即证明真的修好了」。格式：

```
## 验证断言
- 断言：<具体、可机器或人工检查的条件，含数据源。例：healing_events 中 errorType=X 的事件连续 7 天为 0 / 某文件某行逻辑变为 Y / 某任务连续成功运行 3 天>
- 检查方式：<sqlite 查询 / gh 命令 / 人工观察——写清楚，让 30 天后的獭不用猜>
- 到期：<创建日期 +30 天的日期，YYYY-MM-DD>
```

要求：断言必须可证伪（写不出断言 = 问题定义不清，回去重写 issue）；「观察一下」「应该会好」类不可检查的表述不合规。回查由 regression-verify 定时任务（每日）到期自动执行，结果回写 issue 评论。

## 止损线检查（P0-c，v6.3）

每日检查评测机制止损线状态，发现问题立即开 issue：

### 检查项

1. **intent 生成率**：运行 `node scripts/lint-intent.mjs` 查看声明率统计（P0-c 输出）
   - 存量参考：intent 存在率 / verify_by 率（参考值，不触发止损）
   - 本期判定：本次 PR 修改的文档 intent 存在率 / verify_by 率（判定值）
   - **止损线**：观察期（P0 落地后 2 周或 5 个软代码 PR，先到为准）新增文档 intent 生成率 <80% → 触发

2. **golden gate 执行记录**：检查 `data/metrics/golden-results.jsonl` 是否存在且有记录
   - **止损线**：golden gate 从未被实际执行 → 触发

3. **条件 3（效果外标）**：检查 golden gate 执行记录中的 passed 字段
   - **样本单位 = PR 数**（按 pr 字段聚合，一个 PR 多场景只算一个样本）
   - **样本不足分支**：窗口内聚合后 <5 个 PR → 窗口顺延，记「样本不足」，不算空转不算价值
   - **触发条件**：≥5 个 PR 的自动场景记录且 passed 全为 true（零 fail，分母只算自动场景）→ 触发复审
   - **复审后静默规则**：复审决议「保留」→ 条件 3 静默 ≥8 周后再恢复检查（防复审疲劳）
   - **复审判据（人工，一次性）**：① 场景覆盖 vs 窗口内软代码 PR diff 的相关性；② post_merge_fix_density 趋势旁证

### 处置

- 止损线触发 → owner=大獭，daily-review 开 issue
- 触发处置：golden 目录删除 → capability test 承接原断言 → results.jsonl 归档 data/metrics/ → #579 同步关闭 → 验收记录写入特性文档
- 复审决议「保留」→ 条件 3 静默 ≥8 周后再恢复检查
