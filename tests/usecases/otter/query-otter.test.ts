import { describe, it, expect, vi } from "vitest";
import { QueryOtter } from "@usecases/otter/query-otter";
import type { Otter } from "@entities/otter/otter";
import type { OtterRepository } from "@usecases/otter/otter-repository";

/** 创建 mock repo，可配置返回值 */
function mockRepo(returnValue: Otter | null = null) {
  return {
    getById: vi.fn(async () => returnValue),
    createOtter: vi.fn(async () => {}),
    dissolve: vi.fn(async () => {}),
    deleteOtter: vi.fn(async () => {}),
  } as unknown as OtterRepository;
}

const TEST_OTTER: Otter = {
  id: "otter-1",
  name: "测试水獭",
  type: "big",
  status: "active",
  role: null,
  parentOtterId: null,
  createdAt: "2026-07-20T00:00:00Z",
  dissolvedAt: null,
};

describe("QueryOtter", () => {
  describe("getById()", () => {
    it("从 repo 返回 otter", async () => {
      const repo = mockRepo(TEST_OTTER);
      const useCase = new QueryOtter(repo);

      const result = await useCase.getById("otter-1");

      expect(result).toEqual(TEST_OTTER);
      expect(result?.id).toBe("otter-1");
      expect(result?.name).toBe("测试水獭");
    });

    it("otter 不存在时返回 null", async () => {
      const repo = mockRepo(null);
      const useCase = new QueryOtter(repo);

      const result = await useCase.getById("nonexistent");

      expect(result).toBeNull();
    });
  });
});
