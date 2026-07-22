import { describe, it, expect, vi } from "vitest";
import { CreateOtter } from "@usecases/otter/create-otter";
import type { OtterRepository } from "@usecases/otter/otter-repository";
import type { AgentGateway } from "@usecases/otter/agent-gateway";

/** 带状态追踪的 mock repo：记录 createOtter 和 deleteOtter 的调用状态 */
function mockRepo() {
  const createdOtters: Array<{ id: string; name: string }> = [];
  const deletedOtterIds: string[] = [];

  return {
    _createdOtters: createdOtters,
    _deletedOtterIds: deletedOtterIds,
    createOtter: vi.fn(async (otter: { id: string; name: string }) => {
      createdOtters.push({ id: otter.id, name: otter.name });
    }),
    getById: vi.fn(async () => null),
    dissolve: vi.fn(async () => {}),
    deleteOtter: vi.fn(async (id: string) => {
      deletedOtterIds.push(id);
    }),
  } as unknown as OtterRepository & {
    _createdOtters: Array<{ id: string; name: string }>;
    _deletedOtterIds: string[];
  };
}

/** 带状态追踪的 mock AgentGateway */
function mockAgentGateway(shouldFail = false) {
  const createdAgentIds: string[] = [];

  return {
    _createdAgentIds: createdAgentIds,
    create: vi.fn(async (otterId: string) => {
      createdAgentIds.push(otterId);
      if (shouldFail) {
        throw new Error("Agent 创建失败");
      }
    }),
    destroy: vi.fn(async () => {}),
    reset: vi.fn(async () => {}),
  } as unknown as AgentGateway & {
    _createdAgentIds: string[];
  };
}

describe("CreateOtter", () => {
  describe("execute()", () => {
    it("创建 otter 到 repo + 通过 gateway 创建 agent，返回 status='active' 的 otter", async () => {
      const repo = mockRepo();
      const gateway = mockAgentGateway();
      const useCase = new CreateOtter(repo, gateway);

      const result = await useCase.execute({
        name: "测试水獭",
        type: "big",
      });

      /** 验证返回的 otter 状态正确 */
      expect(result.name).toBe("测试水獭");
      expect(result.type).toBe("big");
      expect(result.status).toBe("active");
      expect(result.id).toBeTruthy();

      /** 验证 repo 中确实创建了 otter */
      expect(repo._createdOtters).toHaveLength(1);
      expect(repo._createdOtters[0].name).toBe("测试水獭");

      /** 验证 gateway 中确实创建了 agent */
      expect(gateway._createdAgentIds).toHaveLength(1);
      expect(gateway._createdAgentIds[0]).toBe(result.id);
    });

    it("agent 创建失败时回滚 DB（B1 回归守护）", async () => {
      const repo = mockRepo();
      const gateway = mockAgentGateway(true); // agent 创建会失败
      const useCase = new CreateOtter(repo, gateway);

      await expect(
        useCase.execute({ name: "失败水獭", type: "small" }),
      ).rejects.toThrow("Agent 创建失败");

      /** 验证 DB 已回滚：deleteOtter 被调用 */
      expect(repo._deletedOtterIds).toHaveLength(1);

      /** 验证 repo 中先创建了 otter，然后被删除 */
      expect(repo._createdOtters).toHaveLength(1);
      expect(repo._deletedOtterIds[0]).toBe(repo._createdOtters[0].id);
    });

    it("传入 role 和 parentOtterId 时保留在返回的 otter 中", async () => {
      const repo = mockRepo();
      const gateway = mockAgentGateway();
      const useCase = new CreateOtter(repo, gateway);

      const role = { name: "助手", responsibilities: ["回答问题"] };
      const result = await useCase.execute({
        name: "子水獭",
        type: "small",
        role,
        parentOtterId: "parent-123",
      });

      expect(result.role).toEqual(role);
      expect(result.parentOtterId).toBe("parent-123");
    });

    it("未传 role 和 parentOtterId 时默认为 null", async () => {
      const repo = mockRepo();
      const gateway = mockAgentGateway();
      const useCase = new CreateOtter(repo, gateway);

      const result = await useCase.execute({
        name: "默认水獭",
        type: "big",
      });

      expect(result.role).toBeNull();
      expect(result.parentOtterId).toBeNull();
    });
  });
});
