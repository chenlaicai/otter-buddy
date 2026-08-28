---
task_name: 每日对话健康检查
---

请回顾昨天的所有对话，发现系统和海獭们的问题，按问题拆分提交 GitHub issue（label: daily-review）。

请判断如何处理：自己干 / 派小獭并行。参考 otter-summon skill 的判断示例。

关注点：用户情绪信号、系统问题、海獭行为。没信号就不报，宁缺毋滥。

## 必须检查的数据源

1. **对话历史**：本系统所有对话的消息（用户吐槽、系统错误、小獭异常）。跨对话用 memory 检索（search_memory + get_related）覆盖，不要声称"只能查当前对话"——那是错误的能力边界声明（issue #352 教训）
2. **GitHub issues**：用 `gh issue list --state all --limit 50` 获取最近 issue，筛选昨天创建/更新的 — 用户自建的 issue 也是重要信号，不在对话中吐槽不等于没有问题
3. **GitHub PRs**：用 `gh pr list --state all --limit 50` 获取最近 PR，筛选昨天创建/合入的 — 用户自建的 PR 说明遇到了需要修复的问题
4. **self-healing events**：用 `manage_healing_events(action: query)` 查看系统自愈记录 — 工具故障、检索缺失、格式异常都在这里，注意 otterId 字段可定位到具体海獭
5. **memory**：用 `search_memory` 检索昨天的记录（created_after 过滤）— 跨会话的问题脉络、未闭环的任务状态
6. **RHI 健康信号（F20260825rweb #404）**：用 `curl -s http://localhost:<port>/api/health/overview` 与 `/api/health/signals` 拉取 — critical 信号（bug 反复/链滞留/僵尸链）是日报的优先素材；RHI 的 critical 信号已自动写入记忆系统，也可用 `search_memory` 检索 `[RHI信号]` 前缀条目
7. **signal_events（F20260826mwrd C4）**：用 `query_signals(status=pending)` 查悬置獭间信号 — 对账细则见下方「signal 对账段」；注意 query_signals 只查当前对话，跨对话统计可用 `sqlite3` 或结合 memory 检索补足

## 分析纪律（issue #352 教训）

- **先收集数据再归纳结论**：先跑完上面 5 项数据源，再开始分析。禁止先推测一个"合理的故事"再找数据佐证
- **不确定的因果不写**：时间相邻 ≠ 因果关系。凡不能从数据直接得出的结论（数字、归属、因果链），要么查证，要么明确标注"未确认"
- **能力边界先测试再声明**：不确定工具能否做到时，先测试再下结论，不凭印象断言

## 产出前检查清单（硬门禁）

产出日报/issue 前，必须先列示**数据源引用清单**并逐项自查——漏一项不许产出：

```
数据源引用清单：
[ ] 1. 对话历史 — 已查/发现：…
[ ] 2. GitHub issues — 已查/发现：…
[ ] 3. GitHub PRs — 已查/发现：…
[ ] 4. self-healing events — 已查/发现：…
[ ] 5. memory — 已查/发现：…
[ ] 6. RHI 健康信号 — 已查/发现：…（overview 指标 + open signals；无新信号可写"无变化"）
[ ] 7. signal_events — 已查/发现：…（query_signals 对账段，无异常写"无异常"）
```

每项"发现"注明具体来源（issue 编号/对话 ID/事件 ID），无法定位的数据不上报。清单全部勾选后才写分析结论。

## healing events 消费即处置（issue #424）

分析过的 self-healing events 必须在本次产出内处置完毕，不留"已消费但未标记"的悬空状态：

- **无需修复**（真实退化被自愈机制按设计拦截、单次偶发无聚类）：立即 `manage_healing_events(action: resolve)` 批量处置，resolutionNotes 写明判定依据 + 引用 issue 编号（如"真实退化，重试自愈成功，无额外修复，见 #424"）
- **需要修复**（转入 daily-review issue 跟踪）：留 open，等修复 PR 合入后再 resolve，resolutionAction 对应实际修复方式（prompt_updated / tool_fixed / config_changed）
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
