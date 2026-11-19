/**
 * 夜间审视治量状态管理 usecase 单测。
 *
 * 覆盖：claim 幂等撞键 / complete 写存档点清零 / recordFailure 同区间连败与异区间重置。
 */
import { describe, it, expect } from "vitest";
import { ManageConsolidationState } from "@usecases/memory/manage-consolidation-state";
import type { ConsolidationStateRepository } from "@usecases/memory/consolidation-state-repository";
import { DomainError } from "@entities/errors";
import {
  MAX_CONSECUTIVE_FAILURES,
  newConsolidationState,
  type ConsolidationState,
} from "@entities/memory/consolidation-state";

function makeRepo() {
  const rows = new Map<string, ConsolidationState>();
  const repo: ConsolidationStateRepository = {
    getByKey: async (key) => rows.get(key) ?? null,
    save: async (state) => { rows.set(state.reviewKey, state); },
  };
  return { repo, rows };
}

const KEY = "review:2026-11-18:night-review-task";

describe("ManageConsolidationState.claim（P2b1）", () => {
  it("首次 claim 建档：未 settle、无失败区间、零连败", async () => {
    const { repo } = makeRepo();
    const uc = new ManageConsolidationState(repo);
    const claim = await uc.claim(KEY);
    expect(claim.settled).toBe(false);
    expect(claim.resultJson).toBeNull();
    expect(claim.failingRange).toBeNull();
    expect(claim.failures).toBe(0);
  });

  it("撞键返回原结果（幂等）：resultJson 非空即 settle，不重跑", async () => {
    const { repo } = makeRepo();
    const uc = new ManageConsolidationState(repo);
    await uc.complete(KEY, '{"verified":["b1"]}');
    const claim = await uc.claim(KEY);
    expect(claim.settled).toBe(true);
    expect(claim.resultJson).toBe('{"verified":["b1"]}');
    expect(claim.failures).toBe(0);
  });

  it("已完成档之后失败区间为 null（complete 清零）", async () => {
    const { repo } = makeRepo();
    const uc = new ManageConsolidationState(repo);
    await uc.recordFailure(KEY, "2026-11-18T00:00:00Z", "2026-11-18T12:00:00Z");
    await uc.complete(KEY, "{}");
    const claim = await uc.claim(KEY);
    expect(claim.settled).toBe(true);
    expect(claim.failingRange).toBeNull();
    expect(claim.failures).toBe(0);
  });
});

describe("ManageConsolidationState.recordFailure（P2b1）", () => {
  it("同区间连败递增，达阈值应跳过", async () => {
    const { repo } = makeRepo();
    const uc = new ManageConsolidationState(repo);
    const range = { after: "2026-11-18T00:00:00Z", through: "2026-11-18T12:00:00Z" };
    for (let i = 1; i < MAX_CONSECUTIVE_FAILURES; i++) {
      const outcome = await uc.recordFailure(KEY, range.after, range.through);
      expect(outcome.failures).toBe(i);
      expect(outcome.shouldSkip).toBe(false);
    }
    const third = await uc.recordFailure(KEY, range.after, range.through);
    expect(third.failures).toBe(MAX_CONSECUTIVE_FAILURES);
    expect(third.shouldSkip).toBe(true);
  });

  it("同刻异精度仍判同区间（归一化后连败不误清）", async () => {
    const { repo } = makeRepo();
    const uc = new ManageConsolidationState(repo);
    await uc.recordFailure(KEY, "2026-11-18T00:00:00Z", "2026-11-18T12:00:00Z");
    const outcome = await uc.recordFailure(KEY, "2026-11-18T00:00:00.000Z", "2026-11-18T12:00:00.000Z");
    expect(outcome.failures).toBe(2);
  });

  it("异区间重置连败为 1（水位前移，旧连败不追新区间）", async () => {
    const { repo } = makeRepo();
    const uc = new ManageConsolidationState(repo);
    await uc.recordFailure(KEY, "2026-11-18T00:00:00Z", "2026-11-18T06:00:00Z");
    await uc.recordFailure(KEY, "2026-11-18T00:00:00Z", "2026-11-18T06:00:00Z");
    const outcome = await uc.recordFailure(KEY, "2026-11-18T12:00:00Z", "2026-11-18T23:00:00Z");
    expect(outcome.failures).toBe(1);
    expect(outcome.shouldSkip).toBe(false);
  });

  it("claim 能看到失败区间与连败计数（重跑只重做该区间）", async () => {
    const { repo } = makeRepo();
    const uc = new ManageConsolidationState(repo);
    await uc.recordFailure(KEY, "2026-11-18T00:00:00Z", "2026-11-18T06:00:00Z");
    const claim = await uc.claim(KEY);
    expect(claim.settled).toBe(false);
    expect(claim.failingRange).toEqual({ after: "2026-11-18T00:00:00.000Z", through: "2026-11-18T06:00:00.000Z" });
    expect(claim.failures).toBe(1);
  });
});

