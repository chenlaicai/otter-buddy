---
id: F20260810rstart
title: agent-restart-otter-tool
doc_type: feature

summary: |
  为 agent 层暴露 restart_otter 工具，使海獭能在对话中重启自己或其他獭的獭生。
  访问控制：小獭只能重启自己，大獭可重启任意 otter。
  将 restart 逻辑从 controller 提取到 ManageSession use case 层，controller 和 tool 共用。

causal_links:
  from:
    - F20260805rsto   # 重启獭生 session 机制
  to: []

status: development
change_type: feature
tags: [agent, tool, session, restart, access-control]
modules:
  - src/usecases/otter/manage-session.ts
  - src/interface-adapters/agent-runtime/otter-tool-client.ts
  - src/interface-adapters/agent-runtime/tools/tool-factory.ts
  - src/bootstrap/clients.ts
  - src/interface-adapters/http/controllers/otter-controller.ts
capability_test: "n/a: 纯 agent 工具协议改动，行为验证依赖真实 LLM 场景，非自动化测试可覆盖（参见 F20260811mrpy Part 2 能力测试约定）"
---

# F20260810rstart: Agent 层 restart_otter 工具

## 背景

搭档原话：
> "我要每一只海獭都只能启动*自己*，然后大獭 能 启动 自己以及其他所有獭！"

当前状态：restart 接口只存在于 HTTP API（`POST /api/otters/:id/restart`），agent 层没有对应工具。
海獭无法在对话中重启自己或其他獭的獭生。

## 目标

- **T1**: agent 层新增 `restart_otter` 工具，海獭可在对话中触发重启
- **T2**: 访问控制——小獭只能重启自己，大獭可重启自己和任意小獭
- **T3**: restart 逻辑从 controller 提取到 use case 层，消除重复

## 非目标

- 不改变 HTTP API 的行为（controller 保持"小獭不允许重启"的现有校验）
- 不改变前端 UI 的重启交互
- 不实现"小獭通过 HTTP API 重启自己"的能力（仅 agent tool 层支持）

## 方案设计

### 1. Use Case 层：`ManageSession.restartSession`

将 controller 中内联的 restart 逻辑提取到 `ManageSession`：

```typescript
// src/usecases/otter/manage-session.ts
async restartSession(otterId: string, summary?: string): Promise<OtterSession> {
  // 1. 归档当前 active session（含 agent session reset，确保旧 agent 会话被清理）
  // archiveSession 失败直接上抛，不做竞态认领——
  // 竞态窗口仅存在于 archive 成功后、create 之前的极短间隔
  const active = await this.repo.getActiveSession(otterId);
  if (active) {
    await this.archiveSession(active.id, {
      reason: "restart",
      isNegativeCase: false,
      summary,
    });
  }
  // 2. 创建新 session（写入前情摘要）
  try {
    return await this.createSession(otterId, { summary });
  } catch (err) {
    // 3. 竞态认领：archive 需等 pi 锁（in-flight invoke 可达数分钟），
    //    窗口内新 invoke 的兜底可能已建新行。此时 archive+reset 已真实执行，
    //    撞 conflict 不是用户错误——认领既有新行、补写 summary，按成功处理。
    if (err instanceof DomainError && err.kind === "conflict") {
      const adopted = await this.repo.getActiveSession(otterId);
      if (adopted) {
        if (summary) await this.repo.setSessionSummary(adopted.id, summary);
        this.logger.info("Restart adopted backfilled session", { otterId, sessionId: adopted.id });
        return adopted;
      }
    }
    throw err;
  }
}
```

**`archiveSession` vs `archiveSessionCore`**：
- `archiveSession`（public）：校验 + archiveCore + `agentGateway.reset`（清理旧 agent 会话）+ 日志
- `archiveSessionCore`（private）：仅 DB 归档 + memory layer 转换

restart 必须走 `archiveSession`（含 agent session reset），否则旧 agent 会话残留。与 controller 当前行为一致。

