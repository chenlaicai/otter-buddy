---
id: F20261104ssfde
title: 定时任务触发消息中间栏折叠：长任务指令默认收起一行
summary: 定时任务触发时 scheduler 把完整任务指令（最大 10KB+）作为 system entry 插入对话，前端全文渲染导致中间栏被任务指令铺满（搭档 2026-11-04 报告）。修复：scheduler 来源（senderName 前缀识别）超 800 字符的系统消息默认折叠成一行「⏰ 定时任务「名」已触发」，点开看全文；SSE 实时广播补透 senderName，消除实时/刷新后渲染形态漂移。
change_type: bugfix
intent:
  problem: "定时任务触发消息（完整任务指令，最大 10KB+）在中间栏全文渲染，铺满时间线，搭档每天被打扰"
  expected_effect: "scheduler 来源超 800 字符的 system 消息默认渲染为一行折叠态（任务名+时间），点击可展开全文；其余系统消息渲染不变"
  verify_by:
    type: behavior_check
capability_test: "n/a: UI 渲染行为，组件测试（MessageList.test.tsx 4 用例）+ alpha 实例 Playwright 真机截图覆盖（折叠 36px / 展开 892px）"
created_in_conversation: a23f0f4a-612c-46e9-8d83-be648ced720e
tags: [web, scheduler, conversation]
modules: [web/src/pages/conversation, src/usecases/scheduler]
created_at: 2026-11-04
---

# 定时任务触发消息中间栏折叠（F20261104ssfde）

## 案发现场

搭档 2026-11-04 08:49 报告：《三省吾身》中间栏又出现一大坨任务内容（开头「回顾昨日全部对话，按问题拆 GitHub issue」），上周修过一次以为已解决。

## 排查结论（已核实，非推测）

两次修复与本次现象是三条不同路径：

| 修复 | 路径 | 与本次关系 |
|---|---|---|
| PR #947（2026-09-15） | 右栏任务面板裸渲 body → 加 description 字段 | 无关 |
| PR #1731（2026-11-02，issue #1512） | healing 分析任务 prompt 瘦身（事件样本线索化） | 无关——只治了 16 个任务中 1 个的「内容太长」 |
| **本次** | **中间栏 system entry 全文渲染** | **未治理过的路径** |

**根因链**（file:line 锚点）：
1. scheduler 触发定时任务时，`src/usecases/scheduler/scheduler-service.ts` `createSystemSignalEntry` 把**完整任务 prompt** 作为 system entry 插入对话（`senderName: 'scheduler:<任务名>'`）。这是 LLM 换世补扫机制的锚点消息——执行獭重启后按此消息恢复任务上下文，**后端不能截断**。
2. 前端 `web/src/pages/conversation/MessageList.tsx`（改动前 :951）对 system 消息**全文渲染无折叠**——10KB 指令全文铺在中间栏。

**实测数据**（sqlite 直查 otter-buddy.db，近 3 天，字符号）：健康检查 6345、issue 处理 3921、未闭环扫描 1339、依赖升级 1274、补丁清单 814、healing 分析 1980（PR #1731 修复前 >10KB）。每天 5-6 条此类消息插入《三省吾身》。

**本质**：这条消息身兼两职——给 LLM 的任务指令 + 给人看的时间线条目。人只需要一行「⏰ 每日健康检查已触发」。

## 设计取舍

**方案选择**：前端折叠（选中）vs 后端截断/摘要（否决）——后端截断会破坏补扫机制依赖的全文锚点；摘要需要二次存储且引入「摘要与 body 漂移」问题。前端折叠零后端语义变更。

**识别依据**：`senderName` 以 `scheduler:` 开头（写入点唯一且稳定，F20260913ctlv 起即存在）+ 长度 > 800 字符（阈值覆盖全部实测任务消息，最小的补丁清单 814 也折叠——它同样是完整指令；短于阈值的小提示不折叠，避免点击成本）。旧数据无 senderName → 不折叠，历史兼容零迁移。

