---
id: F20261008mlp3
title: 待办（Matter Loop）P3：未闭环扫描升格 + 简报卡吸收收尾
summary: F20261006mtlp 的 P3 期（收官）。两块：①未闭环扫描升格——prompts/scheduled/未闭环扫描.md 从「search_memory 捞回头再说」文本启发式切到 matter_sweep 确定性查询（跨对话停滞扫描：OPEN 无人认领 / WAITING_PARTNER 积压 24h 基准），准入路径 3 兜底保留（anti-join 排除已登记 matter + originMessageId 去重键）；②简报卡吸收收尾——初判「P1/P2 已覆盖」经检视证伪（MattersPanel.tsx 零 payload 渲染），大獭裁决补呈现路线：MatterBrief 组件落板上简报三层结构（WAITING_PARTNER 态渲染，JSON 解析失败降级原文展示）。
doc_type: feature
change_type: feature
intent:
  problem: "prompts/scheduled/未闭环扫描.md 此前是「search_memory 捞回头再说」文本启发式（#1053 9/20 后未改——P1 承诺的日巡小改是漏项）。F20261008mlp3 P3 升格为确定性查询：数据源切到 matter_sweep 工具（跨对话停滞扫描——OPEN 无人认领 / WAITING_PARTNER 积压 24h 基准）。"
  solution: "重写扫描 prompt：数据源从 search_memory 文本启发式切到 matter_sweep 确定性查询；准入路径 3 兜底保留（漏登记 yield 发现）；边界条款保留原则「只提醒不处置」（与 8:30 健康检查/9:30 issue 处理分工不漂移）。"
  expected_effect: "扫描产出从文本启发式切到确定性查询；日巡发现停滞（OPEN 无人认领 / WAITING_PARTNER 积压）→ 三省吾身对话发提醒（含 matter ID 与等待时长）——审计环闭合。"
  verify_by:
    type: capability_test
    capability_assertions:
      - "扫描产出从文本启发式切到确定性查询（matter_sweep 工具调用）"
      - "停滞定义：OPEN 无人认领 / WAITING_PARTNER 积压——24h 基准"
      - "提醒含 matter ID + 等待时长"
      - "准入路径 3 兜底：漏登记 yield 发现"
created_in_conversation: e871769f-a731-4278-ae21-de3ab4c8eaf8
capability_test: tests/usecases/matter/matter-sweep.test.ts
created_at: 2026-10-08
tags: [matter-loop, scheduled-task, prompt, deterministic-query]
modules: [prompts/scheduled/, src/usecases/matter/, src/frameworks/db/matter/, src/interface-adapters/agent-runtime/tools/]
causal_links:
  - F20261006mlp2
from: [F20261006mlp2]
---

# 待办（Matter Loop）P3

> 本文档是 F20261006mtlp（方案+P1+P2）的 P3 期实现记录，不改已合入的 F20261006mtlp/F20261006mlp2 正文。
> P3 范围 = 方案 §7 P3 行 + §6 关系表「未闭环扫描升格/L2 简报卡吸收」+ §3 准入路径 3 + 承诺半径声明。
> 设计真相源仍是 F20261006mtlp §1-§7，本文档只记录 P3 的实现期决策与落地形态。

## 跨对话查询载体的定案（L1 决策，头号架构问题）

**开放问题**（任务简报给定）：扫描跑在三省吾身对话（F20260917swsh 定时任务收拢单对话），但 matter 板按对话隔离——list_matters 工具 BOUNDARY「matters 按对话隔离，conversationId 系统注入」。跨对话查询载体现状没有。

**调研结论**：
- HTTP 面：`GET /api/conversations/:id/matters`（matter-controller.ts）是单对话查询，无跨对话端点。
- 工具面：list_matters/transition_matter/register_matter 均注入 ctx.conversationId，无跨对话能力。
- 数据面：matters 表全局共享（SQLite），仅查询接口按对话隔离。

**定案：新增大獭专属跨对话只读查询工具 matter_sweep。** 理由：

1. **权限对齐**：跨对话查询权与编排权对齐（大獭专属），small 型白名单天然不含（config/tool-manifest.json big="*" 自动包含，small 按组+枚举不含）。
2. **改动最小**：扩展 MatterRepository 接口（+stalledOpen +recentYieldsToUser），SqliteMatterRepository 实现，MatterSweep usecase 编排，matter-tools.ts 注册工具。HTTP 面/状态机/守卫零改动。
3. **语义清晰**：matter_sweep 是只读扫描，不做迁移/闭环（transition_matter 仍走通道 A/B），边界条款「只提醒不处置」物理落点。

**候选方案对比**：
- A = HTTP 跨对话端点：需要前端配合或 curl 调用，獭侧工具面仍无能力——否。
- B = 扫描任务按对话枚举（list_matters 逐对话查）：需要知道所有对话 ID，且 N 次查询效率低——否。
- C = 大獭专属工具（定案）：一次调用返回全部停滞 matter + 候选漏登记 yield。