### 2. OtterToolClient 接口扩展

```typescript
// src/interface-adapters/agent-runtime/otter-tool-client.ts
otter: {
  create(params: CreateOtterInput): Promise<Otter>;
  dissolve(otterId: string): Promise<void>;
  getById(id: string): Promise<Otter | null>;
  restart(otterId: string, summary?: string): Promise<OtterSession>;  // 新增
};
```

需要在接口文件中 import `OtterSession` 类型。

### 3. buildOtterToolClient 实现

```typescript
// src/bootstrap/clients.ts
otter: {
  create: (params) => uc.createOtter.execute(params),
  dissolve: (id) => uc.dissolveOtter.execute(id),
  getById: (id) => uc.queryOtter.getById(id),
  restart: (otterId, summary) => uc.manageSession.restartSession(otterId, summary),  // 新增
},
```

### 4. tool-factory.ts：新增 restart_otter 工具

```typescript
// tool-factory.ts
function createRestartOtterTool(ctx: ToolContext): AgentTool {
  return {
    name: "restart_otter",
    description: "重启指定 Otter 的獭生。封存当前 Session（前世），以全新上下文开启新一世。小獭只能重启自己，大獭可重启任意 Otter。",
    parameters: {
      type: "object",
      properties: {
        otterId: {
          type: "string",
          description: "要重启的 Otter ID。省略或为空则重启自己。大獭可传入任意 Otter ID。",
        },
        summary: {
          type: "string",
          description: "前情摘要，将作为新一世的上下文注入。简要说明重启原因。",
        },
      },
      required: [],
    },
    execute: async (_id: string, params: Record<string, unknown>) => {
      const targetOtterId = (params.otterId as string) || ctx.otterId;
      const summary = params.summary as string | undefined;

      // 访问控制：获取调用者类型
      const self = await ctx.client.otter.getById(ctx.otterId);
      const isSmallOtter = self?.type === "small";

      // 小獭只能重启自己
      if (isSmallOtter && targetOtterId !== ctx.otterId) {
        return textResponse("[错误] 小獭只能重启自己的獭生，不能重启其他 Otter。");
      }

      // 校验目标 otter 存在性（避免孤儿 session 或 FK violation）
      const target = await ctx.client.otter.getById(targetOtterId);
      if (!target) {
        return textResponse(`[错误] 目标 Otter ${targetOtterId} 不存在或已解散。`);
      }

      const session = await ctx.client.otter.restart(targetOtterId, summary);
      return textResponse(`Otter ${targetOtterId} 已重启獭生。新 Session ID: ${session.id}`);
    },
  };
}
```

**设计决策**：`otterId` 参数可选，省略时默认重启自己。这样小獭调用时可以不传参数，大獭重启自己也可以不传。

### 5. Controller 重构（复用 use case）

```typescript
// src/interface-adapters/http/controllers/otter-controller.ts
async restart(c: Context): Promise<Response> {
  try {
    const id = param(c, "id");
    const otter = await this.queryOtter.getById(id);
    if (otter?.type === "small") {
      throw new DomainError("小獭不支持重启獭生，请使用解散", "validation");
    }
    const body: { summary?: string } = await c.req.json().catch(() => ({}));
    const session = await this.manageSession.restartSession(id, body.summary);
    return c.json(toOtterSessionDTO(session), 201);
  } catch (err) {
    return handleError(c, err, this.logger);
  }
}
```

controller 保留"小獭不允许重启"的校验（HTTP API 行为不变），但底层逻辑复用 `ManageSession.restartSession`。

## 影响范围

| 功能 | 影响 |
|------|------|
| HTTP API restart | 无行为变化，仅内部实现重构 |
| Agent tool 层 | 新增 restart_otter 工具 |
| 前端 UI | 无变化 |
| 已有 tool（create/dissolve） | 无影响 |

## 风险与约束

