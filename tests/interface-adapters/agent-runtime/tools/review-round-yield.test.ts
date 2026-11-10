import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { createTestDb } from "../../../helpers/db";
import { createTestLogger } from "../../../helpers/logger";
import { initRepositories } from "../../../../src/bootstrap/repositories";
import { SendEntry } from "@usecases/conversation/send-entry";
import { SqliteWorkLedgerRepository } from "@frameworks/db/health/sqlite-work-ledger-repository";
import { WorkLedgerBinder } from "@usecases/health/work-ledger-binder";
import { createTools } from "@interface-adapters/agent-runtime/tools/tool-factory";
import { runWithTrace } from "@usecases/ports/trace-context";
import type { ToolContext } from "@usecases/ports/agent-tools";
import type { OtterToolClient } from "@usecases/ports/otter-tool-client";
import { buildOtterToolClient } from "../../../../src/bootstrap/clients";

describe("F20261110ryrev：yield 自动采集检视轮次", () => {
  let db: Database.Database;
  let sendEntry: SendEntry;
  let binder: WorkLedgerBinder;
  let ledgerRepo: SqliteWorkLedgerRepository;
  let workId: string;

  beforeEach(async () => {
    db = createTestDb();
    const logger = createTestLogger();
    const repos = initRepositories(db, logger);
    const now = new Date().toISOString();
    db.prepare("INSERT INTO otters (id, name, type, status, created_at) VALUES ('big', '大獭', 'big', 'active', ?)").run(now);
    db.prepare("INSERT INTO otters (id, name, type, status, created_at) VALUES ('reviewer', '检视獭', 'small', 'active', ?)").run(now);
    db.prepare("INSERT INTO conversations (id, title, status, created_at, updated_at) VALUES ('conv', '轮次采集', 'active', ?, ?)").run(now, now);
    sendEntry = new SendEntry(repos.entry, repos.invoke, repos.otter, repos.conversation, { logger });
    ledgerRepo = new SqliteWorkLedgerRepository(db);
    binder = new WorkLedgerBinder(ledgerRepo, logger);
    workId = (await binder.start({ conversationId: "conv", otterId: "big", traceId: "trace-work", title: "PR 工作" })).id;
  });

  afterEach(() => db.close());

  async function runYield(input: {
    otterId: string;
    invokeId: string;
    to: string[];
    traceId?: string;
    assignmentRole?: "reviewer";
  }) {
    const client = {
      conversation: {
        participant: { getActive: async () => [
          { otterId: "big", otterName: "大獭", status: "active" },
          { otterId: "reviewer", otterName: "检视獭", status: "active" },
        ] },
        entry: { createYieldEntry: (args: Parameters<SendEntry["createYieldEntry"]>[0]) => sendEntry.createYieldEntry(args) },
      },
      otter: { getById: async (id: string) => ({ id, name: id, type: id === "big" ? "big" : "small", color: null }) },
      dispatch: { markDispatched: async () => {} },
    } as unknown as OtterToolClient;
    const ctx = {
      client, otterId: input.otterId, conversationId: "conv", currentInvokeId: input.invokeId,
      currentMessageId: "msg", lastSpeakMessageId: "speak", workLedgerBinder: binder,
    } as ToolContext;
    const tool = createTools(ctx).find(t => t.name === "yield")!;
    const result = await runWithTrace({ traceId: input.traceId ?? "trace-work" }, () => tool.execute("call", {
      to: input.to.map(id => id === "big" ? "大獭" : "检视獭"),
      ...(input.assignmentRole ? { assignmentRole: input.assignmentRole } : {}),
    }));
    if (!result.terminate) throw new Error(JSON.stringify(result));
    return result;
  }

  async function invoke(otterId: string, triggerEntryId?: string, traceId = "trace-work") {
    return (await sendEntry.createInvoke({
      conversationId: "conv", otterId, triggerEntryId, metadata: { traceId },
    })).invoke;
  }

  function latestYieldId(): string {
    const row = db.prepare("SELECT id FROM entries WHERE entry_type='yield' ORDER BY sequence_num DESC LIMIT 1").get() as { id: string } | undefined;
    if (!row) throw new Error("yield entry 不存在");
    return row.id;
  }

  it("yield 派工角色随触发 entry 进入 invoke；每次检视完成交回自动计一轮", async () => {
    const big1 = await invoke("big");
    await runYield({ otterId: "big", invokeId: big1.id, to: ["reviewer"], assignmentRole: "reviewer" });
    const reviewer1 = await invoke("reviewer", latestYieldId());
    expect(reviewer1.metadata).toMatchObject({ traceId: "trace-work", assignmentRole: "reviewer" });

    await runYield({ otterId: "reviewer", invokeId: reviewer1.id, to: ["big"] });
    let work = await ledgerRepo.getWorkById(workId);
    expect(work!.reviewRounds).toHaveLength(1);
    expect(work!.reviewRounds[0]).toMatchObject({
      roundNo: 1, reviewerOtterId: "reviewer", state: "completed", completedInvokeId: reviewer1.id,
    });

    const big2 = await invoke("big");
    await runYield({ otterId: "big", invokeId: big2.id, to: ["reviewer"], assignmentRole: "reviewer" });
    const reviewer2 = await invoke("reviewer", latestYieldId());
    await runYield({ otterId: "reviewer", invokeId: reviewer2.id, to: ["big"] });
    work = await ledgerRepo.getWorkById(workId);
    expect(work!.reviewRounds).toHaveLength(2);
    expect(work!.reviewRounds[1]).toMatchObject({ roundNo: 2, completedInvokeId: reviewer2.id });
  });

  it("生产 OtterToolClient 适配器透传派工角色并返回 invoke metadata", async () => {
    const client = buildOtterToolClient({ sendEntry } as never);
    const big = await invoke("big");
    const dispatched = await client.conversation.entry.createYieldEntry({
      conversationId: "conv", invokeId: big.id, otterId: "big", yieldTargets: ["reviewer"], assignmentRole: "reviewer",
    });
    const yieldRow = await sendEntry.getEntryById(dispatched.yieldEntry.id);
    expect(yieldRow!.metadata).toMatchObject({ assignmentRole: "reviewer" });

    const review = await invoke("reviewer", dispatched.yieldEntry.id);
    const completed = await client.conversation.entry.createYieldEntry({
      conversationId: "conv", invokeId: review.id, otterId: "reviewer", yieldTargets: ["big"],
    });
    expect(completed.invoke.metadata).toMatchObject({ assignmentRole: "reviewer", traceId: "trace-work" });
  });

  it("自交棒、普通派工与重复 invoke 不计；无工作归属不阻断交棒", async () => {
    const big = await invoke("big");
    await runYield({ otterId: "big", invokeId: big.id, to: ["reviewer"] });
    const ordinary = await invoke("reviewer", latestYieldId());
    expect(ordinary.metadata).not.toHaveProperty("assignmentRole");
    await runYield({ otterId: "reviewer", invokeId: ordinary.id, to: ["big"] });
    expect((await ledgerRepo.getWorkById(workId))!.reviewRounds).toHaveLength(0);

    await runYield({ otterId: "big", invokeId: (await invoke("big")).id, to: ["reviewer"], assignmentRole: "reviewer" });
    const review = await invoke("reviewer", latestYieldId());
    await runYield({ otterId: "reviewer", invokeId: review.id, to: ["reviewer"] });
    expect((await ledgerRepo.getWorkById(workId))!.reviewRounds).toHaveLength(0);

    await binder.recordCompletedReviewRound({ traceId: "trace-work", reviewerOtterId: "reviewer", invokeId: review.id });
    await binder.recordCompletedReviewRound({ traceId: "trace-work", reviewerOtterId: "reviewer", invokeId: review.id });
    expect((await ledgerRepo.getWorkById(workId))!.reviewRounds).toHaveLength(1);

    const unboundBig = await invoke("big", undefined, "trace-unbound");
    await runYield({ otterId: "big", invokeId: unboundBig.id, to: ["reviewer"], traceId: "trace-unbound", assignmentRole: "reviewer" });
    const unbound = await invoke("reviewer", latestYieldId(), "trace-unbound");
    const result = await runYield({ otterId: "reviewer", invokeId: unbound.id, to: ["big"], traceId: "trace-unbound" });
    expect(result.terminate).toBe(true);
    expect((await ledgerRepo.getWorkById(workId))!.reviewRounds).toHaveLength(1);
  });
});
