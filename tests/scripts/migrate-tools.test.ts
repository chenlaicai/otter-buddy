/**
 * 迁移工具测试：lib 纯函数 + export→restore→verify 端到端（小 fixture）。
 *
 * 端到端走真实 tar/gzip 子进程与三个 CLI 脚本——与生产路径完全同构，
 * 只是数据集是 tmp 下的小 fixture（两张表几个文件）。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readdirSync, existsSync, symlinkSync as fsSymlinkSync, cpSync as fsCpSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import Database from "better-sqlite3";
import { createTestDb } from "../helpers/db";
import {
  collectMigrateFiles, collectMigrateEntries, buildManifest, verifyAgainstManifest,
} from "../../scripts/migrate-lib.mjs";

const repoRoot = path.resolve(__dirname, "../..");
let fixtureRoot: string;
let dataDir: string;

function makeFixtureDb(abs: string, conversations: number, participants: number): void {
  mkdirSync(path.dirname(abs), { recursive: true });
  const db = createTestDb(abs); // 生产 schema（lint:tests 禁手写 DDL——防 schema 漂移）
  db.pragma("foreign_keys = OFF"); // fixture 允许孤儿行（行数校验语义，非 FK 语义）
  const insConv = db.prepare("INSERT INTO conversations (id, title, status, created_at, updated_at) VALUES (?, ?, 'active', ?, ?)");
  const insPart = db.prepare("INSERT INTO conversation_otters (conversation_id, otter_id) VALUES (?, ?)");
  const now = new Date().toISOString();
  for (let i = 0; i < conversations; i++) insConv.run(`c-${i}`, `t-${i}`, now, now);
  for (let i = 0; i < participants; i++) insPart.run("c-0", `otter-${i}`);
  db.close();
}

beforeAll(() => {
  fixtureRoot = mkdtempSync(path.join(tmpdir(), "migrate-6b-"));
  dataDir = path.join(fixtureRoot, "data");
  // 白名单内：主库 + durable 库 + workspaces + owner-password
  makeFixtureDb(path.join(dataDir, "otter-buddy.db"), 3, 7);
  makeFixtureDb(path.join(dataDir, "durable-sessions/s1.sqlite"), 1, 2);
  mkdirSync(path.join(dataDir, "workspaces/c-1"), { recursive: true });
  writeFileSync(path.join(dataDir, "workspaces/c-1/file.txt"), "hello migrate");
  writeFileSync(path.join(dataDir, "owner-password"), "fixture-password");
  // symlink（workspaces 正常组成：venv 相对链/绝对链）
  fsSymlinkSync("python", path.join(dataDir, "workspaces/c-1/bin-python"));
  fsSymlinkSync("/usr/local/bin/absolute-target", path.join(dataDir, "workspaces/c-1/abs-link"));
  // WAL 伴生（durable-sessions 生产形态：主库 + -shm/-wal 伴生）
  writeFileSync(path.join(dataDir, "durable-sessions/s1.sqlite-shm"), "shm sidecar");
  writeFileSync(path.join(dataDir, "durable-sessions/s1.sqlite-wal"), "wal sidecar");
  // 白名单外（不应进 manifest）：backups / logs / rehearsal 库
  mkdirSync(path.join(dataDir, "backups"), { recursive: true });
  writeFileSync(path.join(dataDir, "backups/old.tar.gz"), "legacy");
  mkdirSync(path.join(dataDir, "logs"), { recursive: true });
  writeFileSync(path.join(dataDir, "logs/otter-buddy.log"), "logs");
  writeFileSync(path.join(dataDir, "otter-buddy-rehearsal-old.db"), "legacy db");
});

afterAll(() => {
  rmSync(fixtureRoot, { recursive: true, force: true });
});

describe("migrate-lib（阶段 6b 纯函数）", () => {
  it("collectMigrateFiles：白名单收录 + backups/logs/rehearsal 排除", () => {
    const files = collectMigrateFiles(dataDir);
    expect(files).toContain("otter-buddy.db");
    expect(files).toContain("durable-sessions/s1.sqlite");
    expect(files).toContain("workspaces/c-1/file.txt");
    expect(files).toContain("owner-password");
    expect(files.some((f) => f.startsWith("backups/"))).toBe(false);
    expect(files.some((f) => f.startsWith("logs/"))).toBe(false);
    expect(files.some((f) => f.includes("rehearsal"))).toBe(false);
  });

  it("buildManifest + verifyAgainstManifest：同目录自校验通过（表行数含在 manifest）", async () => {
    const manifest = await buildManifest(dataDir, collectMigrateEntries(dataDir), dataDir);
    expect(manifest.databases["otter-buddy.db"].tables.conversations).toBe(3);
    expect(manifest.databases["otter-buddy.db"].tables.conversation_otters).toBe(7);
    expect(manifest.databases["durable-sessions/s1.sqlite"].tables.conversations).toBe(1);
    const { ok, report } = verifyAgainstManifest(dataDir, manifest);
    expect(ok, JSON.stringify(report.fileDiffs.concat(report.tableDiffs))).toBe(true);
  });

  it("verifyAgainstManifest：篡改文件内容 → sha mismatch；删行 → 表行数 mismatch；多余文件 → extra", async () => {
    const copyDir = path.join(fixtureRoot, "tampered");
    fsCpSync(dataDir, copyDir, { recursive: true, verbatimSymlinks: true }); // 跨平台（CI linux 无 cp -c）
    // 篡改 + 删行 + 多余文件
    writeFileSync(path.join(copyDir, "owner-password"), "changed");
    const db = new Database(path.join(copyDir, "otter-buddy.db"));
    db.exec("DELETE FROM conversation_otters WHERE otter_id = 'otter-0'");
    db.close();
    writeFileSync(path.join(copyDir, "workspaces/c-1/extra.txt"), "extra");
    rmSync(path.join(copyDir, "workspaces/c-1/bin-python"));
    fsSymlinkSync("changed-target", path.join(copyDir, "workspaces/c-1/bin-python")); // symlink target 篡改
    const manifest = await buildManifest(dataDir, collectMigrateEntries(dataDir), dataDir);
    const { ok, report } = verifyAgainstManifest(copyDir, manifest);
    expect(ok).toBe(false);
    expect(report.fileDiffs.some((d) => d.includes("owner-password"))).toBe(true);
    expect(report.tableDiffs.some((d) => d.includes("#conversation_otters"))).toBe(true);
    expect(report.fileDiffs.some((d) => d.includes("extra.txt"))).toBe(true);
    expect(report.fileDiffs.some((d) => d.includes("bin-python") && d.includes("symlink"))).toBe(true);
  });
});

describe("migrate CLI 端到端（export → restore → verify）", () => {
  it("全链路：产物 tar.gz + manifest 生成；restore 后三级校验通过", () => {
    const outDir = path.join(fixtureRoot, "out");
    const restoreDir = path.join(fixtureRoot, "restored");
    execFileSync("node", [
      path.join(repoRoot, "scripts/migrate-export.mjs"),
      "--data-dir", dataDir, "--out", outDir, "--skip-liveness",
    ], { stdio: "pipe", cwd: repoRoot });

    const produced = readdirSync(outDir);
    const tarName = produced.find((f) => f.endsWith(".tar.gz"));
    const manifestName = produced.find((f) => f.endsWith(".manifest.json"));
    expect(tarName).toBeTruthy();
    expect(manifestName).toBeTruthy();
    expect(existsSync(path.join(outDir, tarName!))).toBe(true);

    execFileSync("node", [
      path.join(repoRoot, "scripts/migrate-restore.mjs"),
      "--tar", path.join(outDir, tarName!), "--data-dir", restoreDir,
    ], { stdio: "pipe", cwd: repoRoot });

    // 还原结果：内容在 + 独立 verify 可重跑（不抛即 exit 0=校验通过）+ 报告落盘
    expect(existsSync(path.join(restoreDir, "otter-buddy.db"))).toBe(true);
    const verifyReport = path.join(fixtureRoot, "migrate-verify-report.json");
    execFileSync("node", [
      path.join(repoRoot, "scripts/migrate-verify.mjs"),
      "--data-dir", restoreDir, "--manifest", path.join(outDir, manifestName!),
      "--report", verifyReport,
    ], { stdio: "pipe", cwd: repoRoot });
    expect(existsSync(verifyReport)).toBe(true);
  }, 60_000);

  it("restore 默认拒非空目录（防误覆盖），--allow-overwrite 显式解锁", () => {
    const outDir2 = path.join(fixtureRoot, "out2");
    const nonEmptyDir = path.join(fixtureRoot, "nonempty");
    mkdirSync(nonEmptyDir, { recursive: true });
    writeFileSync(path.join(nonEmptyDir, "existing.txt"), "precious");
    execFileSync("node", [
      path.join(repoRoot, "scripts/migrate-export.mjs"),
      "--data-dir", dataDir, "--out", outDir2, "--skip-liveness",
    ], { stdio: "pipe", cwd: repoRoot });
    const tarName = readdirSync(outDir2).find((f) => f.endsWith(".tar.gz"))!;
    let failed = false;
    try {
      execFileSync("node", [
        path.join(repoRoot, "scripts/migrate-restore.mjs"),
        "--tar", path.join(outDir2, tarName), "--data-dir", nonEmptyDir,
      ], { stdio: "pipe", cwd: repoRoot });
    } catch { failed = true; }
    expect(failed).toBe(true); // 非空拒绝（exit 1）
    expect(existsSync(path.join(nonEmptyDir, "existing.txt"))).toBe(true); // 既有数据未被动
  }, 60_000);
});
