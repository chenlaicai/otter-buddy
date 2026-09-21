import { describe, it, expect, vi } from "vitest";
import { CreateOtter } from "@usecases/otter/create-otter";
import type { OtterRepository } from "@usecases/otter/otter-repository";
import type { AgentGateway } from "@usecases/otter/agent-gateway";
import type { OtterSession } from "@entities/otter/otter-session";
import { createTestLogger } from "../../helpers/logger";
import { OTTER_PALETTE_KEYS } from "@contract/api/otter-palette";

/** 带状态追踪的 mock repo：记录 createOtter / deleteOtter / createSession 的调用状态 */
function mockRepo(options?: { failCreateSession?: boolean; occupancy?: Map<string, number> }) {
  const createdOtters: Array<{ id: string; name: string }> = [];
  const deletedOtterIds: string[] = [];
  const createdSessions: OtterSession[] = [];

  return {
    _createdOtters: createdOtters,
    _deletedOtterIds: deletedOtterIds,
    _createdSessions: createdSessions,
    createOtter: vi.fn(async (otter: { id: string; name: string }) => {
      createdOtters.push({ id: otter.id, name: otter.name });
    }),
    getById: vi.fn(async () => null),
    getColorOccupancy: vi.fn(async () => options?.occupancy ?? new Map<string, number>()),
    dissolve: vi.fn(async () => {}),
    deleteOtter: vi.fn(async (id: string) => {
      deletedOtterIds.push(id);
    }),
    createSession: vi.fn(async (session: OtterSession) => {
      if (options?.failCreateSession) {
        throw new Error("session 建行失败");
      }
      createdSessions.push(session);
    }),
  } as unknown as OtterRepository & {
    _createdOtters: Array<{ id: string; name: string }>;
    _deletedOtterIds: string[];
    _createdSessions: OtterSession[];
  };
}

/** 带状态追踪的 mock AgentGateway */
function mockAgentGateway(shouldFail = false) {
  const createdAgentIds: string[] = [];
  const destroyedAgentIds: string[] = [];

  return {
    _createdAgentIds: createdAgentIds,
    _destroyedAgentIds: destroyedAgentIds,
    create: vi.fn(async (otterId: string) => {
      createdAgentIds.push(otterId);
      if (shouldFail) {
        throw new Error("Agent 创建失败");
      }
    }),
    destroy: vi.fn(async (otterId: string) => {
      destroyedAgentIds.push(otterId);
    }),
    reset: vi.fn(async () => {}),
  } as unknown as AgentGateway & {
    _createdAgentIds: string[];
    _destroyedAgentIds: string[];
  };
}

