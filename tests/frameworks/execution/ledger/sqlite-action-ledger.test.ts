import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteActionLedger, sha256 } from "@frameworks/execution/ledger/sqlite-action-ledger";

/** F20261116actlg（#1868 阶段 3）PR-A：本机动作台账 sqlite 实现单测。 */

let dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "action-ledger-test-"));
  dirs.push(dir);
  return dir;
}

function ledgerFile(): string {
  return path.join(tempDir(), "actions.db");
}

afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

describe("SqliteActionLedger 基础生命周期", () => {
  it("start 落 running 行，settle 裁决终态", async () => {
    const ledger = new SqliteActionLedger(ledgerFile());
    const { record, deduped } = await ledger.start({
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
    const ledger = new SqliteActionLedger(ledgerFile());
    expect(await ledger.getByActionId("missing")).toBeNull();
  });

  it("listByInvoke 按 startedAt 升序返回该 invoke 的动作", async () => {
    const ledger = new SqliteActionLedger(ledgerFile());
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
    const ledger = new SqliteActionLedger(ledgerFile());
    await ledger.start({ actionId: "act-1", source: "workspace", kind: "workspace.write" });
    await ledger.settle("act-1", { status: "succeeded", resultSummary: { bytes: 3 } });
    const second = await ledger.start({ actionId: "act-1", source: "workspace", kind: "workspace.write" });
    expect(second.deduped).toBe(true);
    expect(second.record.status).toBe("succeeded");
  });

  it("interrupted / failed 不是「已完成」——重开新一轮而非去重；unknown 同理（经清扫产生）", async () => {
    const file = ledgerFile();
    const ledgerA = new SqliteActionLedger(file);
    for (const actionId of ["act-interrupted", "act-failed"]) {
      await ledgerA.start({ actionId, source: "sdk-env", kind: "file.write" });
      await ledgerA.settle(actionId, actionId === "act-interrupted"
        ? { status: "interrupted", error: "x" }
        : { status: "failed", error: "y" });
    }
    // unknown 只能由清扫产生（shell.exec 旧纪元 running）
    await ledgerA.start({ actionId: "act-unknown", source: "sdk-env", kind: "shell.exec" });
    ledgerA.close();

    const ledgerB = new SqliteActionLedger(file);
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
  it("file.write hash 命中 → succeeded（且回执修复）", async () => {
    const dir = tempDir();
    const file = path.join(dir, "actions.db");
    const target = path.join(dir, "a.md");
    writeFileSync(target, "hello world");

    const ledgerA = new SqliteActionLedger(file);
    // 模拟崩溃：start 后未 settle
    await ledgerA.start({
      actionId: "sweep-write-hit", source: "sdk-env", kind: "file.write", target,
      contentHash: sha256("hello world"), contentBytes: 11,
    });
    ledgerA.close();

    // 新开机（epoch 递增）：清扫 → hash 命中追认 succeeded
    const ledgerB = new SqliteActionLedger(file);
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

    const ledgerA = new SqliteActionLedger(file);
    await ledgerA.start({
      actionId: "sweep-write-miss", source: "sdk-env", kind: "file.write", target,
      contentHash: sha256("partial content"), contentBytes: 15,
    });
    ledgerA.close();

    const ledgerB = new SqliteActionLedger(file);
    const report = await ledgerB.open();
    expect(report.markedInterrupted).toBe(1);
    const row = await ledgerB.getByActionId("sweep-write-miss");
    expect(row?.status).toBe("interrupted");
    ledgerB.close();
  });

  it("file.append 尾部 hash 命中 → succeeded；不中 → interrupted", async () => {
    const dir = tempDir();
    const file = path.join(dir, "actions.db");
    const target = path.join(dir, "c.log");
    writeFileSync(target, "prefix-appended-tail");

    const ledgerA = new SqliteActionLedger(file);
    await ledgerA.start({
      source: "sdk-env", kind: "file.append", target,
      contentHash: sha256("appended-tail"), contentBytes: 13,
    });
    ledgerA.close();

    const ledgerB = new SqliteActionLedger(file);
    const report = await ledgerB.open();
    expect(report.upgradedToSucceeded).toBe(1);
    ledgerB.close();

    // 不中场景：文件尾部与追加内容不符
    const file2 = path.join(dir, "actions2.db");
    const target2 = path.join(dir, "d.log");
    writeFileSync(target2, "only-prefix");
    const ledgerC = new SqliteActionLedger(file2);
    await ledgerC.start({
      source: "sdk-env", kind: "file.append", target: target2,
      contentHash: sha256("appended-tail"), contentBytes: 13,
    });
    ledgerC.close();
    const ledgerD = new SqliteActionLedger(file2);
    const report2 = await ledgerD.open();
    expect(report2.markedInterrupted).toBe(1);
    ledgerD.close();
  });

  it("shell.exec 旧纪元 running → unknown（转检查，禁止猜测重试）", async () => {
    const file = ledgerFile();
    const ledgerA = new SqliteActionLedger(file);
    await ledgerA.start({
      actionId: "sweep-exec", source: "sdk-env", kind: "shell.exec", target: "npm run build",
    });
    ledgerA.close();

    const ledgerB = new SqliteActionLedger(file);
    const report = await ledgerB.open();
    expect(report.markedUnknown).toBe(1);
    const row = await ledgerB.getByActionId("sweep-exec");
    expect(row?.status).toBe("unknown");
    expect(row?.error).toContain("unverifiable");
    ledgerB.close();
  });

  it("file.rename/remove/mkdir → interrupted（幂等可重做）", async () => {
    const file = ledgerFile();
    const ledgerA = new SqliteActionLedger(file);
    await ledgerA.start({ source: "sdk-env", kind: "file.rename", target: "/tmp/dst" });
    await ledgerA.start({ source: "sdk-env", kind: "file.remove", target: "/tmp/x" });
    await ledgerA.start({ source: "sdk-env", kind: "file.mkdir", target: "/tmp/y" });
    ledgerA.close();

    const ledgerB = new SqliteActionLedger(file);
    const report = await ledgerB.open();
    expect(report.markedInterrupted).toBe(3);
    ledgerB.close();
  });

  it("同纪元 running 行（同 boot 内重试）不被清扫", async () => {
    const ledger = new SqliteActionLedger(ledgerFile());
    await ledger.start({ source: "sdk-env", kind: "shell.exec" });
    const report = await ledger.sweepStaleBoot();
    expect(report.markedUnknown).toBe(0);
    ledger.close();
  });
});

describe("修剪", () => {
  it("超期终态行被修剪；非终态行永不修剪", async () => {
    const file = path.join(tempDir(), "actions.db");
    const ledger = new SqliteActionLedger(file, { retentionDays: 0 });
    const staleAt = new Date(Date.now() - 60_000).toISOString();
    await ledger.start({ actionId: "old-ok", source: "sdk-env", kind: "file.write" });
    await ledger.settle("old-ok", { status: "succeeded" }, staleAt);
    await ledger.start({ actionId: "old-run", source: "sdk-env", kind: "file.write" });
    const report = await ledger.sweepStaleBoot();
    expect(report.pruned).toBe(1); // 仅终态行
    expect(await ledger.getByActionId("old-run")).not.toBeNull();
    ledger.close();
  });
});

describe("boot epoch", () => {
  it("每次开机单调递增，行携带铸造时纪元", async () => {
    const file = ledgerFile();
    const a = new SqliteActionLedger(file);
    const { record } = await a.start({ source: "sdk-env", kind: "file.write" });
    expect(record.bootEpoch).toBe(a.bootEpoch);
    a.close();
    const b = new SqliteActionLedger(file);
    expect(b.bootEpoch).toBeGreaterThan(a.bootEpoch);
    b.close();
  });
});
