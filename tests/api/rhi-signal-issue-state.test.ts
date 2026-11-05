import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { createTestDb } from "../helpers/db";
import { RhiController } from "@interface-adapters/http/controllers/rhi-controller";
import { HealthSnapshotRepository } from "@usecases/health/health-snapshot-repository";
import type { RhiScanWorker } from "@usecases/health/rhi-scan-worker";
import { SignalRepository } from "@usecases/health/signal-repository";

function makeContext(signalId: number, issueNumber: number): Parameters<RhiController["triageSignal"]>[0] {
  return {
    req: {
      param: () => String(signalId),
      json: async () => ({ action: "bind_issue", issueNumber }),
    },
    json: (body: unknown, status = 200) => new Response(JSON.stringify(body), { status }),
  } as never;
}

describe("RHI API 目标 issue 状态", () => {
  let db: Database.Database;
  let repo: SignalRepository;
  let snapshotRepo: HealthSnapshotRepository;

  beforeEach(() => {
    db = createTestDb();
    repo = new SignalRepository(db);
    snapshotRepo = new HealthSnapshotRepository(db);
  });
  afterEach(() => { db.close(); });

  function makeController(checkIssueBinding: unknown) {
    return new RhiController(
      snapshotRepo,
      repo,
      {} as RhiScanWorker,
      console as never,
      checkIssueBinding as never,
    );
  }

  it("面板向 CLOSED issue 归口返回 422，信号保持未接单", async () => {
    const signal = repo.upsert({
      signalType: "bug_recurrence",
      severity: "critical",
      featureId: null,
      filePath: "src/invoker.ts",
      evidence: "目标已关单",
      suggestedAction: null,
    });
    const controller = makeController(async () => ({
      ok: false,
      reason: "目标 issue #1319 状态为 CLOSED，仅可归口到 OPEN issue",
    }));

    const response = await controller.triageSignal(makeContext(signal.id, 1319));

    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ error: expect.stringContaining("CLOSED") });
    expect(repo.findById(signal.id)).toMatchObject({ triage_status: null, issue_number: null });
  });

  it("面板向 OPEN issue 归口仍返回 200 并写库", async () => {
    const signal = repo.upsert({
      signalType: "bug_recurrence",
      severity: "critical",
      featureId: null,
      filePath: "src/invoker.ts",
      evidence: "目标仍开放",
      suggestedAction: null,
    });
    const controller = makeController(async () => ({ ok: true }));

    const response = await controller.triageSignal(makeContext(signal.id, 1760));

    expect(response.status).toBe(200);
    expect(repo.findById(signal.id)).toMatchObject({ triage_status: "triaged", issue_number: 1760 });
  });
});