## 简报卡吸收收尾的调研结论

**调研项**（任务简报候选点）：
1. WAITING_PARTNER 条目展开 payload 简报三层结构——初判「P2 已落」，经检视证伪：MattersPanel.tsx 零 payload 渲染（前端唯一命中是 test fixture payload: null），MatterItem 无展开详情、waitingFor 行 CSS truncate。大獭裁决补呈现路线：MatterBrief 组件落板上简报三层结构。
2. otterCard.submit 卡片提交与 matter 迁移联动——P2 走 html-matter-action 回执通道（非卡片通道），卡片批了 matter 同步消解由獭代执行 transition_matter 完成。
3. 简报内容单源纪律——P1 yield 打标登记 payload 含 brief（matter-yield-registration.test.ts 锁定），真相在 payload，流内卡片是渲染投影。

**结论（初判——经检视证伪后修正）**：初判「简报卡吸收已完毕，无剩余落地项」基于「P2 已落板上呈现」的失实论据。检视发现 MattersPanel.tsx 零 payload 渲染，板上无法达简报三层结构——兜底残缺。大獭裁决走补呈现路线：MatterBrief 组件已落地（见「审视修复记录」节严重 2）。P1/P2 已覆盖的其余两项（payload 存 brief、html-matter-action 回执代执行）经检视核实属实。

## P3 实现记录

### 落地清单

| 面 | 改动 | 文件 |
|---|---|---|
| 跨对话停滞扫描 | MatterSweep usecase（stalledOpen + recentYieldsToUser），MatterRepository 接口扩展 | src/usecases/matter/matter-sweep.ts、matter-repository.ts |
| SQLite 实现 | stalledOpen：OPEN 全捞（积压）+ WAITING_PARTNER 24h 阈；recentYieldsToUser：近 7 天 yield_targets 含 user 的 yield 条目 | src/frameworks/db/matter/sqlite-matter-repository.ts |
| 獭侧工具 | matter_sweep（大獭专属，small 白名单不含）——返回停滞 matter 列表 + 候选漏登记 yield 列表 | src/interface-adapters/agent-runtime/tools/matter-tools.ts、tool-factory.ts |
| 扫描 prompt 升格 | 数据源从 search_memory 切到 matter_sweep；准入路径 3 兜底保留；边界条款「只提醒不处置」 | prompts/scheduled/未闭环扫描.md |
| 测试 | MatterSweep usecase 9 用例 + matter_sweep 工具 7 用例（注册面/执行面/权限面） | tests/usecases/matter/matter-sweep.test.ts、tests/interface-adapters/agent-runtime/tools/matter-sweep-tool.test.ts |

### 实现期决策（跨对话载体以外的取舍）

1. **停滞定义口径**：OPEN = 全捞（「无人认领」积压语义，登记即停滞候选）；WAITING_PARTNER = 24h 阈（「积压」语义，跨日未收尾）。方案 §3 既有 24h 基准沿用，但 OPEN 不过滤——否则「刚登记就提醒」太吵，且 OPEN 本就无人认领。
2. **漏登记 yield 兜底半径**：近 7 天 yield_targets 含 user 的 yield 条目，按 originMessageId 去重。7 天外的不捞（漏登记不会跨周仍高频提醒）；yield_targets 不含 user 的不捞（非 L2 拍板项）。
3. **P1 漏项留痕**：方案空窗期说明承诺「P1 落地后扫描 prompt 同步小改（日巡读 open matters）」实际未落（git log 核实 未闭环扫描.md 最后改动 #1053 9/20）——P3 大改一并覆盖（prompt 整体重写）。
4. **简报卡吸收**：初判「P1/P2 已覆盖」经检视证伪（MattersPanel.tsx 零 payload 渲染），大獭裁决补呈现路线——MatterBrief 组件已落地（见「审视修复记录」节严重 2）。

### 负面向验收

- [x] 扫描产出从文本启发式切到确定性查询（matter_sweep 工具调用）——**实现：prompt 重写 + 工具落地**
- [x] 停滞定义：OPEN 无人认领 / WAITING_PARTNER 积压——24h 基准——**实现：stalledOpen 语义 + 测试锁定**
- [x] 提醒含 matter ID + 等待时长——**实现：matter_sweep 返回 stalledHours + 短锚**
- [x] 准入路径 3 兜底：漏登记 yield 发现——**实现：unregisteredYieldsToUser（严重3修复后——SQL LEFT JOIN 排除已登记 + 输出去重键）+ anti-join 排除语义 2 用例锁定（delta-A 补）**

### 审视修复记录（检视1341獭 4 严重 + 5 建议）

