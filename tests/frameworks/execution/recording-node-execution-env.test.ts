import { describe, expect, it, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, symlinkSync, chmodSync, statSync, readdirSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { RecordingNodeExecutionEnv } from "@frameworks/execution/recording-node-execution-env";
import { SqliteActionLedger, sha256 } from "@frameworks/execution/ledger/sqlite-action-ledger";
import { otterInvokeStorage } from "@frameworks/agent/model-runtime-registry";

/** F20261116actlg PR-A：记录 env（副作用入账 + 原子写 + 归属传播 + 去重协议）。 */

let dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "recording-env-test-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

function makeEnv(cwd: string, ledger: SqliteActionLedger | null) {
  const warns: string[] = [];
  const env = new RecordingNodeExecutionEnv({ cwd }, ledger, message => warns.push(message));
  return { env, ledger, warns };
}

describe("原子写", () => {
  it("写入成功：内容正确、无临时文件残留、台账 succeeded + hash", async () => {
    const dir = tempDir();
    const { env, ledger } = makeEnv(dir, new SqliteActionLedger(path.join(dir, "actions.db")));
    const target = path.join(dir, "a.md");
    const result = await env.writeFile(target, "hello atomic", BACKGROUND_CONTEXT);
    expect(result.ok).toBe(true);
    const { readFileSync } = await import("node:fs");
    expect(readFileSync(target, "utf8")).toBe("hello atomic");
    expect(readdirSync(dir).filter(n => n.startsWith(".otter-tmp-"))).toEqual([]);

    const rows = await allRows(ledger!);
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe("file.write");
    expect(rows[0].status).toBe("succeeded");
    expect(rows[0].contentHash).toBe(sha256("hello atomic"));
    expect(rows[0].target).toBe(target);
    ledger!.close();
  });

  it("覆盖已有文件：保留原 mode", async () => {
    const dir = tempDir();
    const { env } = makeEnv(dir, null);
    const target = path.join(dir, "keep-mode.txt");
    writeFileSync(target, "old");
    chmodSync(target, 0o600);
    const result = await env.writeFile(target, "new", BACKGROUND_CONTEXT);
    expect(result.ok).toBe(true);
    expect(statSync(target).mode & 0o777).toBe(0o600);
  });

  it("symlink 目标：跟随真实文件，不替换链接本身", async () => {
    const dir = tempDir();
    const { env } = makeEnv(dir, null);
    const real = path.join(dir, "real.txt");
    const link = path.join(dir, "link.txt");
    writeFileSync(real, "real-content");
    symlinkSync(real, link);
    const result = await env.writeFile(link, "via-link", BACKGROUND_CONTEXT);
    expect(result.ok).toBe(true);
    const { readFileSync, lstatSync } = await import("node:fs");
    expect(readFileSync(real, "utf8")).toBe("via-link");
    expect(lstatSync(link).isSymbolicLink()).toBe(true); // 链接未被替换成普通文件
  });

  it("写失败（目标是目录）：返回 err、无临时残留、台账 failed", async () => {
    const dir = tempDir();
    const { env, ledger } = makeEnv(dir, new SqliteActionLedger(path.join(dir, "actions.db")));
    const target = path.join(dir, "i-am-dir");
    mkdirSync(target);
    const result = await env.writeFile(target, "x", BACKGROUND_CONTEXT);
    expect(result.ok).toBe(false);
    expect(readdirSync(dir).filter(n => n.startsWith(".otter-tmp-"))).toEqual([]);
    const rows = await allRows(ledger!);
    expect(rows[0].status).toBe("failed");
    ledger!.close();
  });
});

describe("副作用入账（append / exec）", () => {
  it("appendFile → succeeded，contentBytes 供尾部 hash 核对", async () => {
    const dir = tempDir();
    const { env, ledger } = makeEnv(dir, new SqliteActionLedger(path.join(dir, "actions.db")));
    const target = path.join(dir, "c.log");
    writeFileSync(target, "head-");
    const result = await env.appendFile(target, "tail", BACKGROUND_CONTEXT);
    expect(result.ok).toBe(true);
    const rows = await allRows(ledger!);
    expect(rows[0].kind).toBe("file.append");
    expect(rows[0].status).toBe("succeeded");
    expect(rows[0].contentBytes).toBe(4);
    ledger!.close();
  });

  it("exec 成功 → succeeded + exitCode（非零退出码也是「动作完成」）", async () => {
    const dir = tempDir();
    const { env, ledger } = makeEnv(dir, new SqliteActionLedger(path.join(dir, "actions.db")));
    const okRun = await env.exec("printf ok", undefined, BACKGROUND_CONTEXT);
    expect(okRun.ok && okRun.value.exitCode).toBe(0);
    const failRun = await env.exec("exit 3", undefined, BACKGROUND_CONTEXT);
    expect(failRun.ok && failRun.value.exitCode).toBe(3);
    const rows = await allRows(ledger!);
    expect(rows).toHaveLength(2);
    expect(rows.every(r => r.kind === "shell.exec" && r.status === "succeeded")).toBe(true);
    expect(JSON.parse(rows[1].resultSummary!)).toMatchObject({ exitCode: 3 });
    ledger!.close();
  });

  it("exec 从未跑起来（命令不存在且非 shell 串）→ failed", async () => {
    const dir = tempDir();
    const { env, ledger } = makeEnv(dir, new SqliteActionLedger(path.join(dir, "actions.db")));
    const result = await env.exec(["/nonexistent-binary-xyz"], undefined, BACKGROUND_CONTEXT);
    expect(result.ok).toBe(false);
    const rows = await allRows(ledger!);
    expect(rows[0].status).toBe("failed");
    ledger!.close();
  });
});

describe("归属传播（ALS）与去重协议", () => {
  it("ALS 内执行 → invokeId/toolCallId 归属 + actionId 按 toolCallId 铸造", async () => {
    const dir = tempDir();
    const { env, ledger } = makeEnv(dir, new SqliteActionLedger(path.join(dir, "actions.db")));
    await otterInvokeStorage.run({ otterId: "o1", currentInvokeId: "inv-77", currentToolCallId: "call-9", otterPromptConfig: "", identityPrefix: "" } as never, async () => {
      await env.writeFile(path.join(dir, "attrib.md"), "content", BACKGROUND_CONTEXT);
      await env.exec("true", undefined, BACKGROUND_CONTEXT);
    });
    const rows = await allRows(ledger!);
    expect(rows).toHaveLength(2);
    expect(rows.every(r => r.invokeId === "inv-77" && r.toolCallId === "call-9" && r.source === "sdk-env")).toBe(true);
    expect(rows[0].actionId).toBe("call-9:1");
    expect(rows[1].actionId).toBe("call-9:2");
    ledger!.close();
  });

  it("ALS 外执行 → source=internal、invoke/toolCall 归属为空", async () => {
    const dir = tempDir();
    const { env, ledger } = makeEnv(dir, new SqliteActionLedger(path.join(dir, "actions.db")));
    await env.writeFile(path.join(dir, "internal.md"), "x", BACKGROUND_CONTEXT);
    const rows = await allRows(ledger!);
    expect(rows[0].source).toBe("internal");
    expect(rows[0].invokeId).toBeNull();
    expect(rows[0].actionId).toContain("internal:");
    ledger!.close();
  });

  it("同 actionId 已 succeeded → 去重：不执行、返回 ok、文件未被改动", async () => {
    const dir = tempDir();
    const ledger = new SqliteActionLedger(path.join(dir, "actions.db"));
    const target = path.join(dir, "dedup.md");
    // 预置：另一 boot 中该动作已成功（hash 对应当前磁盘内容）
    writeFileSync(target, "already-written");
    await ledger.start({ actionId: "call-z:1", source: "sdk-env", kind: "file.write", target, contentHash: sha256("already-written"), contentBytes: 15 });
    await ledger.settle("call-z:1", { status: "succeeded" });

    const { env } = makeEnv(dir, ledger);
    await otterInvokeStorage.run({ otterId: "o1", currentInvokeId: "inv-1", currentToolCallId: "call-z", otterPromptConfig: "", identityPrefix: "" } as never, async () => {
      const result = await env.writeFile(target, "SHOULD-NOT-WRITE", BACKGROUND_CONTEXT);
      expect(result.ok).toBe(true); // 去重返回已记录成功
    });
    const { readFileSync } = await import("node:fs");
    expect(readFileSync(target, "utf8")).toBe("already-written"); // 未重复执行
    ledger.close();
  });

  it("exec 去重：返回已记录的 exitCode", async () => {
    const dir = tempDir();
    const ledger = new SqliteActionLedger(path.join(dir, "actions.db"));
    await ledger.start({ actionId: "call-e:1", source: "sdk-env", kind: "shell.exec", target: "printf done" });
    await ledger.settle("call-e:1", { status: "succeeded", resultSummary: { exitCode: 0 } });
    const { env } = makeEnv(dir, ledger);
    await otterInvokeStorage.run({ otterId: "o1", currentInvokeId: "inv-1", currentToolCallId: "call-e", otterPromptConfig: "", identityPrefix: "" } as never, async () => {
      const result = await env.exec("printf done", undefined, BACKGROUND_CONTEXT);
      expect(result.ok && result.value.exitCode).toBe(0);
    });
    ledger.close();
  });
});

describe("台账失败不打断真实动作", () => {
  it("ledger 抛错 → 文件照常写入", async () => {
    const dir = tempDir();
    const broken = {
      start: async () => { throw new Error("ledger broken"); },
      settle: async () => { throw new Error("ledger broken"); },
      getByActionId: async () => null,
      listByInvoke: async () => [],
      sweepStaleBoot: async () => ({ upgradedToSucceeded: 0, markedInterrupted: 0, markedUnknown: 0, pruned: 0 }),
      close: () => undefined,
    } as never as SqliteActionLedger;
    const { env, warns } = makeEnv(dir, broken);
    const target = path.join(dir, "still-works.md");
    const result = await env.writeFile(target, "content", BACKGROUND_CONTEXT);
    expect(result.ok).toBe(true);
    const { readFileSync } = await import("node:fs");
    expect(readFileSync(target, "utf8")).toBe("content");
    expect(warns.length).toBeGreaterThan(0);
  });
});

/** 取全部行（listByInvoke 不过滤 null invoke 的辅助直查） */
async function allRows(ledger: SqliteActionLedger) {
  const Database = (await import("better-sqlite3")).default;
  // 经由公开接口拿不到全量（invoke 过滤），测试直开只读连接
  const db = new Database(ledger.file, { readonly: true });
  const rows = db.prepare("SELECT * FROM execution_actions ORDER BY started_at ASC, action_id ASC").all() as Array<{ action_id: string; kind: string; status: string; invoke_id: string | null; tool_call_id: string | null; source: string; content_hash: string | null; content_bytes: number | null; target: string | null; result_summary: string | null }>;
  db.close();
  return rows.map(r => ({
    actionId: r.action_id, kind: r.kind, status: r.status, invokeId: r.invoke_id,
    toolCallId: r.tool_call_id, source: r.source, contentHash: r.content_hash,
    contentBytes: r.content_bytes, target: r.target, resultSummary: r.result_summary,
  }));
}
