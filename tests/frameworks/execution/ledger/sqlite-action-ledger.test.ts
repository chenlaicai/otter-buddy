import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 20_000 });
import { SqliteActionLedger, sha256 } from "@frameworks/execution/ledger/sqlite-action-ledger";
import { WorkspaceActionExecutor } from "@frameworks/execution/workspace-action-executor";
import { NodeWorkspaceGateway } from "@frameworks/file-system/node-workspace-gateway";

/** 本机动作台账 sqlite 实现单测。 */

let dirs: string[] = [];
let spawnedGroups: number[] = [];

function spawnProcessGroup(): { child: ChildProcess; pgid: number; startedAt: string } {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], {
    detached: true,
    stdio: "ignore",
  });
  if (!child.pid) throw new Error("test child did not expose a pid");
  spawnedGroups.push(child.pid);
  const startedAt = readProcessStart(child.pid);
  return { child, pgid: child.pid, startedAt };
}

function readProcessStart(pid: number): string {
  const result = spawnSync("ps", ["-p", String(pid), "-o", "lstart="], {
    encoding: "utf8",
    env: { ...process.env, LC_ALL: "C" },
  });
  if (result.status !== 0 || !result.stdout.trim()) throw new Error(`cannot read test process start: ${result.stderr}`);
  return new Date(result.stdout.trim()).toISOString();
}

function isGroupAlive(pgid: number): boolean {
  try { process.kill(-pgid, 0); return true; } catch { return false; }
}

async function waitForGroupDeath(pgid: number): Promise<boolean> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    if (!isGroupAlive(pgid)) return true;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  return !isGroupAlive(pgid);
}

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "action-ledger-test-"));
  dirs.push(dir);
  return dir;
}

function ledgerFile(): string {
  return path.join(tempDir(), "actions.db");
}

