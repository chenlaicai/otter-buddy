/**
 * 嵌入禁用开关测试（阶段 6a 部署底座：OTTER_EMBEDDING=off）。
 *
 * 禁用语义：available=false + embed 恒拒——检索侧 searchVec 的 catch 降级链
 * （FTS-only 回落）由既有测试覆盖，此处钉住禁用服务的契约面。
 */
import { describe, it, expect } from "vitest";
import { disabledEmbeddingServices } from "../../src/bootstrap/database";

describe("disabledEmbeddingServices（OTTER_EMBEDDING=off 契约面）", () => {
  it("live/backfill 均 available=false 且 embed 恒拒（检索降级 FTS-only 的触发条件）", async () => {
    const { liveService, backfillService } = disabledEmbeddingServices();
    for (const svc of [liveService, backfillService]) {
      expect(svc.available).toBe(false);
      await expect(svc.embed("anything")).rejects.toThrow(/OTTER_EMBEDDING=off/);
    }
  });

  it("dispose 幂等且不抛（退出路径无嵌入资源可清）", () => {
    const { dispose } = disabledEmbeddingServices();
    expect(() => { dispose(); dispose(); }).not.toThrow();
  });
});