describe("CreateOtter", () => {
  describe("execute()", () => {
    it("创建 otter 到 repo + 通过 gateway 创建 agent，返回 status='active' 的 otter", async () => {
      const repo = mockRepo();
      const gateway = mockAgentGateway();
      const useCase = new CreateOtter(repo, gateway, createTestLogger());

      const result = await useCase.execute({
        name: "测试水獭",
        type: "big",
      });

      /** 验证返回的 otter 状态正确 */
      expect(result.name).toBe("测试水獭");
      expect(result.type).toBe("big");
      expect(result.status).toBe("active");
      expect(result.id).toMatch(/^[0-9a-f-]{36}$/);

      /** 验证 repo 中确实创建了 otter */
      expect(repo._createdOtters).toHaveLength(1);
      expect(repo._createdOtters[0].name).toBe("测试水獭");

      /** 验证 gateway 中确实创建了 agent */
      expect(gateway._createdAgentIds).toHaveLength(1);
      expect(gateway._createdAgentIds[0]).toBe(result.id);
    });

    it("F20260805rsto：獭出生即建首世 domain session（active、无前序）", async () => {
      const repo = mockRepo();
      const gateway = mockAgentGateway();
      const useCase = new CreateOtter(repo, gateway, createTestLogger());

      const result = await useCase.execute({ name: "首世水獭", type: "big" });

      expect(repo._createdSessions).toHaveLength(1);
      const session = repo._createdSessions[0];
      expect(session.otterId).toBe(result.id);
      expect(session.status).toBe("active");
      expect(session.previousSessionId).toBeNull();
    });

    it("agent 创建失败时回滚 DB（B1 回归守护）", async () => {
      const repo = mockRepo();
      const gateway = mockAgentGateway(true); // agent 创建会失败
      const useCase = new CreateOtter(repo, gateway, createTestLogger());

      await expect(
        useCase.execute({ name: "失败水獭", type: "small" }),
      ).rejects.toThrow("Agent 创建失败");

      /** 验证 DB 已回滚：deleteOtter 被调用 */
      expect(repo._deletedOtterIds).toHaveLength(1);

      /** 验证 repo 中先创建了 otter，然后被删除 */
      expect(repo._createdOtters).toHaveLength(1);
      expect(repo._deletedOtterIds[0]).toBe(repo._createdOtters[0].id);

      /** agent 未建成，不建 session、不需 destroy */
      expect(repo._createdSessions).toHaveLength(0);
      expect(gateway._destroyedAgentIds).toHaveLength(0);
    });

    it("F20260805rsto：session 建行失败时按序回滚 destroy agent + deleteOtter", async () => {
      const repo = mockRepo({ failCreateSession: true });
      const gateway = mockAgentGateway();
      const useCase = new CreateOtter(repo, gateway, createTestLogger());

      await expect(
        useCase.execute({ name: "回滚水獭", type: "big" }),
      ).rejects.toThrow("session 建行失败");

      /** agent 已建成但必须销毁，否则留下孤立 agent_sessions/config 行 */
      expect(gateway._destroyedAgentIds).toHaveLength(1);
      /** otter 行必须删除（session 单条 INSERT 原子，失败无行，无 FK 阻碍） */
      expect(repo._deletedOtterIds).toHaveLength(1);
      expect(repo._deletedOtterIds[0]).toBe(gateway._createdAgentIds[0]);
      /**
       * 顺序 load-bearing（agent_sessions.otter_id FK → otters）：必须 destroy 先于 deleteOtter，
       * 否则回滚自身 FK 违规、双残留。用 invocationCallOrder 锁定。
       */
      const destroyOrder = (gateway.destroy as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0];
      const deleteOrder = (repo.deleteOtter as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0];
      expect(destroyOrder).toBeLessThan(deleteOrder);
    });

    it("传入 role 和 parentOtterId 时保留在返回的 otter 中", async () => {
      const repo = mockRepo();
      const gateway = mockAgentGateway();
      const useCase = new CreateOtter(repo, gateway, createTestLogger());

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
      const useCase = new CreateOtter(repo, gateway, createTestLogger());

      const result = await useCase.execute({
        name: "默认水獭",
        type: "big",
      });

      expect(result.role).toBeNull();
      expect(result.parentOtterId).toBeNull();
    });
  });

  /** F20260921otcl：出生挑色（方案 §3） */
  describe("出生挑色", () => {
    it("空对话：小獭取色板首色 teal", async () => {
      const repo = mockRepo();
      const gateway = mockAgentGateway();
      const useCase = new CreateOtter(repo, gateway, createTestLogger());

      const result = await useCase.execute({ name: "首色水獭", type: "small", conversationId: "conv-1" });

      expect(result.color).toBe("teal");
    });

    it("占用集跳过：teal 已占用时取次色 caramel", async () => {
      const repo = mockRepo({ occupancy: new Map([["teal", 1]]) });
      const gateway = mockAgentGateway();
      const useCase = new CreateOtter(repo, gateway, createTestLogger());

      const result = await useCase.execute({ name: "次色水獭", type: "small", conversationId: "conv-1" });

      expect(result.color).toBe("caramel");
    });

    it("8 色用尽：挑占用数最少的（并列取色板 index 最小）", async () => {
      // 全占用：teal/lavender/rose/sage/slate/plum 各 2，caramel/amber 各 1 → 最少占用并列，取 index 最小者 caramel
      const occ = new Map<string, number>([
        ["teal", 2], ["caramel", 1], ["lavender", 2], ["rose", 2],
        ["amber", 1], ["sage", 2], ["slate", 2], ["plum", 2],
      ]);
      const repo = mockRepo({ occupancy: occ });
      const gateway = mockAgentGateway();
      const useCase = new CreateOtter(repo, gateway, createTestLogger());

      const result = await useCase.execute({ name: "挤色水獭", type: "small", conversationId: "conv-1" });

      expect(result.color).toBe("caramel");
    });

    it("大獭不分配：type=big 时 color 恒 null（不查占用集）", async () => {
      const repo = mockRepo();
      const gateway = mockAgentGateway();
      const useCase = new CreateOtter(repo, gateway, createTestLogger());

      const result = await useCase.execute({ name: "大獭", type: "big", conversationId: "conv-1" });

      expect(result.color).toBeNull();
      expect(repo.getColorOccupancy).not.toHaveBeenCalled();
    });

    it("无 conversationId（异常路径）：color 落 null 不挑色", async () => {
      const repo = mockRepo();
      const gateway = mockAgentGateway();
      const useCase = new CreateOtter(repo, gateway, createTestLogger());

      const result = await useCase.execute({ name: "无域水獭", type: "small" });

      expect(result.color).toBeNull();
    });

    it("挑色失败不阻断创建（non-fatal）：repo 拋错时 color=null 创建照常", async () => {
      const repo = mockRepo();
      (repo.getColorOccupancy as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("DB 炸了"));
      const gateway = mockAgentGateway();
      const useCase = new CreateOtter(repo, gateway, createTestLogger());

      const result = await useCase.execute({ name: "容错水獭", type: "small", conversationId: "conv-1" });

      expect(result.color).toBeNull();
      expect(result.status).toBe("active");
    });

    it("色板 key 集合完整性：挑出的 key 恒在色板内（与 api-contract 对齐）", async () => {
      // 占用前 7 色（teal..slate）各 1 次，剩下 plum 未占用
      const occ = new Map<string, number>(OTTER_PALETTE_KEYS.slice(0, 7).map(k => [k, 1]));
      const repo = mockRepo({ occupancy: occ });
      const gateway = mockAgentGateway();
      const useCase = new CreateOtter(repo, gateway, createTestLogger());

      const result = await useCase.execute({ name: "末色水獭", type: "small", conversationId: "conv-1" });

      expect(result.color).toBe("plum");
    });
  });
});
