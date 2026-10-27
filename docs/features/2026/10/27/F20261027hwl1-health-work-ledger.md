---
id: F20261027hwl1
title: 健康面板工作账本与模型时间效率
summary: 以独立工作而非 conversation 为成本归集单位，展示全生命周期 token、参与獭、结构化检视/复核轮次，以及真实 provider/model × 日/周/月的 token 总量与 KV cache 率；金额仅为可解释的参考投影。
change_type: feature
capability_test: "n/a: 若只实现确定性数据归属、只读聚合与 UI 投影，无 prompt/LLM 行为语义改动；若新增工作追踪工具调用纪律则必须补 B 类场景，不得以聚合测试代替。"
created_in_conversation: cf698fdc-2cfd-46d1-9afa-d6631e8cef31
created_at: 2026-10-27T19:05:00+08:00
causal_links:
  from: [F20260829cstd, F20260914usgm, F20260923icus, F20261026ctbg]
tags: [health, token-usage, work-ledger, cache, ui]
modules: [health, conversation, web]
---

## 目标

搭档已确认高保真原型与统计口径（本对话 2026-10-27 18:51「对于事项你理解是对的」、19:00「现在进入实现」）。面板回答：一件有独立目标、边界和结束状态的工作，从开始到结束消耗多少 token、几只独立獭参与、几轮独立检视与修改复核；每个真实模型在日/周/月消耗多少 token、KV cache 读取率是多少。token 是主账，金额是次级参考。

一段对话可以有多件工作；一件工作可跨对话。PR 是交付物之一，不等于工作。追问、确认、继续、设计调整跟随当前工作；新独立目标另起一件。完成可以是合入、排查结论、方案交付、搭档确认结束或取消。合入后的独立 bug 不无限累加给旧 PR。

## 非目标

- 不做獭 KPI 排名、健康评分、成本优劣判断、自动 ROI 分。
- 不用 LLM 猜测历史消息属于哪件工作，不把 conversation 的全部 token 归给一个 PR。
- 不将参考金额冒充供应商账单；不继承无关模型价格，不对订阅 plan 编造单价。
- 看板只读投影，不改变 matter 裁决状态机、发言链路由或自动停止语义。

## 已核实现状与数据边界（主仓只读，2026-10-27）

- `src/usecases/conversation/token-usage.ts` 已有四分量增量与总量工具；`dispatch-chain-engine.ts` 以 `runWithTrace` 给多 hop 链共享 traceId。`invokes.metadata` 当前仅保存 model，未保存 traceId。
- `InvokeFnParams` 当前未透传 triggerMessageId；需要沿 chain → AgentInvoker → SendEntry 传递真实触发 entry，不能用拼进 LLM 的上下文文本反推。
- `src/frameworks/db/conversation/sqlite-invoke-repository.ts` 的 InvokeRow / createInvoke 未映射 cacheRead/cacheWrite，update 虽写入两列，读回及新行 metadata 链条不完整；本特性必须修正并用 repository 回归测试证明。
- 生产只读快照（2026-10-27 19:05）：invokes 9019、matters 400、linked_resources 1837；有 usage 的 invoke 7372，有 cacheRead 的仅 146。旧数据天然有缺口，不得补零声称完整。
- `cost-output-collector.ts` 从 session JSONL 逐调用聚合 per-day per-model 四分量与 cost；`health_snapshots` 已保存日级原始量，可重汇总周/月，不能平均百分比。
- `usage-model-breakdown.ts` 目前 model 只有 alias，且跨 otter 合并；新视图需要 provider + model + alias，unknown 独立桶。
- `matters` 是承诺台账，不等于所有工作；`linked_resources.groupId` 是特性/PR 关联证据；`create_otter.systemPrompt` 与 `dispatch_records.task` 可提供角色证据，但不能把 prompt 自然语言当作已完成复核的证明。
- 生产库只能只读抽查，不得改写；迁移验证使用测试库与隔离实例。

## 设计面拍板（大獭，实现前）

### 1. 核心数据结构

新增独立工作投影，不复用/放宽 matters 的准入白名单：

- `work_items`：id、title、origin_kind（feature / matter / manual / inferred-historical）、origin_id、status（active / delivered / merged / closed / cancelled）、created_at、closed_at、evidence_quality（tracked / historical-partial）。不把 inferred-historical 当精确账。
- `work_item_invokes`：work_id、invoke_id、trace_id、attribution（explicit / trace-inherited / historical-partial）、created_at；invoke 至多一个当前明确归属，纠错需要留来源，禁止同一调用双计。
- `work_item_review_rounds`：work_id、reviewer_otter_id、round_no、started_invoke_id、delta_invoke_id、state（reviewing / awaiting-fix / delta-review / passed / open-unknown）、timestamps。只有结构化生命周期才记轮次，未知显示「未记录」而非 0。
- `conversation_active_work`（可选但推荐）：conversation_id、work_id、来源与更新时间。仅作显式 resume 的锚点，不能让任意新 user 消息自动继承旧工作。

