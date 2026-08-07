import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { NodeWorkspaceGateway } from "@frameworks/file-system/node-workspace-gateway";

describe("NodeWorkspaceGateway", () => {
  let tmpDir: string;
  let gw: NodeWorkspaceGateway;
  const convId = "test-conv-001";

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ws-test-"));
    gw = new NodeWorkspaceGateway(tmpDir);
    // 每个测试用独立 workspaces 目录，避免残留
    await fs.rm(path.join(tmpDir, "workspaces"), { recursive: true, force: true });
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  // ── ensureWorkspace ──

  it("ensureWorkspace 创建目录并返回绝对路径", async () => {
    const result = await gw.ensureWorkspace(convId);
    expect(result).toBe(path.join(tmpDir, "workspaces", convId));
    const stat = await fs.stat(result);
    expect(stat.isDirectory()).toBe(true);
  });

  it("ensureWorkspace 幂等：重复调用不报错", async () => {
    await gw.ensureWorkspace(convId);
    await expect(gw.ensureWorkspace(convId)).resolves.toBeDefined();
  });

  // ── exists ──

  it("exists 返回 false（目录不存在）", async () => {
    expect(await gw.exists("nonexistent")).toBe(false);
  });

  it("exists 返回 true（目录存在）", async () => {
    await gw.ensureWorkspace(convId);
    expect(await gw.exists(convId)).toBe(true);
  });

  // ── removeWorkspace ──

  it("removeWorkspace 删除目录", async () => {
    await gw.ensureWorkspace(convId);
    await gw.removeWorkspace(convId);
    expect(await gw.exists(convId)).toBe(false);
  });

  it("removeWorkspace 幂等：目录不存在时不报错", async () => {
    await expect(gw.removeWorkspace("nonexistent")).resolves.toBeUndefined();
  });

  // ── writeFile / readFile ──

  it("writeFile + readFile 基本读写", async () => {
    await gw.ensureWorkspace(convId);
    await gw.writeFile(convId, "report.md", "# Hello");
    const content = await gw.readFile(convId, "report.md");
    expect(content).toBe("# Hello");
  });

  it("writeFile 自动创建中间目录", async () => {
    await gw.ensureWorkspace(convId);
    await gw.writeFile(convId, "a/b/c.txt", "nested");
    const content = await gw.readFile(convId, "a/b/c.txt");
    expect(content).toBe("nested");
  });

  it("writeFile 超过 1MB 限制时抛错", async () => {
    await gw.ensureWorkspace(convId);
    const big = "x".repeat(1024 * 1024 + 1);
    await expect(gw.writeFile(convId, "big.txt", big)).rejects.toThrow("Content too large");
  });

  it("readFile 超过 1MB 限制时抛错", async () => {
    await gw.ensureWorkspace(convId);
    const root = path.join(tmpDir, "workspaces", convId);
    await fs.writeFile(path.join(root, "big.txt"), "x".repeat(1024 * 1024 + 1));
    await expect(gw.readFile(convId, "big.txt")).rejects.toThrow("File too large");
  });

  // ── 路径穿越防护 ──

  it("readFile 拒绝 .. 路径穿越", async () => {
    await gw.ensureWorkspace(convId);
    await expect(gw.readFile(convId, "../../../etc/passwd")).rejects.toThrow("Path traversal");
  });

  it("writeFile 拒绝 .. 路径穿越", async () => {
    await gw.ensureWorkspace(convId);
    await expect(gw.writeFile(convId, "../../../tmp/evil.txt", "bad")).rejects.toThrow("Path traversal");
  });

  it("listDir 拒绝 .. 路径穿越", async () => {
    await gw.ensureWorkspace(convId);
    await expect(gw.listDir(convId, "../..")).rejects.toThrow("Path traversal");
  });

  // ── symlink 逃逸防护 ──

  it("readFile 拒绝 symlink 逃逸", async () => {
    await gw.ensureWorkspace(convId);
    const root = path.join(tmpDir, "workspaces", convId);
    // 创建目标文件 + symlink 指向外部目录
    await fs.writeFile(path.join(tmpDir, "secret.txt"), "secret");
    await fs.symlink(tmpDir, path.join(root, "escape"));
    await expect(gw.readFile(convId, "escape/secret.txt")).rejects.toThrow("Symlink escape");
  });

  // ── listDir ──

  it("listDir 返回文件和目录列表", async () => {
    await gw.ensureWorkspace(convId);
    await gw.writeFile(convId, "a.txt", "file a");
    await gw.writeFile(convId, "sub/b.txt", "file b");
    const entries = await gw.listDir(convId);
    const names = entries.map((e) => e.name);
    expect(names).toContain("a.txt");
    expect(names).toContain("sub");
  });

  // ── getWorkspacePath ──

  it("getWorkspacePath 返回正确路径", () => {
    expect(gw.getWorkspacePath(convId)).toBe(path.join(tmpDir, "workspaces", convId));
  });
});
