import { describe, it, expect, vi } from "vitest";
import { DissolveOtter } from "@usecases/otter/dissolve-otter";
import { DomainError } from "@entities/errors";
import type { Otter } from "@entities/otter/otter";
import type { OtterRepository } from "@usecases/otter/otter-repository";
import type { AgentGateway } from "@usecases/otter/agent-gateway";

import type { OtterSession } from "@entities/otter/otter-session";
import type { ManageSession } from "@usecases/otter/manage-session";

/** 创建一个 active 状态的 otter 测试数据 */
function makeActiveOtter(overrides: Partial<Otter> = {}): Otter {
  return {
    id: "otter-1",
    name: "测试水獭",
    type: "big",
    status: "active",
    role: null,
    parentOtterId: null,
    createdAt: "2026-07-20T00:00:00Z",
    dissolvedAt: null,
    ...overrides,
  };
}

/** 创建一个 active session 测试数据 */
function makeActiveSession(overrides: Partial<OtterSession> = {}): OtterSession {
  return {
    id: "sess-1",
    otterId: "otter-1",
    status: "active",
    previousSessionId: null,
    startedAt: "2026-07-20T00:00:00Z",
    archivedAt: null,
    archiveReason: null,
    isNegativeCase: false,
    summary: null,
    ...overrides,
  };
}

/** 带状态追踪的 mock repo：记录操作序列 */
function mockRepo(otter: Otter | null = null) {
  const operations: string[] = [];
  let dissolvedOtterId: string | null = null;

  return {
    _operations: operations,
    _dissolvedOtterId: () => dissolvedOtterId,
    getById: vi.fn(async () => otter),
    dissolve: vi.fn(async (id: string) => {
      dissolvedOtterId = id;
      operations.push("dissolve");
    }),
    createOtter: vi.fn(async () => {}),
    deleteOtter: vi.fn(async () => {}),
  } as unknown as OtterRepository & {
    _operations: string[];
    _dissolvedOtterId: () => string | null;
  };
}

/** 带状态追踪的 mock AgentGateway */
function mockAgentGateway() {
  const destroyedIds: string[] = [];

  return {
    _destroyedIds: destroyedIds,
    create: vi.fn(async () => {}),
    destroy: vi.fn(async (id: string) => {
      destroyedIds.push(id);
    }),
    reset: vi.fn(async () => {}),
  } as unknown as AgentGateway & {
    _destroyedIds: string[];
  };
}

/** 带状态追踪的 mock ManageSession */
function mockManageSession(activeSession: OtterSession | null = null) {
  const archivedSessionIds: string[] = [];
  const archiveInputs: Array<{ reason: string; isNegativeCase: boolean; summary?: string }> = [];

  return {
    _archivedSessionIds: archivedSessionIds,
    _archiveInputs: archiveInputs,
    getActiveSession: vi.fn(async () => activeSession),
    archiveSession: vi.fn(async (sessionId: string, input: { reason: string; isNegativeCase: boolean; summary?: string }) => {
      archivedSessionIds.push(sessionId);
      archiveInputs.push(input);
    }),
  } as unknown as ManageSession & {
    _archivedSessionIds: string[];
    _archiveInputs: Array<{ reason: string; isNegativeCase: boolean; summary?: string }>;
  };
}