`invokes` 保留真实调用与四分量 usage；metadata 增 traceId、model/provider（能可靠取得时），工作归属不塞进自由 JSON 代替关系表。新表 initSchema 与 migration 必须同步；迁移测试覆盖数据、DDL 结构、功能探针。

### 2. 归属规则

- 在 DispatchChainEngine 已有 trace scope 内，把 triggerMessageId 沿 InvokeFn 传入 invoke；invokes.metadata 记录 traceId 与 trigger entry。子獭/检视獭沿同一链继承 traceId，不靠 conversation 聚合。
- 新工作用明确的 `track_work` 端口/工具开始与续接：`start` 需要独立目标 title，创建 work；`resume` 需要已有 workId，用于新 user turn 续接；`complete/cancel` 只记工作投影状态，不越权闭合 matter。工具上下文注入 current trace/invoke；绑定当前整条 trace，失败不阻断业务 invoke，但暴露 telemetry gap。
- 每次新的用户点火链默认不继承旧工作，避免持续对话新主题被误记；明确 resume 或 feature/matter 证据才绑定。链内 hop 自动继承。创建 feature 资源（groupId）、登记/迁移 matter 时建立/续接对应工作，并保留当前 trace。
- `code-implementation` / `requirement-analysis` / `troubleshooting` 等多轮任务如增加工具使用纪律，必须先写 B 类 capability 场景验证「新目标 start、追问/继续 resume、子任务不另起工作」，再改 prompt；若本 PR 不做此软代码变更，UI/文档必须声明自动精确覆盖仅限已绑定链，不得宣称所有工作均已覆盖。
- 历史只读归集：feature groupId 资源 / matter origin entry / 已有 trace 可关联；其余进未归属。历史部分标 historical-partial，不能按时间相近或标题相似自动并账。
- 总量守恒：所有真实调用 = 已归属工作 + 共享/系统 + 未归属；缺失 usage 的调用数另列，不当作零。

### 3. 参与獭与检视轮次

- 参与数按独立 otter_id 去重，重启不新增；保存角色证据（orchestrator / implementer / reviewer / other）。`create_otter` 可增加明确的 assignmentRole 元数据，未知角标 unknown，不凭名字猜测。
- 独立 reviewer 首次链活动开启一轮；作者修复后同一 reviewer 的下一次链活动是 delta 复核，形成完整一轮；再次返工后才开下一轮。若新 reviewer 身份承载 delta，需有明确 parent/review 关联，否则标 open-unknown，不虚增完成轮次。
- 不用「发言出现 delta/通过」等文本计数。每个轮次保留 started/delta invoke 证据；进行中、未结构化记录与 0 分开。

### 4. 模型 × 时间 ×（token 总量 + cache 率）

- 数据源为逐 LLM 调用的日级四分量，优先复用现有 cost-output 采集；不从 invoke 的累计快照重复累加。周/月从日级原始量重汇总；日/周/月并列展示，不通过 tab 隐藏另外两个。
- 每个单元格：totalTokens 为主数字，cacheHitRate = cacheRead / (input + cacheRead) 为第二主数字；cacheRead/cacheWrite/input/output 作下钻。零分母显示「—」而非 0%。totalTokens 必须与四分量定义一致，缺项标缺口。
- model key = provider + 实际 model；alias 为辅助信息。解析 session 原生 model/provider，无法证明映射时归 unknown，不把 alias 当真模型名。
- 时间采用明确时区（Asia/Shanghai），起止日期随 DTO 返回；UTC 时间戳先转该时区再分日，不能裸 slice(0,10) 当日界。

### 5. token 与金额

- 所有汇总、列表、浮窗、模型格子均以 token 为主；金额小字 `≈`，标参考。
- 单次调用参考金额 =（非缓存输入 × input 单价 + cacheWrite × cacheWrite 单价 + cacheRead × cacheRead 单价 + output × output 单价）/ 1,000,000，逐次以当时价格表计算后汇总，不用总 token × 均价。
- 价格记录 provider/model、原始币种、四类单价、版本与生效期；只有显式可信配置才计算。订阅 plan / 缺价格 / 映射不明显示「无可用单价」。不提供从 session cost 反推价格的机制。
- 若本期没有可信价格配置，金额 UI 显示「未配置参考价」，不展示原型中的虚构金额或演示价格表。

## API / UI

