# F20260720r5kt - API 集成测试套件

## 元信息

- **特性编号**：F20260720r5kt
- **创建日期**：2026-07-20
- **状态**：development
- **变更类型**：feature
- **模块**：testing

## 问题背景

### 现象

前后端通过 HTTP API 交互，每次调整前端或后端代码时，API 协议不一致会导致运行时报错。当前测试仅覆盖 `config-service`，API 路由层（6 个 Controller、约 30 个端点）完全没有自动化测试保障。

### 根因分析

| 缺失项 | 影响 |
|--------|------|
| API 协议层无测试 | 前后端联调才能发现接口不一致 |
| 无 DTO 映射验证 | 字段名/类型变更后前端静默失败 |
| 无状态码映射验证 | DomainError → HTTP status 映射逻辑无回归守护 |
| 无请求体校验测试 | 缺少必填字段时的行为未被覆盖 |

## 用户意图锚

| ID | 用户原话 | 来源 | 关键修饰语 | 架构师解读 |
|----|---------|------|-----------|-----------|
| UA-1 | "模拟请求体，不就能把所有的 api 的业务场景都测试到位了吗" | 对话 | 模拟请求体 | 不需要启动真实服务，直接构造 HTTP 请求测试 |
| UA-2 | "就应该针对前后端的 api 协议做好测试用例即可" | 对话 | api 协议 | 测试重点是 HTTP 层（路由、参数、状态码、响应格式），不是业务逻辑 |

## 设计决策

### D1: Mock Use Case 层，不碰数据库

**决策**：Mock 掉 Controller 的所有依赖（Use Case / Repository 接口），用 `vi.fn()` 控制返回值。

**理由**：
- API 测试的目标是验证 HTTP 协议层（路由匹配、参数解析、状态码映射、DTO 转换）
- Use Case 层有独立的单元测试覆盖业务逻辑
- Mock Use Case 可以精确控制各种边界条件（not_found、conflict、validation）
- 测试速度极快（75 tests / 600ms），适合 CI 频繁运行

### D2: 使用 Hono 原生 `app.request()` 测试

**决策**：直接调用 `app.request(url, init)` 发送请求，不启动真实 HTTP 服务。

**理由**：
- Hono 原生支持，无需 supertest 等额外依赖
- 测试进程内直接调用，无网络开销
- 返回标准 `Response` 对象，断言方式与 fetch 一致

### D3: 覆盖 DomainError → HTTP Status 映射

**决策**：每个 Controller 的错误路径都覆盖 `not_found(404)`、`validation(400)`、`conflict(409)` 映射。

**理由**：`handleError` 的映射逻辑是 API 层的核心职责，必须有回归守护。

## 实现方案

### 测试基础设施 (`tests/api/helpers.ts`)

- Entity fixture 工厂：`makeConversation`, `makeMessage`, `makeOtter`, `makeSession`, `makeMemoryEntry`, `makeParticipant`, `makeKeyFact`, `makeLinkedResource`
- Mock 依赖工厂：`createMockDeps()` 返回所有 6 个 Controller 的 mock 依赖
- Test app 构建器：`createTestApp(deps)` 组装 Controller + Router 返回可测试的 Hono 实例

### 测试文件

| 文件 | 覆盖端点 | 测试数 |
|------|---------|--------|
| `conversation.test.ts` | GET/POST conversations, GET/PATCH complete/archive, GET participants | 13 |
| `message.test.ts` | GET/POST messages, GET events, POST abort | 16 |
| `otter.test.ts` | GET/POST/DELETE otters, GET/POST sessions, POST restart | 12 |
| `memory.test.ts` | GET search, POST similar, GET batch, GET/:id, PATCH flag | 12 |
| `key-info.test.ts` | GET key-info, POST key-facts/resources, DELETE/PATCH key-facts, DELETE resources | 11 |
| `settings.test.ts` | GET/PUT settings | 8 |

### 测试覆盖维度

每个端点覆盖：
1. **正常路径**：正确请求 → 期望状态码 + 响应格式
2. **参数校验**：缺少必填参数 → 400
3. **资源不存在** → 404
4. **业务规则冲突** → 409 / 400
5. **DTO 映射**：验证字段名转换（如 `senderType` → `st`）

## 涉及文件

| 文件 | 改动类型 |
|------|---------|
| `tests/api/helpers.ts` | 新增 |
| `tests/api/conversation.test.ts` | 新增 |
| `tests/api/message.test.ts` | 新增 |
| `tests/api/otter.test.ts` | 新增 |
| `tests/api/memory.test.ts` | 新增 |
| `tests/api/key-info.test.ts` | 新增 |
| `tests/api/settings.test.ts` | 新增 |

## 验证清单

- [x] TypeScript 编译通过
- [x] 75 API 测试全部通过（600ms）
- [x] 覆盖全部 6 个 Controller、约 30 个端点
- [x] 覆盖 DomainError → HTTP status 映射（404/400/409）
- [x] 覆盖 DTO 字段映射验证
