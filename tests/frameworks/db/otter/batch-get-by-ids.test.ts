/**
 * #446 批量查询行为测试（真 sqlite）。
 *
 * OtterConfigProvider.getConfigs / OtterRepository.getByIds 的行为契约：
 * 一次调用返回 Map、未配置/不存在的 id 缺席、空数组返回空 Map、重复 id 去重。
 * 用例断言可观察返回值，不断言内部 SQL 细节。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { SqliteOtterRepository } from "@frameworks/db/otter/sqlite-otter-repository";
import { SqliteOtterConfigProvider } from "@frameworks/db/otter/sqlite-otter-config-provider";
import type { Otter } from "@entities/otter/otter";
import { createTestDb } from "../../../helpers/db";

function otterFixture(id: string, name: string): Otter {
  return {
    id, name, type: "small", status: "active",
    role: null, parentOtterId: null,
    createdAt: "2026-01-01T00:00:00Z", dissolvedAt: null,
  };
}

describe("#446 批量查询（真 sqlite）", () => {
  let db: Database.Database;
  let otterRepo: SqliteOtterRepository;
  let configProvider: SqliteOtterConfigProvider;

  beforeEach(() => {
    db = createTestDb();
    otterRepo = new SqliteOtterRepository(db);
    configProvider = new SqliteOtterConfigProvider(db);
    otterRepo.createOtter(otterFixture("otter-1", "小獭A"));
    otterRepo.createOtter(otterFixture("otter-2", "小獭B"));
    configProvider.setConfig("otter-1", { otterType: "small", modelAlias: "mimo" });
    configProvider.setConfig("otter-2", { otterType: "small" });
  });

  afterEach(() => {
    db.close();
  });

  describe("OtterConfigProvider.getConfigs", () => {
    it("一次返回已配置的 otter 映射，未配置的 id 缺席", () => {
      const configs = configProvider.getConfigs(["otter-1", "otter-2", "otter-missing"]);

      expect(configs.size).toBe(2);
      expect(configs.get("otter-1")?.modelAlias).toBe("mimo");
      expect(configs.get("otter-2")?.modelAlias).toBeUndefined();
      expect(configs.has("otter-missing")).toBe(false);
    });

    it("空数组返回空 Map", () => {
      expect(configProvider.getConfigs([]).size).toBe(0);
    });

    it("重复 id 去重后仍正确返回", () => {
      const configs = configProvider.getConfigs(["otter-1", "otter-1", "otter-2"]);

      expect(configs.size).toBe(2);
      expect(configs.get("otter-1")?.modelAlias).toBe("mimo");
    });

    it("与 getConfig 对同一 otter 返回一致的字段", () => {
      const single = configProvider.getConfig("otter-1");
      const batch = configProvider.getConfigs(["otter-1"]);

      expect(batch.get("otter-1")).toEqual(single);
    });
  });

  describe("OtterRepository.getByIds", () => {
    it("一次返回存在的 otter 映射，不存在的 id 缺席", async () => {
      const otters = await otterRepo.getByIds(["otter-1", "otter-2", "otter-missing"]);

      expect(otters.size).toBe(2);
      expect(otters.get("otter-1")?.name).toBe("小獭A");
      expect(otters.get("otter-2")?.name).toBe("小獭B");
      expect(otters.has("otter-missing")).toBe(false);
    });

    it("空数组返回空 Map", async () => {
      expect((await otterRepo.getByIds([])).size).toBe(0);
    });

    it("与 getById 对同一 otter 返回一致的字段", async () => {
      const single = await otterRepo.getById("otter-1");
      const batch = await otterRepo.getByIds(["otter-1"]);

      expect(batch.get("otter-1")).toEqual(single);
    });
  });
});
