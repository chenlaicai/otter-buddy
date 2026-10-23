---
id: F20261023cnct
title: IM 旧连接管理 API 死端点下线与契约同步（issue #1063）
summary: 下线 PR #1055（F20260920imax）IM 助理模式后前端零调用的 4 个死端点（GET/POST /api/connections、GET :id/session、POST :id/leave）——HTTP 层退役（路由+controller 方法+死 DTO），usecase ManageConnection 方法全量保留给 IM 命令体系；存活端点 DTO 迁入 api-contract 单一真相源消除双端漂移；身份策略规则防御纵深保留（注释锚定）。
change_type: refactor
capability_test: "tests/api/connection.test.ts 新增「死端点已下线（issue #1063 契约无残留断言）」3 用例：生产 router.ts 源文本零死端点注册、ConnectionController 方法面零死方法、usecase ManageConnection 方法保留断言（牙齿自证：回滚 router/controller 改动后全红）。回归口径：npx vitest run tests/api/connection.test.ts tests/api/json-null-body.test.ts tests/interface-adapters/http/identity-middleware.test.ts tests/usecases/im/manage-connection.test.ts（74 用例绿）+ 全量 421 文件 6754 用例绿 + 根/web tsc --noEmit 零错误"
intent:
  problem: "issue #1063（P2 tech-debt，PR #1055 第三轮检视（检视imax3）建议发现 1）：IM 助理模式落地后前端已不再使用 GET/POST /api/connections、GET /api/connections/:id/session、POST /api/connections/:id/leave 四个 API（web client.ts 对应函数已删），但 HTTP 层路由与 controller 方法仍留存，且 connections DTO 在后端 dto/connection-dto.ts 与 web/src/api/client.ts 双端各自定义（漂移面）。"
  expected_effect: "HTTP 面与前端可达面一致：4 个死端点 404（Hono 未注册路由自然 404），后端不再暴露无消费方的写口（POST /api/connections 通道注册口退役）；usecase 方法不受影响（feishu command-dispatcher.ts:54、weixin message-processor.ts:232 复用 leaveConversation 等）；连接 DTO 经 @contract/api/connection 单源消费，双端漂移面消除。"
  verify_by:
    type: capability_test
    detail: "契约无残留断言 3 用例（router 源文本+controller 方法面+usecase 保留面）+ 74 相关用例绿 + 全量 6754 用例绿 + 双端 tsc 零错误；关闭标准验证断言「下线后契约测试无残留引用」由源文本断言机械化固化"
created_in_conversation: a9260c50-cef6-412e-a0b4-282287a13103
tags: [im, tech-debt, api-contract, dead-endpoint, security-policy]
modules: [src/interface-adapters, api-contract, web, tests]
---

# IM 旧连接管理 API 死端点下线与契约同步（issue #1063）

## 1. 来源

issue #1063（P2 tech-debt，PR #1055 第三轮检视（检视imax3）建议发现 1，2026-09-29 清账批次关闭标准：「4 个死端点 HTTP 层下线 + usecase 方法保留给命令体系 + api-contract 同步」，验证断言「下线后契约测试无残留引用」）。

## 2. 方案设计

### 下线面（HTTP 层退役，4 个死端点）

| 端点 | router.ts | controller 方法 | 处置 |
|---|---|---|---|
| GET /api/connections | 删 | list 删 | 前端 PR #1055 后零调用 |
| POST /api/connections | 删 | create 删 | 同上；CreateConnectionRequestDTO 一并删除 |
| GET /api/connections/:id/session | 删 | getSession 删 | 同上 |
| POST /api/connections/:id/leave | 删 | leaveConversation 删 | 同上 |

存活端点不动：GET /api/connections/:id（getById）、POST /api/connections/:id/enter（enterConversation）、GET /api/connections/:id/conversations（listActiveConversations）——前端 getConnection/enterConversation/listActiveConversations 仍在用（web/src/api/client.ts:517-526）。

### 保留面（usecase 方法全量保留，关闭标准字面执行）

ManageConnection（src/usecases/im/manage-connection.ts）方法全部保留：leaveConversation 被 feishu command-dispatcher.ts:54、weixin message-processor.ts:232 复用；createConnection 被 manage-connection.ts:65（ensureConnection 链路）内部复用；listConnections 虽在 HTTP 下线后暂无调用方，按关闭标准「usecase 方法保留给命令体系」不删（且 TS 类 public 方法无 unused 报错）。

### 契约同步（api-contract 单一真相源）

新建 api-contract/api/connection.ts：ConnectionDTO、ConnectionSessionDTO、EnterConversationRequestDTO、ActiveConversationDTO（listActiveConversations 返回元素，原双端 inline）。后端 dto/connection-dto.ts 改为 re-export @contract 类型 + 保留实体→DTO 映射函数（映射属 HTTP 层职责非契约本身）；web/src/api/client.ts 的 3 个本地 interface 删除改从 @contract/api 消费。api-contract/api/index.ts 聚合导出。

### 身份策略防御纵深（L1 取舍）

identity-middleware.ts 两条 connections 策略规则**有意保留休眠**（注释锚定 #1063）：
- :65 POST :id/(enter|leave)→write 的 leave 分支：端点下线后休眠，删/收窄会让 POST :id/leave 跌入 :77 admin 匹配（行为变化），保留零行为变化
- :77 POST/DELETE /api/connections*→admin：通道注册口虽退役，但删规则会使未来误挂的 POST /api/connections* 写口跌入 fail-closed 兜底 **write**（admin→write = 安全降级），保留作防误挂兜底

测试矩阵（identity-middleware.test.ts）的死端点路径行删除（矩阵收敛为活端点策略面），源码规则的休眠保留与测试缺口在两侧注释互锚。

## 3. 验证

- **契约无残留断言（牙齿自证）**：tests/api/connection.test.ts 新增 3 用例——① router.ts 源文本零死端点注册（readFileSync 断言 4 个注册串不存在）② ConnectionController.prototype 零死方法 + 存活方法仍在 ③ ManageConnection.prototype 方法保留。回滚 router/controller 改动后 ①② 全红（牙齿成立）
- **回归**：相关 4 测试文件 74 用例绿（含 json-null-body.test.ts、identity-middleware.test.ts、manage-connection.test.ts）；全量 vitest 421 文件 6754 用例绿（6 skip）
- **静态检查**：根 tsc --noEmit 零错误（含 tests/，json-null-body.test.ts 的 ctrl.create 漏网引用由 tsc 抓出后清）；web tsc --noEmit 零错误

## 4. 影响范围

- src/interface-adapters/http/router.ts（-4 行路由+注释）
- src/interface-adapters/http/controllers/connection-controller.ts（-4 方法）
- src/interface-adapters/http/dto/connection-dto.ts（CreateConnectionRequestDTO 删，类型改 @contract re-export）
- src/interface-adapters/http/identity-middleware.ts（仅注释，零行为变化）
- api-contract/api/connection.ts（新建）+ api-contract/api/index.ts（聚合导出）
- web/src/api/client.ts（3 interface 改 @contract 消费 + listActiveConversations 返回类型收口）
- tests/api/connection.test.ts、tests/api/json-null-body.test.ts、tests/interface-adapters/http/identity-middleware.test.ts（死端点用例清理 + 无残留断言新增）

破坏性变更说明：4 个死端点从「200/400/404/409 业务响应」变「404 未注册」——已确认前端零调用（PR #1055 已删 client.ts 对应函数），无消费方受影响。