describe("DissolveOtter", () => {
  describe("execute()", () => {
    it("解散有 active session 的 otter：归档 session + 更新状态 + 销毁 agent", async () => {
      const otter = makeActiveOtter();
      const session = makeActiveSession();
      const repo = mockRepo(otter);
      const gateway = mockAgentGateway();
      const manageSession = mockManageSession(session);

      const useCase = new DissolveOtter(repo, gateway, manageSession);
      await useCase.execute("otter-1");

      /** 验证 session 被归档 */
      expect(manageSession._archivedSessionIds).toEqual(["sess-1"]);
      expect(manageSession._archiveInputs[0].reason).toBe("dissolve");

      /** 验证 otter 状态更新为 dissolved */
      expect(repo._operations).toContain("dissolve");

      /** 验证 agent 被销毁 */
      expect(gateway._destroyedIds).toEqual(["otter-1"]);
    });

    it("无 active session 时跳过归档，仍然执行解散和销毁", async () => {
      const otter = makeActiveOtter();
      const repo = mockRepo(otter);
      const gateway = mockAgentGateway();
      const manageSession = mockManageSession(null); // 无 active session

      const useCase = new DissolveOtter(repo, gateway, manageSession);
      await useCase.execute("otter-1");

      /** 验证 session 归档被跳过 */
      expect(manageSession._archivedSessionIds).toHaveLength(0);

      /** 验证 otter 仍然被解散 */
      expect(repo._operations).toContain("dissolve");

      /** 验证 agent 仍然被销毁 */
      expect(gateway._destroyedIds).toEqual(["otter-1"]);
    });

    it("otter 不存在时抛出 DomainError（kind='not_found'）", async () => {
      const repo = mockRepo(null); // otter 不存在
      const gateway = mockAgentGateway();
      const manageSession = mockManageSession();

      const useCase = new DissolveOtter(repo, gateway, manageSession);
      const err = await useCase.execute("nonexistent").catch((e) => e);

      expect(err).toBeInstanceOf(DomainError);
      expect(err.kind).toBe("not_found");
    });

    it("otter 已解散时抛出 DomainError（kind='validation'）", async () => {
      const otter = makeActiveOtter({ status: "dissolved" });
      const repo = mockRepo(otter);
      const gateway = mockAgentGateway();
      const manageSession = mockManageSession();

      const useCase = new DissolveOtter(repo, gateway, manageSession);
      const err = await useCase.execute("otter-1").catch((e) => e);

      expect(err).toBeInstanceOf(DomainError);
      expect(err.kind).toBe("validation");
    });

    it("传入 summary 时归档使用该 summary", async () => {
      const otter = makeActiveOtter();
      const session = makeActiveSession();
      const repo = mockRepo(otter);
      const gateway = mockAgentGateway();
      const manageSession = mockManageSession(session);

      const useCase = new DissolveOtter(repo, gateway, manageSession);
      await useCase.execute("otter-1", "项目结束，解散水獭");

      /** 验证归档时使用了传入的 summary */
      expect(manageSession._archiveInputs[0].summary).toBe("项目结束，解散水獭");
    });

    it("P2 出站清算：dissolve 时调用 abortUnattemptedOutgoing，行数>0 时打日志", async () => {
      const otter = makeActiveOtter();
      const repo = mockRepo(otter);
      const gateway = mockAgentGateway();
      const manageSession = mockManageSession(null);
      const abortCalls: string[] = [];
      const logRecords: Array<{ message: string; context?: Record<string, unknown> }> = [];
      const logger = { warn: (m: string, c?: Record<string, unknown>) => logRecords.push({ message: m, context: c }) };

      const useCase = new DissolveOtter(repo, gateway, manageSession, {
        abortUnattemptedOutgoing: async (id) => { abortCalls.push(id); return 3; },
        logger,
      });
      await useCase.execute("otter-1");

      /** 副作用：清算被调用且日志带清算结果（不 toHaveBeenCalledWith，用状态断言） */
      expect(abortCalls).toEqual(["otter-1"]);
      const log = logRecords.find((r) => r.message.includes("出站清算"));
      expect(log?.context).toMatchObject({ otterId: "otter-1", aborted: 3 });
    });

    it("P2 出站清算失败不阻断解散主流程（仅日志）", async () => {
      const otter = makeActiveOtter();
      const repo = mockRepo(otter);
      const gateway = mockAgentGateway();
      const manageSession = mockManageSession(null);
      const logRecords: Array<{ message: string; context?: Record<string, unknown> }> = [];
      const logger = { warn: (m: string, c?: Record<string, unknown>) => logRecords.push({ message: m, context: c }) };

      const useCase = new DissolveOtter(repo, gateway, manageSession, {
        abortUnattemptedOutgoing: async () => { throw new Error("db locked"); },
        logger,
      });
      await expect(useCase.execute("otter-1")).resolves.toBeUndefined();

      /** 解散与 agent 销毁照常完成；失败仅留日志 */
      expect(repo._operations).toContain("dissolve");
      expect(gateway._destroyedIds).toEqual(["otter-1"]);
      const failLog = logRecords.find((r) => r.message.includes("失败"));
      expect(failLog?.context).toMatchObject({ otterId: "otter-1" });
    });

    it("P2 出站清算未注入时不调用（向后兼容）", async () => {
      const otter = makeActiveOtter();
      const repo = mockRepo(otter);
      const gateway = mockAgentGateway();
      const manageSession = mockManageSession(null);

      const useCase = new DissolveOtter(repo, gateway, manageSession);
      await expect(useCase.execute("otter-1")).resolves.toBeUndefined();
      expect(repo._operations).toContain("dissolve");
    });
  });
});
