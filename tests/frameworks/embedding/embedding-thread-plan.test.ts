import { describe, expect, it } from "vitest";
import { deriveIntraOpThreads } from "../../../src/frameworks/embedding/embedding-thread-plan";

describe("F20261110embrc intra-op 推导", () => {
  it("live/query 固定 2，backfill 按物理核一半推导并受三 lane 总预算约束", () => {
    expect(deriveIntraOpThreads("live", 12)).toBe(2);
    expect(deriveIntraOpThreads("query", 12)).toBe(2);
    expect(deriveIntraOpThreads("backfill", 12)).toBe(6);
    expect(deriveIntraOpThreads("backfill", 8)).toBe(2);
    expect(deriveIntraOpThreads("backfill", 32)).toBe(8);
  });

  it("显式逃生口优先于机器推导", () => {
    expect(deriveIntraOpThreads("live", 12, "5")).toBe(5);
    expect(deriveIntraOpThreads("backfill", 12, "3")).toBe(3);
  });
});