describe("newConsolidationState 与 repo 协作（P2b1）", () => {
  it("claim 建档后 repo 中可读回该行", async () => {
    const { repo, rows } = makeRepo();
    const uc = new ManageConsolidationState(repo);
    await uc.claim(KEY);
    const stored = rows.get(KEY);
    expect(stored).toBeDefined();
    expect(stored).toEqual(newConsolidationState(KEY, stored!.updatedAt));
  });
});

describe("ManageConsolidationState 防误用护栏（P2b1，审视 R2/R3/R5）", () => {
  it("非法幂等键拒绝（空 taskId / 非 YYYY-MM-DD）", async () => {
    const { repo } = makeRepo();
    const uc = new ManageConsolidationState(repo);
    await expect(uc.claim("review:bad-date:t")).rejects.toThrow(DomainError);
    await expect(uc.claim("review:2026-11-18:")).rejects.toThrow(DomainError);
    await expect(uc.complete("not-a-key", "{}")).rejects.toThrow(DomainError);
  });

  it("complete 空结果拒绝", async () => {
    const { repo } = makeRepo();
    const uc = new ManageConsolidationState(repo);
    await expect(uc.complete(KEY, "")).rejects.toThrow(DomainError);
  });

  it("complete 同内容重入幂等；异内容拒绝覆盖第一份变更集", async () => {
    const { repo } = makeRepo();
    const uc = new ManageConsolidationState(repo);
    await uc.complete(KEY, "{\"verified\":[\"b1\"]}");
    await uc.complete(KEY, "{\"verified\":[\"b1\"]}"); // 幂等重入不抛
    await expect(uc.complete(KEY, "{\"verified\":[\"b2\"]}")).rejects.toThrow(DomainError);
    const claim = await uc.claim(KEY);
    expect(claim.resultJson).toBe("{\"verified\":[\"b1\"]}");
  });

  it("已 settle 档拒绝迟到失败回报（不污染成功档）", async () => {
    const { repo } = makeRepo();
    const uc = new ManageConsolidationState(repo);
    await uc.complete(KEY, "{}");
    await expect(
      uc.recordFailure(KEY, "2026-11-18T00:00:00.000Z", "2026-11-18T12:00:00.000Z"),
    ).rejects.toThrow(DomainError);
    const claim = await uc.claim(KEY);
    expect(claim.settled).toBe(true);
    expect(claim.failingRange).toBeNull();
  });

  it("失败区间非法或倒挂拒绝（空串 / 非 ISO / after > through）", async () => {
    const { repo } = makeRepo();
    const uc = new ManageConsolidationState(repo);
    await expect(uc.recordFailure(KEY, "", "2026-11-18T12:00:00.000Z")).rejects.toThrow(DomainError);
    await expect(uc.recordFailure(KEY, "2026-11-18 00:00:00", "2026-11-18T12:00:00.000Z")).rejects.toThrow(DomainError);
    await expect(
      uc.recordFailure(KEY, "2026-11-18T12:00:00.000Z", "2026-11-18T00:00:00.000Z"),
    ).rejects.toThrow(DomainError);
  });
});