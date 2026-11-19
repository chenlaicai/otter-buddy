import { describe, expect, it, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { LocalExecutionMachine } from "@frameworks/execution/local-execution-machine";
import { NodeWorkspaceGateway } from "@frameworks/file-system/node-workspace-gateway";
import { SqliteActionLedger, sha256 } from "@frameworks/execution/ledger/sqlite-action-ledger";
import { otterInvokeStorage } from "@frameworks/agent/model-runtime-registry";

/** LocalExecutionMachine 台账接线（workspace 副作用入账 + 去重协议）。 */

let dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "local-machine-ledger-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

function makeMachine() {
  const dir = tempDir();
  const ledger = new SqliteActionLedger(path.join(dir, "actions.db"));
  const machine = new LocalExecutionMachine(new NodeWorkspaceGateway(dir), ledger);
  return { dir, ledger, machine, gatewayDir: dir };
}

describe("workspace 副作用入账", () => {
  it("workspace.write：succeeded + contentHash + conversationId 归属；ALS 内再带 invokeId", async () => {
    const { dir, ledger, machine } = makeMachine();
    await otterInvokeStorage.run({ otterId: "o1", currentInvokeId: "inv-w", currentToolCallId: "call-w", otterPromptConfig: "", identityPrefix: "" } as never, async () => {
      await machine.run({ type: "workspace.write", input: { conversationId: "conv-1", relativePath: "notes/a.md", content: "机器写入" } });
    });
    const rows = await ledger.listByInvoke("inv-w");
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe("workspace.write");
    expect(rows[0].status).toBe("succeeded");
    expect(rows[0].conversationId).toBe("conv-1");
    expect(rows[0].contentHash).toBe(sha256(Buffer.from("机器写入", "utf-8")));
    // 文件真实落盘（gateway 原子写）
    const { readFileSync } = await import("node:fs");
    expect(readFileSync(path.join(dir, "workspaces", "conv-1", "notes", "a.md"), "utf8")).toBe("机器写入");
    ledger.close();
  });

  it("workspace.delete：succeeded + deleted 摘要；非变更动作（read/list/exists/path）不入账", async () => {
    const { ledger, machine } = makeMachine();
    await machine.run({ type: "workspace.write", input: { conversationId: "c", relativePath: "x.txt", content: "1" } });
    const del = await machine.run({ type: "workspace.delete", input: { conversationId: "c", relativePath: "x.txt" } });
    expect(del.deleted).toBe("file");
    await machine.run({ type: "workspace.exists", input: { conversationId: "c" } });
    await machine.run({ type: "workspace.list", input: { conversationId: "c" } });
    await machine.run({ type: "workspace.read", input: { conversationId: "c", relativePath: "y.txt" } }).catch(() => undefined);

    const all = await allRows(ledger);
    expect(all.map(r => r.kind)).toEqual(["workspace.write", "workspace.delete"]);
    expect(all[1].status).toBe("succeeded");
    expect(JSON.parse(all[1].resultSummary!)).toMatchObject({ deleted: "file" });
    ledger.close();
  });

  it("写入失败 → failed + 错误上抛（不吞）", async () => {
    const { ledger, machine } = makeMachine();
    // 超限内容（>1MB）触发 gateway 拒绝
    await expect(machine.run({ type: "workspace.write", input: { conversationId: "c", relativePath: "big.txt", content: "x".repeat(2 * 1024 * 1024) } }))
      .rejects.toThrow(/too large/i);
    const all = await allRows(ledger);
    expect(all).toHaveLength(1);
    expect(all[0].status).toBe("failed");
    ledger.close();
  });
});

describe("去重协议（ActionRunner options.actionId）", () => {
  it("同 actionId 已 succeeded → 不再执行，返回已记录结果", async () => {
    const { dir, ledger, machine } = makeMachine();
    // 首次：显式 actionId 写入
    await machine.run(
      { type: "workspace.write", input: { conversationId: "c", relativePath: "d.txt", content: "first" } },
      undefined,
      { actionId: "act-dedup" },
    );
    // 预置 succeeded
    await ledger.settle("act-dedup", { status: "succeeded" });
    // 二次：同 actionId、不同内容 → 去重，文件内容不变
    await machine.run(
      { type: "workspace.write", input: { conversationId: "c", relativePath: "d.txt", content: "SECOND-SHOULD-NOT-WRITE" } },
      undefined,
      { actionId: "act-dedup" },
    );
    const { readFileSync } = await import("node:fs");
    expect(readFileSync(path.join(dir, "workspaces", "c", "d.txt"), "utf8")).toBe("first");
    ledger.close();
  });

  it("workspace.delete 去重 → 返回已记录的 deleted 类型", async () => {
    const { ledger, machine } = makeMachine();
    await machine.run({ type: "workspace.write", input: { conversationId: "c", relativePath: "z.txt", content: "1" } });
    await machine.run({ type: "workspace.delete", input: { conversationId: "c", relativePath: "z.txt" } }, undefined, { actionId: "act-del" });
    await ledger.settle("act-del", { status: "succeeded" }, new Date().toISOString());
    // 直接预置 summary 再验证重建
    const Database = (await import("better-sqlite3")).default;
    const db = new Database(ledger.file);
    db.prepare("UPDATE execution_actions SET result_summary = ? WHERE action_id = ?").run(JSON.stringify({ deleted: "directory" }), "act-del");
    db.close();
    const replay = await machine.run({ type: "workspace.delete", input: { conversationId: "c", relativePath: "z.txt" } }, undefined, { actionId: "act-del" });
    expect(replay.deleted).toBe("directory");
    ledger.close();
  });
});

describe("ledger=null 降级", () => {
  it("无台账时 workspace 动作照常执行", async () => {
    const dir = tempDir();
    const machine = new LocalExecutionMachine(new NodeWorkspaceGateway(dir), null);
    await machine.run({ type: "workspace.write", input: { conversationId: "c", relativePath: "n.txt", content: "no-ledger" } });
    const { readFileSync } = await import("node:fs");
    expect(readFileSync(path.join(dir, "workspaces", "c", "n.txt"), "utf8")).toBe("no-ledger");
  });
});

async function allRows(ledger: SqliteActionLedger) {
  const Database = (await import("better-sqlite3")).default;
  const db = new Database(ledger.file, { readonly: true });
  const rows = db.prepare("SELECT * FROM execution_actions ORDER BY started_at ASC, action_id ASC").all() as Array<{ action_id: string; kind: string; status: string; result_summary: string | null }>;
  db.close();
  return rows.map(r => ({ actionId: r.action_id, kind: r.kind, status: r.status, resultSummary: r.result_summary }));
}
