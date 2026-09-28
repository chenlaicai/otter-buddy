---
id: F20260928wak1
title: web 助理对话侧栏分组失踪：conversation-mapper kind 双值折叠漏扩枚举
summary: 搭档实测点浮动獭 say hi 后，侧栏「web助理」分组下没有对话。排查确认对话已创建且列表 API 正常返回（排第 8 位），但 kind 字段为空——根因是 conversation-mapper.ts 的 rowToConversation 双值折叠（assistant 之外一律 normal）未随 F20260924wast 枚举扩展更新，把 web-assistant 折成 normal，前端分组认不出。修法为合法枚举透传 + 未知值回退 normal。
change_type: fix
tags: [web-assistant, conversation-mapper, kind, bugfix]
modules:
  - src/frameworks/db/conversation/conversation-mapper.ts
from: [F20260924wast]
created_in_conversation: 480589fd-5813-400a-9b07-8e7d5707fb34
---

# web 助理对话侧栏分组失踪（F20260928wak1）

## 预注册（动手前冻结）

- 预期根因方向：首唤自动开户链路某环断了——要么后端没建对话，要么建了但侧栏分组渲染丢
- 验证标准：找到开户代码路径 + LeftPanel 分组条件，对照「say hi」应触发的调用链定位断点
- 最强反例方向：代码链路完好 → 转向运行时因素（旧代码未重启 / 对话落在别的分组）

**实际：预期部分命中后反转**——链路逐环核实全部正常（DB 有对话、entries 有 hi、列表 API 返回它），最后在 API 实测时反转：**kind 字段丢失**，断点不在「建没建」而在「建了认不出」。

## 问题现象（搭档实测反馈 2026-09-28 21:00）

点击浮动獭 say hi，左侧栏「web助理」分组下没有出现固定对话。

## 排查链（逐环证据）

| 环节 | 核实方式 | 结果 |
|---|---|---|
| 对话是否创建 | sqlite 直查 conversations 表 | ✅ 存在（id 9d6ffef1，kind=web-assistant，active，今晨首唤时建） |
| hi 消息是否进入 | entries 表直查 | ✅ 4 条 entry（user hi → invoke_start → 429 系统告警 → invoke_end） |
| 列表 SQL 是否返回 | 模拟 listConversationsWithMeta 完整 SQL | ✅ 排名第 8 / 236 active，limit 500 窗内 |
| 列表 API 是否返回 | curl 实测 localhost:3000 | ✅ 返回，**但 kind 字段为 null** ← 断点 |
| 前端分组 | LeftPanel.tsx:185 `filter(c => c.kind === 'web-assistant')` | kind 空 → 不入 web助理组，掉进普通「对话」组 |

对照自洽：3 条 IM 助理对话（kind=assistant）kind 正常透出——折叠逻辑恰好覆盖 assistant，唯独 web-assistant 被吞。

## 根因

`src/frameworks/db/conversation/conversation-mapper.ts:98`（修复前）：

```ts
kind: row.kind === "assistant" ? "assistant" : "normal",
```

双值折叠写于 IM 助理时代（F20260920imax）。F20260924wast 扩枚举加 web-assistant 时，改了 entity/controller/DTO/前端类型链，漏改了这个 mapper 折叠行——DB 明明存着 web-assistant，读出来变 normal。DTO 层 `conv.kind !== "normal"` 的条件（conversation-dto.ts:20）随即把它整个吞掉，API 返回里 kind 字段消失。

## 修法决策树

**① 既有语义内修**：折叠改为合法枚举透传，未知值/缺省仍回退 normal（存量空列 + 旧库兼容不变）。

机制识别检查点：全未命中（纯投影函数值域修正，无新状态/分支/持久化/跨模块路径）——走轻对抗路径，不涉净新增机制。

## 修复

```ts
// F20260928wak1：合法枚举透传（修复线上 bug——双值折叠把 web-assistant 折成
//  normal，侧栏分组认不出 web 助理对话）。未知值/缺省回退 normal（存量为空列 + 旧库兼容）
kind: row.kind === "assistant" || row.kind === "web-assistant" ? row.kind : "normal",
```

## 失败用例证据（修复前红 → 修复后绿）

新增 3 个回归用例（tests/frameworks/db/conversation/sqlite-conversation-repository.test.ts）：

**修复前（21:07，2 failed | 25 passed）**：

```
FAIL  tests/frameworks/db/conversation/sqlite-conversation-repository.test.ts
✗ F20260928wak1：kind=web-assistant 透传不折叠为 normal（getById 路径）
  Expected: "web-assistant"  Received: "normal"
✗ F20260928wak1：kind=web-assistant 在 listWithMeta 路径同样透传（侧栏分组数据源）
  Expected: "web-assistant"  Received: "normal"
```

**修复后（21:08，27 passed）**：同文件 27/27 绿；全量 4192/4192 绿；tsc --noEmit 0 错。

护栏用例：kind=assistant 不回归（合法枚举既有值）。

## 影响范围

- getById 与 listConversationsWithMeta 两条读路径共用 rowToConversation，一并修复
- **第二消费方（检视 M1 发现）**：message-controller.ts `checkWebAssistantSession`（F20260924wast S1）也经 getById 判 kind——折叠 bug 期间恒早退，**web 助理 session 轮换自 #1174 上线起静默失效**；本次修复顺带复活。合入后首次触发 idle 检查可能立即换 session（设计行为但用户可感知）；存量测试 `web-assistant-session-check.test.ts:38` 恰在 repo.getById 处 mock，绕过了出 bug 的 mapper 缝隙（逃逸路径，非测试错）
- 非枚举值回退 normal 行为不变，无存量数据风险（列 NOT NULL DEFAULT 'normal'，migration.ts ensureConversationsKindColumn）
- 修复上线后无需数据迁移——DB 里 kind 本来就是对的，只是读丢了

## 遗留（顺带发现，与本 bug 无关）

- 搭档 21:00 的 hi 未获回复：web 助理对话后端獭模型 kimi 配额耗尽（429 终态，entries 第 3-4 条留痕），配额恢复后重发即可
- 枚举三处平行硬编码（entity / mapper / DTO 白名单）——本 bug 成因模式（扩枚举漏改投影点）未极除，建议后续单源化（检视 SG1，未在本 PR 处理，避免扩散修改面）

## 预期 vs 实际对照

预期「开户链路断了」——前四环全部正常证伪；API 实测 kind 缺失反转方向至投影层。预注册的最强反例「对话落在别的分组」字面命中：它确实落进了普通对话组（第 8 位，标题「web 助理」）。
