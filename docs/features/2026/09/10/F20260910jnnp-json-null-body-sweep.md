---
id: F20260910jnnp
title: 全仓 controller JSON null body 防御补全（13 端点）
summary: '#890 审视全仓扫描发现 13 处裸 c.req.json() 无任何防御，JSON null body 全部崩 500（11 处回显 V8 错误文本）。本特性将 13 端点统一迁移到 safeJsonBody，修复随之暴露的真实下游崩溃（otter/conversation NOT NULL 约束、connection name.trim、scheduled-task body 类型），并迁移 workspace-controller 的 #888 内联写法到 helper——13 端点 null body 均不再 500、不再泄漏内部错误文本。'
change_type: fix
capability_test: "n/a: 纯后端 A 类代码变更，无 prompt/skill/协议层改动"
created_in_conversation: acf4e2d3-d0ae-4e93-90d8-a9d1f1f602b1
created_at: 2026-09-10
tags: [http, controller, bugfix, json, error-handling]
modules:
  - src/interface-adapters/http
  - src/entities/im
  - src/usecases/scheduled-task
from: [F20260910jnbd]
---

# 全仓 controller JSON null body 防御补全（13 端点）

## 背景

搭档原话：「哎，被你坑了。工作量在当前 ai 时代来说根本不是事呀，判断依据更应该是，是否一次 pr 修复完整不残留。你现在再来一次补充修复」——推翻 #889 审视时「13 端点建 issue 后续修」的处置，要求一次修完整。

#891 登记：PR #890 对抗审视（检视獭glm二号）全端点 PoC 实测，13 个裸 `c.req.json()` 调用点 JSON null body 全部崩 500，其中 11 处回显 V8 内部错误文本。

## 目标

T1: 13 处裸 req.json() 统一迁移到 safeJsonBody（#890 新增的 helper）
T2: workspace-controller 的 #888 内联写法迁移到 safeJsonBody，防御模式全仓集中
T3: 迁移后暴露的下游崩溃链（mock 测试中现形的真实 usecase/entity 缺省值崩溃）一并修复
T4: 13 端点各配「JSON null body 不 500」回归断言

## 非目标

- 不改各端点正常业务语义与成功路径
- 不为 null body 统一规定 400 vs 兜底 {}——本特性只保证「不崩 500、不泄漏内部错误文本」，业务校验语义维持各 usecase 现状（空 input 走各自既有 validation）

## 方案设计

### 迁移（13 端点 + workspace 内联）

13 处 `await c.req.json<T>()` → `await safeJsonBody<T>(c)`；workspace-controller.ts:82 的 `(await c.req.json().catch(() => ({}))) ?? {}` 内联写法 → safeJsonBody。迁移后 null body 统一变 {}，流入各 usecase 的既有 validation（缺字段 → DomainError validation → 400）。

### 迁移暴露的下游崩溃链（测试+真实链路现形）

| 位置 | 崩溃 | 修复 |
|---|---|---|
| usecases/otter/create-otter.ts | name/type 无校验透传 → DB NOT NULL 约束 → 500 回显 `otters.name` 表结构（检视獭glm三号真实 sqlite 实测） | CreateOtter.execute 前置 name/type validation → 400 |
| usecases/conversation/manage-conversation.ts | title 无校验落库 → NOT NULL → 500 回显 `conversations.title`（同上实测） | ManageConversation.create 前置 title validation → 400 |
| entities/im/connection.ts isValidConnectionName/isValidExternalId | `undefined.trim()` TypeError → 500 | 加 `typeof === "string"` 守卫 → usecase 抛 validation → 400 |
| usecases/scheduled-task validateCreateInput | `undefined.length` TypeError → 500（**触发场景是「有 cron 缺 body」的部分缺失 JSON；null body 路径走不到此行**——首行 cron 校验已拦，对抗审视更正月因） | 先判 `typeof body !== 'string'` 返回 'body is required' → 400 |
| scheduled-task controller getNextTriggerAt | usecase mock 返回形状不含 scheduleType（纯测试侧问题） | 测试 mock 修正：create 抛 DomainError（贴近真实 validation 路径）+ cronParser.getNextTime 返 Date |

**判断依据**：前四个崩溃不是 mock 假象——检视獭以真实 sqlite app 对 otter/conversation 实测复现 500（NOT NULL 约束回显表结构），connection 亦真实 app 复现。初版实现误判崩溃链只有 connection/scheduled-task 两处（scheduled-task 的归因还错了），导致 otter/conversation 被 mock 测试掩盖漏修——对抗审视第一轮抓回。

## 影响范围

- 13 端点 null body：500 + V8 错误文本 → 400（业务 validation）或 200/201（空 body 合法场景）
- workspace-controller 行为不变（纯写法集中）
- 正常请求路径零变化（safeJsonBody 对合法 JSON body 透传）

## 设计取舍

| 取舍 | 决策 | 替代方案 | 理由 |
|---|---|---|---|
| null body 语义 | 统一兜底 {} 走既有 validation（多数 → 400） | 逐端点定制 400 文案 | 搭档裁量标准「一次修完整不残留」指防御完整性，非语义定制；各 usecase 既有 validation 已给出具体错误信息（如 'cron is required'），比统一文案更有用 |
| 下游崩溃链是否本 PR 修 | 修（3 处） | 再建 issue | 搭档明确反对「修一个冒一个」——这些崩溃不修则 T1 在 3 端点不成立，属同一防线 |

## 验证

- tests/api/json-null-body.test.ts：13 端点逐一实测 `body: "null"`——**otter/conversation/connection 四端点走真实 sqlite app**（真实 repo + 真实 usecase，仅 agent 层 fake seam），断言具体业务码（400/404）而非仅「不 500」（对抗审视建议 1：not.toBe(500) 防不住 mock 假绿）
- 全量测试 251 files / 3152 tests 全绿；tsc --noEmit 0 error；eslint 0 error
- 对抗审视第一轮发现 3 严重 2 建议，全部本 PR 处置：otter/conversation 真实链路补 validation、文档归因更正、注释归因更正、测试断言强化
- 最简实现检查：已过——核心改动是 13 处单行替换 + 3 处 validation 前置 + 1 处判空，无新依赖新抽象

## 改动范围

| 文件 | 操作 | 说明 |
|---|---|---|
| src/interface-adapters/http/controllers/{connection,conversation,key-info,memory,message,otter,scheduled-task,settings}-controller.ts | 修改 | 13 处 req.json() → safeJsonBody |
| src/interface-adapters/http/controllers/workspace-controller.ts | 修改 | #888 内联写法迁移 safeJsonBody |
| src/usecases/otter/create-otter.ts | 修改 | name/type 前置 validation（400） |
| src/usecases/conversation/manage-conversation.ts | 修改 | title 前置 validation（400） |
| src/entities/im/connection.ts | 修改 | name/externalId 校验加 typeof 守卫 |
| src/usecases/scheduled-task/manage-scheduled-task.ts | 修改 | validateCreateInput body 先判类型 |
| tests/api/json-null-body.test.ts | 新增 | 13 端点 null body 回归（4 端点真实 sqlite 链路） |

## 遗留

- open PR #886 触及 message-controller.ts，合入时注意顺序（本 PR 对 message-controller 仅 2 行替换，冲突面小）
