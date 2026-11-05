import { describe, expect, it } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createTestDb } from "../../helpers/db";
import { createAgentSessionStore } from "@frameworks/agent/agent-session-store";

describe("durable session generation ledger", () => {
  it("keeps the durable store path and model configuration independent of legacy JSONL", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "otter-durable-ledger-"));
    const db = createTestDb();
    const store = createAgentSessionStore(db);
    store.setWithFile("otter", "generation-1", path.join(dir, "otter.sqlite"));
    expect(store.getWithFile("otter")?.sessionFile).toBe(path.join(dir, "otter.sqlite"));
    store.setWithFile("otter", "generation-2", path.join(dir, "otter-next.sqlite"));
    expect(store.getWithFile("otter")?.piSessionId).toBe("generation-2");
    expect(store.getWithFile("otter")?.sessionFile).toBe(path.join(dir, "otter-next.sqlite"));
    db.close();
  });

  it("never treats a durable SQLite store as a legacy JSONL handoff", () => {
    const file = path.join(tmpdir(), "otter.sqlite");
    expect(file.endsWith(".jsonl")).toBe(false);
  });
});
