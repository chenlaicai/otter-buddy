import { describe, expect, it, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, symlinkSync, chmodSync, statSync, readdirSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { RecordingNodeExecutionEnv } from "@frameworks/execution/recording-node-execution-env";
import { SqliteActionLedger, sha256 } from "@frameworks/execution/ledger/sqlite-action-ledger";
import { otterInvokeStorage } from "@frameworks/agent/model-runtime-registry";

/** PR-A：记录 env（副作用入账 + 原子写 + 归属传播 + 去重协议）。 */

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

function makeEnv(cwd: string, ledger: SqliteActionLedger | null, bootEpoch?: number) {
  const warns: string[] = [];
  const env = new RecordingNodeExecutionEnv({ cwd }, ledger, message => warns.push(message), bootEpoch);
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
    expect(rows[0].actionId).toBe("call-9:0:1");
    expect(rows[1].actionId).toBe("call-9:0:2");
    ledger!.close();
  });

  it("ALS 外执行 → source=internal、归属为空；多实例同库不碰撞（RESIDUAL-1）", async () => {
    const dir = tempDir();
    const ledger = new SqliteActionLedger(path.join(dir, "actions.db"));
    const { env: envA } = makeEnv(dir, ledger);
    const { env: envB } = makeEnv(dir, ledger);
    await envA.writeFile(path.join(dir, "internal-a.md"), "x", BACKGROUND_CONTEXT);
    await envB.writeFile(path.join(dir, "internal-b.md"), "y", BACKGROUND_CONTEXT); // 同库另一实例首动作：id 含实例标签，不碰撞
    const rows = await allRows(ledger);
    expect(rows).toHaveLength(2);
    expect(rows.every(r => r.source === "internal" && r.invokeId === null)).toBe(true);
    expect(new Set(rows.map(r => r.actionId)).size).toBe(2); // 两实例 id 互异
    expect(rows.every(r => r.status === "succeeded")).toBe(true); // 都真实执行，未被错误去重
    ledger.close();
  });

  it("同 actionId 已 succeeded → 去重：不执行、返回 ok、文件未被改动", async () => {
    const dir = tempDir();
    const ledger = new SqliteActionLedger(path.join(dir, "actions.db"));
    const target = path.join(dir, "dedup.md");
    // 预置：另一 boot 中该动作已成功（hash 对应当前磁盘内容）；env 未传 epoch → 0，与预置 id 对齐
    writeFileSync(target, "already-written");
    await ledger.start({ actionId: "call-z:0:1", source: "sdk-env", kind: "file.write", target, contentHash: sha256("already-written"), contentBytes: 15 });
    await ledger.settle("call-z:0:1", { status: "succeeded" });

    const { env } = makeEnv(dir, ledger);
    await otterInvokeStorage.run({ otterId: "o1", currentInvokeId: "inv-1", currentToolCallId: "call-z", otterPromptConfig: "", identityPrefix: "" } as never, async () => {
      const result = await env.writeFile(target, "SHOULD-NOT-WRITE", BACKGROUND_CONTEXT);
      expect(result.ok).toBe(true); // 去重返回已记录成功
    });
    const { readFileSync } = await import("node:fs");
    expect(readFileSync(target, "utf8")).toBe("already-written"); // 未重复执行
    ledger.close();
  });

  it("exec 去重：返回已记录的 exitCode 与 spillPath（结果位置）", async () => {
    const dir = tempDir();
    const ledger = new SqliteActionLedger(path.join(dir, "actions.db"));
    await ledger.start({ actionId: "call-e:0:1", source: "sdk-env", kind: "shell.exec", target: "printf done" });
    await ledger.settle("call-e:0:1", { status: "succeeded", resultSummary: { exitCode: 0, spillPath: "/tmp/spill-xyz" } });
    const { env } = makeEnv(dir, ledger);
    await otterInvokeStorage.run({ otterId: "o1", currentInvokeId: "inv-1", currentToolCallId: "call-e", otterPromptConfig: "", identityPrefix: "" } as never, async () => {
      const result = await env.exec("printf done", undefined, BACKGROUND_CONTEXT);
      expect(result.ok && result.value.exitCode).toBe(0);
      expect(result.ok && result.value.spillPath).toBe("/tmp/spill-xyz");
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

describe("检视发现回填（reviewer-1900）", () => {
  it("MAJOR-1：自铸 actionId 含 boot 纪元——跨 boot 同序号不再碰撞去重，文件照常写入", async () => {
    const dir = tempDir();
    const file = path.join(dir, "actions.db");
    const target = path.join(dir, "cross-boot.md");
    // boot N：internal 第 1 个动作已 succeeded（旧行 id 形态 internal:1）
    const ledgerA = new SqliteActionLedger(file);
    await ledgerA.start({ actionId: `internal:${ledgerA.bootEpoch}:1`, source: "internal", kind: "file.write", target, contentHash: sha256("boot-N-content"), contentBytes: 14 });
    await ledgerA.settle(`internal:${ledgerA.bootEpoch}:1`, { status: "succeeded" });
    ledgerA.close();

    // boot N+1（重开库，纪元递增）：同样无 ALS 上下文的第 1 个写动作 → id 含新纪元，不撞旧行
    const ledgerB = new SqliteActionLedger(file);
    const { env } = makeEnv(dir, ledgerB, ledgerB.bootEpoch);
    const result = await env.writeFile(target, "boot-N+1-content", BACKGROUND_CONTEXT);
    expect(result.ok).toBe(true);
    const { readFileSync } = await import("node:fs");
    expect(readFileSync(target, "utf8")).toBe("boot-N+1-content"); // 不再被旧 boot 的 succeeded 行静默跳写
    const rows = await allRows(ledgerB);
    expect(rows.filter(r => r.source === "internal")).toHaveLength(2); // 旧行 + 新行共存
    expect(rows.some(r => r.actionId.startsWith(`internal-`) && r.actionId.includes(`:${ledgerB.bootEpoch}:1`))).toBe(true); // 新行含新纪元与实例标签
    ledgerB.close();
  });

  it("MINOR-3：broken symlink 写入穿透创建 referent，链接保留（对齐 SDK 基线）", async () => {
    const dir = tempDir();
    const { env } = makeEnv(dir, null);
    const referent = path.join(dir, "not-there-yet.txt");
    const link = path.join(dir, "dangling-link.txt");
    symlinkSync(referent, link); // 目标不存在：broken link
    const result = await env.writeFile(link, "via-broken-link", BACKGROUND_CONTEXT);
    expect(result.ok).toBe(true);
    const { readFileSync, lstatSync } = await import("node:fs");
    expect(lstatSync(link).isSymbolicLink()).toBe(true); // 链接未被替换
    expect(readFileSync(referent, "utf8")).toBe("via-broken-link"); // 内容落在 referent
  });

  it("R-1：多级断链 link1→link2→缺失，穿透链创建最终 referent，两级链接都保留", async () => {
    const dir = tempDir();
    const { env } = makeEnv(dir, null);
    const referent = path.join(dir, "final-target.txt");
    const link2 = path.join(dir, "level2.txt");
    const link1 = path.join(dir, "level1.txt");
    symlinkSync(referent, link2);
    symlinkSync(link2, link1); // 两级链，最终 referent 缺失
    const result = await env.writeFile(link1, "chain-content", BACKGROUND_CONTEXT);
    expect(result.ok).toBe(true);
    const { readFileSync, lstatSync } = await import("node:fs");
    expect(lstatSync(link1).isSymbolicLink()).toBe(true);
    expect(lstatSync(link2).isSymbolicLink()).toBe(true);
    expect(readFileSync(referent, "utf8")).toBe("chain-content");
  });

  it("R-1 尾：循环链（a→b→a）显式报错，不静默替换链接（对齐 SDK ELOOP 基线）", async () => {
    const dir = tempDir();
    const { env } = makeEnv(dir, null);
    const a = path.join(dir, "cycle-a.txt");
    const b = path.join(dir, "cycle-b.txt");
    symlinkSync(b, a);
    symlinkSync(a, b);
    const result = await env.writeFile(a, "never", BACKGROUND_CONTEXT);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("invalid");
    const { lstatSync, readFileSync } = await import("node:fs");
    expect(lstatSync(a).isSymbolicLink()).toBe(true); // 链接未被替换
    expect(() => readFileSync(b)).toThrow(); // 无内容被写入循环链任何一环
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
