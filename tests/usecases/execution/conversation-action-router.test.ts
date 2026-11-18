import { describe, expect, it } from "vitest";
import { ConversationActionRouter } from "@usecases/execution/conversation-action-router";
import type { ExecutionMachine } from "@usecases/ports/execution-machine";

/**
 * F20261118crtgr（#1868 阶段 5 PR-A）：对话级执行机路由单测——
 * 默认 local / 对话切换远程 / 显式 target 优先 / 悬空目标 fail-closed（方案 §2.2）。
 */

function fakeMachine(id: string): ExecutionMachine & { calls: Array<{ type: string; target?: string }> } {
  const calls: Array<{ type: string; target?: string }> = [];
  return {
    id,
    name: id,
    calls,
    createExecutionEnvironment: () => { throw new Error("not under test"); },
    run: async (action, target) => {
      calls.push({ type: action.type, target });
      return true as never;
    },
  };
}

function setup(conversationMachines: Record<string, string | null> = {}) {
  const local = fakeMachine("local");
  const remote = fakeMachine("connector-b");
  const machines = new Map([[local.id, local], [remote.id, remote]]);
  const registry = {
    resolve: (target?: string) => {
      const machine = machines.get(target ?? "local");
      if (!machine) throw new Error(`Execution machine not registered: ${String(target)}`);
      return machine;
    },
  };
  const conversations = {
    getExecutionMachineId: async (id: string) => conversationMachines[id] ?? null,
  };
  const router = new ConversationActionRouter(registry, conversations);
  return { router, local, remote };
}

describe("ConversationActionRouter（阶段 5 PR-A）", () => {
  it("对话无配置 → 默认 local（存量对话零迁移零行为变化）", async () => {
    const { router, local, remote } = setup();
    await router.run({ type: "workspace.exists", input: { conversationId: "c-legacy" } });
    expect(local.calls).toHaveLength(1);
    expect(remote.calls).toHaveLength(0);
  });

  it("对话切换到 connector → 六动作路由远程机（conversationId 从 action.input 提取）", async () => {
    const { router, local, remote } = setup({ "c-remote": "connector-b" });
    await router.run({ type: "workspace.write", input: { conversationId: "c-remote", relativePath: "a.md", content: "x" } });
    expect(remote.calls).toHaveLength(1);
    expect(remote.calls[0]!.type).toBe("workspace.write");
    expect(local.calls).toHaveLength(0); // 不落 local——「以为在 B 其实在 A」被杜绝
  });

  it("显式 targetOverride 优先于对话配置", async () => {
    const { router, local, remote } = setup({ "c-remote": "connector-b" });
    await router.run({ type: "workspace.exists", input: { conversationId: "c-remote" } }, "local");
    expect(local.calls).toHaveLength(1); // 显式 local 压过对话的 connector-b
    expect(remote.calls).toHaveLength(0);
  });

  it("对话指向已撤销/未上线设备 → fail-closed 报错不静默回切", async () => {
    const { router, local } = setup({ "c-dangling": "connector-dead" });
    await expect(router.run({ type: "workspace.exists", input: { conversationId: "c-dangling" } }))
      .rejects.toThrow("Execution machine not registered: connector-dead");
    expect(local.calls).toHaveLength(0); // 没有静默落回 local
  });

  it("对话查询失败 → 回落默认 local（路由是增强不是硬依赖）", async () => {
    const local = fakeMachine("local");
    const registry = { resolve: (target?: string) => (target === undefined ? local : (() => { throw new Error("x"); })()) };
    const router = new ConversationActionRouter(registry, {
      getExecutionMachineId: async () => { throw new Error("db locked"); },
    });
    await router.run({ type: "workspace.exists", input: { conversationId: "c-1" } });
    expect(local.calls).toHaveLength(1);
  });

  it("六动作外的动作无 conversationId → 默认 local（防御路径）", async () => {
    const { router, local } = setup();
    await router.run({ type: "workspace.path", input: { conversationId: "c-x" } } as never);
    expect(local.calls).toHaveLength(1);
  });
});