**修法决策树**：①既有语义内修（narrow-fix）——不新增机制，复用 senderName 既有字段与 glass-card 既有样式。

**机制识别检查点**（动手前判定）：不新增守卫/流程/审批层；不改变任何决策归属；深潜成本不变（展开全文即原始 body）。四问未命中，无机制预算问题。

**SSE 补透 senderName**：历史接口（entry-controller DTO）本就透传 senderName，但实时广播 data 只有 entryId/content/sequenceNum/createdAt——同一消息刷新前后渲染形态会漂移（实时无折叠依据、刷新后折叠）。补一行 senderName 字段，两链路一致。

## 变更清单

| 文件 | 改动 |
|---|---|
| `src/usecases/scheduler/scheduler-service.ts` | `createSystemSignalEntry` 广播 data 补 `senderName: entry.senderName`（+注释） |
| `web/src/pages/conversation/index.tsx` | 两处 SSE `entry.system` handler 接收 `senderName` 写入 LocalMessage.sn |
| `web/src/pages/conversation/MessageList.tsx` | system 消息渲染分流：scheduler 来源且 >800 字符 → 折叠态（标题行 + 展开按钮 + 展开态全文）；`SCHEDULER_SYSMSG_FOLD_THRESHOLD` 常量 + `expandedSchedulerMsgs` 本地状态（经 props 传 MessageItem，不持久化——刷新回默认折叠） |
| `web/src/pages/conversation/MessageList.test.tsx` | 4 用例：折叠态渲染/展开收起交互/短消息不折叠/无前缀不折叠 |
| `tests/usecases/scheduler/scheduler-service.test.ts` | 1 用例：trigger 广播 entry.system data 含 senderName |

## 验证

- 单测：`MessageList.test.tsx` 36/36 通过（含新增 4 例）；`scheduler-service.test.ts` 111/111 通过（含新增 1 例）
- tsc：主仓 tsconfig + web tsconfig 均 0 error
- **真机自查**（UI 硬规则）：alpha 实例（port 3172，独立数据根）+ Playwright：构造 1919 字符 scheduler system entry → 折叠容器渲染 1 个，折叠态高 36.65px（一行标题「⏰ 定时任务「每日对话健康检查」已触发 · 2026-11-04 08:30:00 展开全文 2k 字 ▼」），点击展开 892.65px 全文渲染。截图：对话工作区 `fold-collapsed.png` / `fold-expanded.png`
- 已过最简实现检查（折叠态用既有 glass-card 样式 + 原生 button，无新依赖；识别用既有 senderName 字段，无新字段）

### 验收断言

| 场景 | 操作 | 预期结果 |
|---|---|---|
| scheduler 长消息默认折叠 | 渲染 sn=scheduler:X、content>800 的 system 消息 | `[data-testid="scheduler-sysmsg-fold"]` 存在，正文不渲染，标题行含任务名 |
| 展开交互 | 点击折叠态按钮 | 全文渲染；再点收起 |
| 短 scheduler 消息 | content ≤800 | 不折叠，全文直出 |
| 非 scheduler system 消息 | sn 无 scheduler: 前缀（含旧数据） | 渲染不变（无折叠） |
| SSE 实时形态一致 | 任务触发时前端在线 | 实时插入的消息即折叠态（senderName 随广播透出） |

## 影响范围与残余风险

- 影响面：仅中间栏 system 消息渲染 + scheduler 广播 payload 增一个字段。LLM 补扫、右栏任务面板、其他 system 消息（工具异常重试等）零影响。
- 残余风险：执行獭在任务触发后 speak 引用该 system 消息时，人若想核对全文需点开一次（一次性点击成本，可接受）。
- 回滚：revert 本 PR 即恢复原文全渲染，无数据迁移。

## 后续（非本 PR）

daily-health-check prompt 本身 10793 字节贴 budget 上限、承载 15 个职责段——瘦身/拆分评估另行立项（需过锚点重放评审），本 PR 只治渲染形态。