afterEach(() => {
  for (const pgid of spawnedGroups) {
    try { process.kill(-pgid, "SIGKILL"); } catch { /* already reaped */ }
  }
  spawnedGroups = [];
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

describe("SqliteActionLedger 基础生命周期", () => {
  it("start 落 running 行，settle 裁决终态", async () => {
    const ledger = new SqliteActionLedger(ledgerFile(), { deviceId: "ledger-test" });
    const { record, deduped } = await ledger.start({
      actionId: "life-1",
      source: "sdk-env",
      kind: "file.write",
      invokeId: "inv-1",
      toolCallId: "call-1",
      target: "/tmp/a.md",
      contentHash: sha256("hello"),
      contentBytes: 5,
    });
    expect(deduped).toBe(false);
    expect(record.status).toBe("running");
    expect(record.bootEpoch).toBe(ledger.bootEpoch);

    await ledger.settle(record.actionId, { status: "succeeded", resultSummary: { bytes: 5 } });
    const settled = await ledger.getByActionId(record.actionId);
    expect(settled?.status).toBe("succeeded");
    expect(settled?.resultSummary).toBe(JSON.stringify({ bytes: 5 }));
    expect(settled?.settledAt).toBeTruthy();
  });

  it("getByActionId 无行 = not_found（查询层第五态）", async () => {
    const ledger = new SqliteActionLedger(ledgerFile(), { deviceId: "ledger-test" });
    expect(await ledger.getByActionId("missing")).toBeNull();
  });

  it("listByInvoke 按 startedAt 升序返回该 invoke 的动作", async () => {
    const ledger = new SqliteActionLedger(ledgerFile(), { deviceId: "ledger-test" });
    await ledger.start({ actionId: "b", source: "workspace", kind: "workspace.write", invokeId: "inv-9", conversationId: "c1" });
    await new Promise(resolve => setTimeout(resolve, 3)); // 拉开毫秒，钉死时间序（同毫秒时会退化 action_id 字典序）
    await ledger.start({ actionId: "a", source: "sdk-env", kind: "shell.exec", invokeId: "inv-9" });
    await new Promise(resolve => setTimeout(resolve, 3));
    await ledger.start({ actionId: "c", source: "sdk-env", kind: "file.write", invokeId: "inv-other" });
    const rows = await ledger.listByInvoke("inv-9");
    expect(rows.map(r => r.actionId)).toEqual(["b", "a"]);
  });
});

describe("去重协议", () => {
  it("同 actionId 已 succeeded → deduped=true 直接返回已记录结果", async () => {
    const ledger = new SqliteActionLedger(ledgerFile(), { deviceId: "ledger-test" });
    await ledger.start({ actionId: "act-1", source: "workspace", kind: "workspace.write" });
    await ledger.settle("act-1", { status: "succeeded", resultSummary: { bytes: 3 } });
    const second = await ledger.start({ actionId: "act-1", source: "workspace", kind: "workspace.write" });
    expect(second.deduped).toBe(true);
    expect(second.record.status).toBe("succeeded");
  });

  it("interrupted / failed 不是「已完成」——重开新一轮而非去重；unknown 同理（经清扫产生）", async () => {
    const file = ledgerFile();
    const ledgerA = new SqliteActionLedger(file, { deviceId: "ledger-test" });
    for (const actionId of ["act-interrupted", "act-failed"]) {
      await ledgerA.start({ actionId, source: "sdk-env", kind: "file.write" });
      await ledgerA.settle(actionId, actionId === "act-interrupted"
        ? { status: "interrupted", error: "x" }
        : { status: "failed", error: "y" });
    }
    // unknown 只能由清扫产生（shell.exec 旧纪元 running）
    await ledgerA.start({ actionId: "act-unknown", source: "sdk-env", kind: "shell.exec" });
    ledgerA.close();

    const ledgerB = new SqliteActionLedger(file, { deviceId: "ledger-test" });
    await ledgerB.open(); // 清扫：act-unknown → unknown
    expect((await ledgerB.getByActionId("act-unknown"))?.status).toBe("unknown");

    for (const actionId of ["act-interrupted", "act-failed", "act-unknown"]) {
      const redo = await ledgerB.start({ actionId, source: "sdk-env", kind: "file.write" });
      expect(redo.deduped).toBe(false);
      expect(redo.record.status).toBe("running");
    }
    ledgerB.close();
  });
});

describe("开机清扫（旧纪元 running 行裁决）", () => {
  it("dspro MAJOR：workspace.write 绝对 target——清扫 hash 核对能追认真实完成的写入", async () => {
    const dir = tempDir();
    const file = path.join(dir, "actions.db");
    // 真实走一遍机器写入（target 现在记绝对路径）
    const ledgerA = new SqliteActionLedger(file, { deviceId: "ledger-test" });
    const executor = new WorkspaceActionExecutor(new NodeWorkspaceGateway(dir), ledgerA);
    await executor.run({ type: "workspace.write", input: { conversationId: "conv-sw", relativePath: "a.md", content: "hello sweep" } });
    ledgerA.close();

    // 模拟崩溃：把已 succeeded 的行拨回旧纪元 running（磁盘内容保持完整）
    const Database = (await import("better-sqlite3")).default;
    const db = new Database(file);
    db.prepare("UPDATE execution_actions SET status = 'running', boot_epoch = 0, settled_at = NULL WHERE kind = 'workspace.write'").run();
    db.close();

    // 新开机清扫：hash 应命中磁盘真实内容 → 追认 succeeded
    const ledgerB = new SqliteActionLedger(file, { deviceId: "ledger-test" });
    const report = await ledgerB.open();
    expect(report.upgradedToSucceeded).toBe(1);
    const rows = await allRawRows(ledgerB);
    expect(rows[0].status).toBe("succeeded");
    expect(JSON.parse(rows[0].result_summary ?? "{}")).toMatchObject({ receiptRecovered: true });
    expect(rows[0].target).toBe(path.join(dir, "workspaces", "conv-sw", "a.md")); // 绝对路径
    ledgerB.close();
  });

  it("file.write hash 命中 → succeeded（且回执修复）", async () => {
    const dir = tempDir();
    const file = path.join(dir, "actions.db");
    const target = path.join(dir, "a.md");
    writeFileSync(target, "hello world");

    const ledgerA = new SqliteActionLedger(file, { deviceId: "ledger-test" });
    // 模拟崩溃：start 后未 settle
    await ledgerA.start({
      actionId: "sweep-write-hit", source: "sdk-env", kind: "file.write", target,
      contentHash: sha256("hello world"), contentBytes: 11,
    });
    ledgerA.close();

    // 新开机（epoch 递增）：清扫 → hash 命中追认 succeeded
    const ledgerB = new SqliteActionLedger(file, { deviceId: "ledger-test" });
    const report = await ledgerB.open();
    expect(report.upgradedToSucceeded).toBe(1);
    const row = await ledgerB.getByActionId("sweep-write-hit");
    expect(row?.status).toBe("succeeded");
    expect(JSON.parse(row?.resultSummary ?? "{}")).toMatchObject({ receiptRecovered: true });
    ledgerB.close();
  });

  it("file.write hash 不中 → interrupted", async () => {
    const dir = tempDir();
    const file = path.join(dir, "actions.db");
    const target = path.join(dir, "b.md");
    writeFileSync(target, "partial conte"); // 崩溃留半截

    const ledgerA = new SqliteActionLedger(file, { deviceId: "ledger-test" });
    await ledgerA.start({
      actionId: "sweep-write-miss", source: "sdk-env", kind: "file.write", target,
      contentHash: sha256("partial content"), contentBytes: 15,
    });
    ledgerA.close();

    const ledgerB = new SqliteActionLedger(file, { deviceId: "ledger-test" });
    const report = await ledgerB.open();
    expect(report.markedInterrupted).toBe(1);
    const row = await ledgerB.getByActionId("sweep-write-miss");
    expect(row?.status).toBe("interrupted");
    ledgerB.close();
  });

  it("file.append 尾部 hash 命中 → succeeded；不中 → unknown（重做会重复追加，转检查）", async () => {
    const dir = tempDir();
    const file = path.join(dir, "actions.db");
    const target = path.join(dir, "c.log");
    writeFileSync(target, "prefix-appended-tail");

    const ledgerA = new SqliteActionLedger(file, { deviceId: "ledger-test" });
    await ledgerA.start({
      actionId: "sweep-append-1", source: "sdk-env", kind: "file.append", target,
      contentHash: sha256("appended-tail"), contentBytes: 13,
    });
    ledgerA.close();

    const ledgerB = new SqliteActionLedger(file, { deviceId: "ledger-test" });
    const report = await ledgerB.open();
    expect(report.upgradedToSucceeded).toBe(1);
    ledgerB.close();

    // 不中场景：文件尾部与追加内容不符
    const file2 = path.join(dir, "actions2.db");
    const target2 = path.join(dir, "d.log");
    writeFileSync(target2, "only-prefix");
    const ledgerC = new SqliteActionLedger(file2, { deviceId: "ledger-test" });
    await ledgerC.start({
      actionId: "sweep-append-miss", source: "sdk-env", kind: "file.append", target: target2,
      contentHash: sha256("appended-tail"), contentBytes: 13,
    });
    ledgerC.close();
    const ledgerD = new SqliteActionLedger(file2, { deviceId: "ledger-test" });
    const report2 = await ledgerD.open();
    expect(report2.markedUnknown).toBe(1); // dspro minor：尾不匹配不能证明没追加上——重做会重复，转检查
    expect((await ledgerD.getByActionId("sweep-append-miss"))?.status).toBe("unknown");
    ledgerD.close();
  });

  it("shell.exec 旧纪元：PGID 与启动时间匹配时先回收进程组，再落 unknown 审计", async () => {
    const { pgid, startedAt } = spawnProcessGroup();
    const file = ledgerFile();
    const ledgerA = new SqliteActionLedger(file, { deviceId: "ledger-test" });
    const input = {
      actionId: "sweep-exec-recover", source: "sdk-env" as const, kind: "shell.exec" as const,
      target: "long-running-test", pid: pgid, processStartedAt: startedAt,
    };
    await ledgerA.start(input);
    ledgerA.close();

    const ledgerB = new SqliteActionLedger(file, { deviceId: "ledger-test" });
    const report = await ledgerB.open();
    expect(report.markedUnknown).toBe(1);
    expect(await waitForGroupDeath(pgid)).toBe(true);
    const row = await ledgerB.getByActionId("sweep-exec-recover");
    expect(row).toMatchObject({ status: "unknown", pid: pgid, processStartedAt: startedAt });
    expect(JSON.parse(row?.resultSummary ?? "{}")).toMatchObject({
      processGroupRecovery: { status: "signaled", pgid },
    });
    ledgerB.close();
  });

  it("shell.exec 旧纪元：启动时间不匹配视为 PGID 复用，不杀无关进程", async () => {
    const { pgid } = spawnProcessGroup();
    const file = ledgerFile();
    const ledgerA = new SqliteActionLedger(file, { deviceId: "ledger-test" });
    await ledgerA.start({
      actionId: "sweep-exec-reused", source: "sdk-env", kind: "shell.exec",
      pid: pgid, processStartedAt: new Date(0).toISOString(),
    });
    ledgerA.close();

    const ledgerB = new SqliteActionLedger(file, { deviceId: "ledger-test" });
    await ledgerB.open();
    expect(isGroupAlive(pgid)).toBe(true);
    const row = await ledgerB.getByActionId("sweep-exec-reused");
    expect(JSON.parse(row?.resultSummary ?? "{}")).toMatchObject({
      processGroupRecovery: { status: "identity_mismatch", pgid },
    });
    ledgerB.close();
  });

  it("shell.exec 旧版行缺启动时间：宁可不回收也不猜杀，留下明确处置信息", async () => {
    const { pgid } = spawnProcessGroup();
    const file = ledgerFile();
    const ledgerA = new SqliteActionLedger(file, { deviceId: "ledger-test" });
    await ledgerA.start({ actionId: "sweep-exec-legacy", source: "sdk-env", kind: "shell.exec", pid: pgid });
    ledgerA.close();

    const ledgerB = new SqliteActionLedger(file, { deviceId: "ledger-test" });
    await ledgerB.open();
    expect(isGroupAlive(pgid)).toBe(true);
    const row = await ledgerB.getByActionId("sweep-exec-legacy");
    expect(JSON.parse(row?.resultSummary ?? "{}")).toMatchObject({
      processGroupRecovery: { status: "missing_start_time", pgid },
    });
    ledgerB.close();
  });

  it("shell.exec 旧纪元 running → unknown（转检查，禁止猜测重试）", async () => {
    const file = ledgerFile();
    const ledgerA = new SqliteActionLedger(file, { deviceId: "ledger-test" });
    await ledgerA.start({
      actionId: "sweep-exec", source: "sdk-env", kind: "shell.exec", target: "npm run build",
    });
    ledgerA.close();

    const ledgerB = new SqliteActionLedger(file, { deviceId: "ledger-test" });
    const report = await ledgerB.open();
    expect(report.markedUnknown).toBe(1);
    const row = await ledgerB.getByActionId("sweep-exec");
    expect(row?.status).toBe("unknown");
    expect(row?.error).toContain("unverifiable");
    ledgerB.close();
  });

  it("file.rename/remove/mkdir → interrupted（幂等可重做）", async () => {
    const file = ledgerFile();
    const ledgerA = new SqliteActionLedger(file, { deviceId: "ledger-test" });
    await ledgerA.start({ actionId: "sw-ren", source: "sdk-env", kind: "file.rename", target: "/tmp/dst" });
    await ledgerA.start({ actionId: "sw-rm", source: "sdk-env", kind: "file.remove", target: "/tmp/x" });
    await ledgerA.start({ actionId: "sw-mk", source: "sdk-env", kind: "file.mkdir", target: "/tmp/y" });
    ledgerA.close();

    const ledgerB = new SqliteActionLedger(file, { deviceId: "ledger-test" });
    const report = await ledgerB.open();
    expect(report.markedInterrupted).toBe(3);
    ledgerB.close();
  });

  it("同纪元 running 行（同 boot 内重试）不被清扫", async () => {
    const ledger = new SqliteActionLedger(ledgerFile(), { deviceId: "ledger-test" });
    await ledger.start({ actionId: "epoch-1", source: "sdk-env", kind: "shell.exec" });
    const report = await ledger.sweepStaleBoot();
    expect(report.markedUnknown).toBe(0);
    ledger.close();
  });
});

describe("修剪", () => {
  it("超期终态行被修剪；running 行永不修剪", async () => {
    const file = path.join(tempDir(), "actions.db");
    const ledger = new SqliteActionLedger(file, { deviceId: "ledger-test", retentionDays: 0 });
    const staleAt = new Date(Date.now() - 60_000).toISOString();
    await ledger.start({ actionId: "old-ok", source: "sdk-env", kind: "file.write" });
    await ledger.settle("old-ok", { status: "succeeded" }, staleAt);
    await ledger.start({ actionId: "old-run", source: "sdk-env", kind: "file.write" });
    const report = await ledger.sweepStaleBoot();
    expect(report.pruned).toBe(1); // 仅终态行
    expect(await ledger.getByActionId("old-run")).not.toBeNull();
    ledger.close();
  });

  it("MINOR-4：interrupted 随终态同窗修剪；unknown 留 30 天检查窗后修剪", async () => {
    const file = path.join(tempDir(), "actions.db");
    const ledger = new SqliteActionLedger(file, { deviceId: "ledger-test", retentionDays: 0 });
    const staleAt = new Date(Date.now() - 60_000).toISOString();
    await ledger.start({ actionId: "old-int", source: "sdk-env", kind: "file.remove" });
    await ledger.settle("old-int", { status: "interrupted", error: "x" }, staleAt);
    await ledger.start({ actionId: "old-unk", source: "sdk-env", kind: "shell.exec" });
    await ledger.settle("old-unk", { status: "failed", error: "y" }); // settle 只收三种裁决，unknown 经行内 SQL 预置
    const Database = (await import("better-sqlite3")).default;
    const db = new Database(file);
    db.prepare("UPDATE execution_actions SET status = 'unknown', settled_at = ? WHERE action_id = 'old-unk'").run(staleAt);
    db.close();
    // retentionDays=0：interrupted 立即超窗；unknown 窗 30 天，远未到 → 不剪
    const report1 = await ledger.sweepStaleBoot();
    expect(report1.pruned).toBe(1);
    expect(await ledger.getByActionId("old-unk")).not.toBeNull();
    // 把 unknown 行 settled_at 拨回 31 天前 → 超窗剪掉
    const db2 = new Database(file);
    db2.prepare("UPDATE execution_actions SET settled_at = ? WHERE action_id = 'old-unk'").run(new Date(Date.now() - 31 * 86_400_000).toISOString());
    db2.close();
    const report2 = await ledger.sweepStaleBoot();
    expect(report2.pruned).toBe(1);
    expect(await ledger.getByActionId("old-unk")).toBeNull();
    ledger.close();
  });
});

describe("boot epoch", () => {
  it("每次开机单调递增，行携带铸造时纪元", async () => {
    const file = ledgerFile();
    const a = new SqliteActionLedger(file, { deviceId: "ledger-test" });
    const { record } = await a.start({ actionId: "epoch-check-1", source: "sdk-env", kind: "file.write" });
    expect(record.bootEpoch).toBe(a.bootEpoch);
    a.close();
    const b = new SqliteActionLedger(file, { deviceId: "ledger-test" });
    expect(b.bootEpoch).toBeGreaterThan(a.bootEpoch);
    b.close();
  });
});

/** 直读全部行（测试辅助：绕过 listByInvoke 的 invoke 过滤） */
async function allRawRows(ledger: SqliteActionLedger): Promise<Array<{ status: string; target: string | null; result_summary: string | null }>> {
  const Database = (await import("better-sqlite3")).default;
  const db = new Database(ledger.file, { readonly: true });
  const rows = db.prepare("SELECT * FROM execution_actions ORDER BY started_at ASC, action_id ASC").all() as Array<{ status: string; target: string | null; result_summary: string | null }>;
  db.close();
  return rows;
}