- `GET /api/health/work-ledger?period=day|week|month`：summary、works、attributionCoverage、unassigned、usageGap；work 含 status、token 四分量、参与獭、review rounds、时间、关联 PR/F/matter 与 evidenceQuality。
- `GET /api/health/work-ledger/:id`：成本拆分、参与者、轮次时间线、调用证据与参考金额可用性；不存在返回 404，不返回演示对象。
- `GET /api/health/model-efficiency?period=day|week|month`：真实模型行与 day/week/month 并列单元格，保留 totals、缓存分量、调用/失败及数据缺口。
- 页面采用已确认原型：工作全宽列表，点击居中 `<dialog>` 浮窗，Esc/遮罩/×关闭，焦点返回触发行；手机表格横滚，明细接近全屏。工作定义可展开。模型格子大字 token + cache 率。
- 原型的所有名称、PR、commit、金额、token、命中率都是虚构，严禁进入产品 fixture 以外的运行路径；真实空态显示「尚无可归属工作」与下一步说明。
- 现有用量/效率 Tab 替换为交付账本与模型效率两视图；其他健康 Tab 保留。若需保持原总览，不删除无关功能。

## 实现拆分与最简约束

1. 先修 Invoke 四字段读回/写全 + traceId/trigger 透传，建立 usage 聚合单一函数，避免两套差分口径漂移。
2. 新工作表/仓库与 binder、明确的 track_work 端口及必要工具接线；所有调用失败均不破坏对话主路径，缺失必须可观测。
3. 只读 work/model 聚合与 API；优先 SQL/简单 Map，不引入新框架、通用规则引擎、LLM 分类器。
4. React 组件按 work-ledger / model-efficiency / detail-dialog 拆分，现有 `web/src/pages/health/index.tsx` 不继续膨胀；复用 globals 色板与既有 Modal 可访问性模式，原型 CSS 不整段当成产品全局样式。
5. 文档、真实 alpha 实例、浏览器截图与独立审视。开发獭负责代码与 A/B 测试，大獭编排异体检视；不允许实现者自审通过。

## 设计取舍与机制预算四问

- 问题特征：跨对话持续工作、多实体、多来源证据、部分历史不可知、高频读写（usage 已存在）。
- ①失效模式：按 conversation 归账会把持续对话多工作混合；按文本猜轮次会把建议当复核；读取漏 cache 字段会少算；价格 fallback 会造伪账单。
- ②现有机制失效原因：matters 只记承诺而非工作；trace 只到日志未到 invokes；成本快照只有日/model alias 且无工作键。
- ③为何需新增投影而不是补丁：关系型工作/调用/轮次是不同事实，需要独立表与明确来源；原始 invoke/session 不改写。看板撤销时删投影与绑定端口，不动调用和 matters。
- ④退役条件：若平台原生提供带 work/trace 的逐调用账本，可由新数据源替换投影；token 原始记录与既有 matter 语义必须保留。

修改类型：`mechanism-addition`（新增观测投影与归属关系，不是调度机制）。禁止借省事绕过 cache 持久化、trace 透传、迁移验证或异体检视。

## 验收标准（可机械验证优先）

| 场景 | 操作 | 预期 |
|---|---|---|
| 四分量完整读回 | repository 写入并读取 cacheRead/cacheWrite | 值完全一致；运行中 invoke 也不丢字段 |
| 同 conversation 两工作 | 分别绑定两个 trace 的 invokes 后查询 | token 不混算；独立 otter 去重 |
| 跨獭链 | 主獭与子獭不同 invoke 共享 trace | 同一工作，参与者按 id 去重，子任务不另起工作 |
| 未归属 | 无 work 证据调用 | 进未归属/缺口，不自动给 conversation 当前标题 |
| 复核轮次 | reviewer → fix → 同 reviewer delta → 再修复 | 一轮完成、下一轮开启；文本「delta 通过」本身不造轮次 |
| 模型日周月 | 同一模型两天不同输入/cache 量 | 各格 totalTokens 与加权率来自原始量之和，非日率均值 |
| 零分母/unknown | 无 cache 输入/缺 provider | 显示 — 与 unknown，不伪造 0% 或真实模型 |
| 金额边界 | 无显式价格/订阅 plan | 无可用单价；token 仍展示，不返回虚构金额 |
| API 空态与详情 | 空库/不存在 workId | 空列表与真实覆盖率；404 |
| 浮窗 | 点击工作、Esc/遮罩/×关闭 | dialog 可见且在视口内，关闭焦点返回；手机无 body 横溢出 |
| 迁移 | 旧库副本 bootstrap | 数据保留、DDL 等价、真实启动无 SqliteError；不触碰主库 |

## 验证要求

- A 类：repository、trace 绑定、跨工作隔离、模型时间聚合、价格缺失、API 与前端交互；数据库用 `createTestDb()`，时间注入。
- B 类：若改 skill/prompt 的 track_work 或 reviewer 标注纪律，先补真模型能力用例；anchor replay 与 Golden Gate 按 skill 规则执行。不得用 mock LLM 声称工作归属语义正确。
- UI：在 worktree `bash scripts/alpha.sh start` 起隔离实例，Playwright 复现桌面 1440 与手机 375，截图 + dialog getBoundingClientRect + 真实 API 空态/有数据两态，截图存对话工作区；完成 stop。
- DB：复制到隔离数据根，完整启动路径验证；主库只读，不运行手工写数据脚本。
- 推送后 CI 全绿，异体 adversarial-review + delta 后才呈搭档终审。