1. **`archiveSession` vs `archiveSessionCore`**：restart 需要走 `archiveSession`（含 agent session reset），确保旧 agent 会话被清理。需确认 `archiveSession` 的 public 方法签名。
2. **竞态条件**：archive 需等 pi 锁（in-flight invoke 可达数分钟），窗口内兜底可能已建新行。`restartSession` 内的 `tryAdoptBackfilledSession` 逻辑处理此场景。
3. **小獭 self-restart 前景**：当前 controller 拒绝所有小獭 restart 请求。引入 agent tool 后，小獭可通过 tool 重启自己——这是有意设计（搭档明确要求），但与 controller 行为不同。HTTP API 和 agent tool 的访问控制规则差异需在文档中说明。
4. **self-restart 生命周期**：小獭重启自己时，`archiveSession` 内的 `agentGateway.reset()` 清理旧 agent 会话。reset 是异步操作（在 pi 层处理），不中断当前 tool 执行。tool 执行完返回 textResponse 后，invoke 循环结束，新 session 在下次 invoke 时生效。
5. **非存在 otter 校验**：tool 层在调用 restart 前先校验目标 otter 存在性，避免孤儿 session 或 FK violation。

## 设计取舍

| 取舍 | 决策 | 替代方案 | 理由 |
|------|------|---------|------|
| restart 逻辑位置 | ManageSession use case | Tool 内联 / 独立 use case | 与 archive/create 同层，controller 可复用；独立 use case 过度拆分 |
| otterId 参数默认值 | 省略=重启自己 | 必传 | 小獭典型用法是重启自己，省略更自然 |
| 访问控制位置 | Tool 层 | Use case 层 | use case 层不感知"调用者身份"，访问控制是 tool 层职责 |
| HTTP API 行为 | 保持不变 | 开放小獭 self-restart | 前端已有独立入口，不改 HTTP 行为避免影响面 |
| 目标 otter 存在性 | Tool 层校验 | 不校验 | tool 层先校验再调 restart，避免孤儿 session 或 FK violation，错误信息对 LLM 友好 |
| self-restart 生命周期 | 接受当前行为 | 延迟 reset | archiveSession.reset 是异步 agent 会话清理，不影响当前 tool 执行上下文（tool 在 LLM invoke 循环内执行，reset 在 pi 层异步处理） |

## 验证

### Capability Test

新增 `tests/capability/restart-otter-tool.capability.test.ts`：

- **CT-1**: 大獭调用 restart_otter（无参数）→ 重启自己成功
- **CT-2**: 大獭调用 restart_otter(otterId=小獭ID) → 重启小獭成功
- **CT-3**: 小獭调用 restart_otter（无参数）→ 重启自己成功
- **CT-4**: 小獭调用 restart_otter(otterId=大獭ID) → 被拒绝
- **CT-5**: 小獭调用 restart_otter(otterId=其他小獭ID) → 被拒绝
- **CT-6**: restart 后旧 session 归档、新 session 创建、前情摘要注入
- **CT-7**: restart 不存在/已解散的 otter → 合理错误信息
- **CT-8**: restart 无 active session 的 otter → 创建新 session（不报错）
- **CT-9**: summary 参数为空 vs 有值时的行为差异验证

### 单元测试

- `ManageSession.restartSession` 测试：正常流程、无 active session、竞态认领

## 改动范围

| 文件 | 操作 | 说明 |
|------|------|------|
| `src/usecases/otter/manage-session.ts` | 修改 | 新增 `restartSession` 方法 |
| `src/interface-adapters/agent-runtime/otter-tool-client.ts` | 修改 | `otter` 接口加 `restart` |
| `src/bootstrap/clients.ts` | 修改 | `buildOtterToolClient` 实现 restart |
| `src/interface-adapters/agent-runtime/tools/tool-factory.ts` | 修改 | 新增 `createRestartOtterTool`，注册到工具列表 |
| `src/interface-adapters/http/controllers/otter-controller.ts` | 修改 | `restart` 方法复用 `manageSession.restartSession` |
| `tests/capability/restart-otter-tool.capability.test.ts` | 新增 | capability test |