**严重 2（板上简报呈现补落地）**：检视发现 MattersPanel.tsx 零 payload 渲染——「P2 已落板上呈现」论据为假。大獭裁决走补呈现路线：
- MatterItem 新增 `MatterBrief` 组件（WAITING_PARTNER 态渲染 payload 简报三层结构，JSON 解析失败降级原文展示）
- 方案 §6 吸收语义完整落点：卡片被顶走后 matter 兜底，板上可达简报内容

**严重 3（漏登记兜底可执行化）**：检视发现 `recentYieldsToUser` ①SQL 零 matter 排除（146 条全量端给 LLM 肉眼甄别）②去重键无数据可依 ③expects_partner_decision 未持久化无法区分 L2 拍板与例行交棒。修复：
- SQL LEFT JOIN matters ON origin_message_id = yield_entry.id，排除已登记 matter
- 输出带 `originMessageId`（去重键）+ `registeredMatterId`（未来扩展）
- 兜底半径如实声明为「yield-to-user 未登记增量」，L2 甄别留给调用方（body/payload 含拍板语义时权重更高）

**严重 1（Golden Gate 记录缺失）**：`npm run test:capability:only` 已跑，golden-results.jsonl 已更新（2026-10-08 时间戳）。

**严重 4（Modification-Class 声明缺失）**：commit body 补 `mechanism-addition` 声明行。

**建议 5（prompt「24h 基准」与 OPEN 全捞矛盾）**：prompt 补「停滞口径（分开两条）」节——OPEN 全捞（积压）+ WAITING_PARTNER 24h 阈（跨日未收尾）。

**建议 6（issue 衔接脱离规范真相源）**：prompt 补指向 daily-health-check prompt（type+priority 标签、`[模块] 一句话摘要`、同根因聚合不拆条）。

**建议 7（覆盖面收窄未显性声明）**：prompt 补「覆盖面收窄声明」节——升格后只查 matters 表 + yield 兜底，未登记搁置表态不在扫描范围。

**建议 8（matter-controller.test.ts `as unknown as` 双断言弱化接口检查）**：补 `stalledOpen`/`unregisteredYieldsToUser` 两个 stub 还原单断言。

**建议 9（tool-manifest.json 未登记 matter_sweep/register_matter）**：big="*" 通配成立，声明债——不在本 PR 范围，已建 issue #1349 跟踪（delta-D 兑现承诺）。

### Delta 修复记录（检视1341獭 4 条轻量订正，第三轮复核项）

**delta-A（anti-join 排除语义测试缺口）**：seedMatter 补 `originMessageId` 字段，新增 2 用例——已登记 matter 的 yield 条目不命中 / 未登记 matter 的 yield 条目命中（去重键 originMessageId 断言）。验收措辞订正为「anti-join 排除语义 2 用例锁定」。

**delta-B（记忆索引污染——frontmatter summary 失实表述就地订正）**：
- frontmatter summary：「调研确认 P1/P2 已覆盖…无剩余落地项」→「初判经检视证伪…大獭裁决补呈现路线：MatterBrief 组件落板上简报三层结构」
- 调研项 1：「P2 已落」→「初判经检视证伪：MattersPanel.tsx 零 payload 渲染…大獭裁决补呈现路线」
- 实现期决策 4：「调研确认 P1/P2 已覆盖」→「初判经检视证伪…MatterBrief 组件已落地」

**delta-C（运行时污染——工具输出去「严重3」黑话）**：matter_sweep 输出文本「（严重3修复：…）」→「（已登记 matter 的 yield 条目已被 SQL 排除…L2 拍板与例行交棒的甄别看 body/payload 含拍板语义）」——运行时语义一行，执行者不再看到无上下文的审视编号。

**delta-D（承诺未兑现——建议 7/9 两条 issue 已建）**：
- 建议 7（覆盖面收窄）：issue #1348 跟踪「未登记搁置表态不在扫描范围，登记习惯未成」
- 建议 9（tool-manifest 声明债）：issue #1349 跟踪「matter_sweep/register_matter 未登记 tool-manifest.json，big=* 通配成立但声明债」

### 自检结果

- `npm run build` ✅（TS 编译零 error）
- `npx vitest run` ✅（全部测试通过）
- `npm run lint:intent` ✅（0 error）
- `npm run test:capability:only` ✅（golden-results.jsonl 已更新，2026-10-08 时间戳）
- 新增测试：MatterSweep 9 用例 + matter_sweep 工具 7 用例 + MatterBrief 组件测试

### 机制预算四问

1. **新能力**：matter_sweep 跨对话停滞扫描（大獭专属只读查询）。
2. **预算理由**：未闭环扫描升格需要确定性数据源，文本启发式退役后必须有一个跨对话查询载体。
3. **预算消耗**：MatterRepository 接口 +2 方法，SqliteMatterRepository +2 实现，MatterSweep usecase，matter-tools.ts +1 工具，prompt 重写。
4. **预算回收**：若未来 HTTP 面提供跨对话端点或扫描任务收拢到单对话，可下线 matter_sweep。
