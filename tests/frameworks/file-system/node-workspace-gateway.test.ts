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

  // ── 相对 dataDir 回归（2026-08-26 故障复现：全量误报 Path traversal）──

  describe("相对 dataDir（app.ts 默认 ./data）", () => {
    let originalCwd: string;

    beforeEach(() => {
      originalCwd = process.cwd();
      process.chdir(tmpDir); // dataDir="./data" 相对于 cwd 解析
    });

    afterEach(() => {
      process.chdir(originalCwd);
    });

    it("writeFile/readFile/listDir 用相对 dataDir 正常工作", async () => {
      const relativeGw = new NodeWorkspaceGateway("./data");
      await relativeGw.ensureWorkspace(convId);
      await relativeGw.writeFile(convId, "probe.txt", "ok");
      expect(await relativeGw.readFile(convId, "probe.txt")).toBe("ok");
      const entries = await relativeGw.listDir(convId);
      expect(entries.map((e) => e.name)).toContain("probe.txt");
    });

    it("相对 dataDir 下 .. 穿越仍被拒绝", async () => {
      const relativeGw = new NodeWorkspaceGateway("./data");
      await relativeGw.ensureWorkspace(convId);
      await expect(relativeGw.readFile(convId, "../../../etc/passwd")).rejects.toThrow(
        "Path traversal",
      );
    });
  });

  // ── getWorkspacePath ──

  it("getWorkspacePath 返回正确路径", () => {
    expect(gw.getWorkspacePath(convId)).toBe(path.join(tmpDir, "workspaces", convId));
  });

  // ── deletePath（#1484 临时件回收）──

  describe("deletePath", () => {
    it("删除文件并返回 deleted=file", async () => {
      await gw.ensureWorkspace(convId);
      await gw.writeFile(convId, "tmp.txt", "junk");
      const result = await gw.deletePath(convId, "tmp.txt");
      expect(result).toEqual({ deleted: "file" });
      expect(await gw.exists(convId)).toBe(true); // 只删文件，不动工作区
      await expect(gw.readFile(convId, "tmp.txt")).rejects.toThrow();
    });

    it("删除空目录并返回 deleted=directory", async () => {
      await gw.ensureWorkspace(convId);
      await gw.writeFile(convId, "empty-dir/.keep", "x");
      await gw.deletePath(convId, "empty-dir/.keep");
      const result = await gw.deletePath(convId, "empty-dir");
      expect(result).toEqual({ deleted: "directory" });
    });

    it("非空目录默认拒绝删除（须 recursive=true）", async () => {
      await gw.ensureWorkspace(convId);
      await gw.writeFile(convId, "tree/a.txt", "a");
      await expect(gw.deletePath(convId, "tree")).rejects.toThrow("Directory not empty");
      // 防误删：文件仍在
      expect(await gw.readFile(convId, "tree/a.txt")).toBe("a");
    });

    it("recursive=true 整树删除非空目录", async () => {
      await gw.ensureWorkspace(convId);
      await gw.writeFile(convId, "tree/a.txt", "a");
      await gw.writeFile(convId, "tree/sub/b.txt", "b");
      const result = await gw.deletePath(convId, "tree", { recursive: true });
      expect(result).toEqual({ deleted: "directory" });
      await expect(gw.readFile(convId, "tree/a.txt")).rejects.toThrow();
    });

    it("拒绝删除工作区根（空路径 / .）", async () => {
      await gw.ensureWorkspace(convId);
      await gw.writeFile(convId, "keep.txt", "k");
      await expect(gw.deletePath(convId, "", { recursive: true })).rejects.toThrow("workspace root");
      await expect(gw.deletePath(convId, ".", { recursive: true })).rejects.toThrow("workspace root");
      expect(await gw.exists(convId)).toBe(true);
      expect(await gw.readFile(convId, "keep.txt")).toBe("k");
    });

    it("拒绝 .. 路径穿越", async () => {
      await gw.ensureWorkspace(convId);
      await expect(gw.deletePath(convId, "../../victim.txt", { recursive: true })).rejects.toThrow("Path traversal");
    });

    it("拒绝 symlink 逃逸目标的删除", async () => {
      await gw.ensureWorkspace(convId);
      const root = path.join(tmpDir, "workspaces", convId);
      await fs.writeFile(path.join(tmpDir, "victim.txt"), "victim");
      await fs.symlink(tmpDir, path.join(root, "escape"));
      await expect(gw.deletePath(convId, "escape/victim.txt")).rejects.toThrow("Symlink escape");
      // 外部文件安然无恙
      expect(await fs.readFile(path.join(tmpDir, "victim.txt"), "utf-8")).toBe("victim");
    });

    it("删除 symlink 链接本身（lstat 口径，不跟随目标）", async () => {
      await gw.ensureWorkspace(convId);
      const root = path.join(tmpDir, "workspaces", convId);
      await fs.writeFile(path.join(root, "real.txt"), "real");
      await fs.symlink(path.join(root, "real.txt"), path.join(root, "link.txt"));
      const result = await gw.deletePath(convId, "link.txt");
      expect(result).toEqual({ deleted: "file" });
      // 目标文件不受影响
      expect(await gw.readFile(convId, "real.txt")).toBe("real");
    });

    it("目标不存在时抛 ENOENT 类错误", async () => {
      await gw.ensureWorkspace(convId);
      await expect(gw.deletePath(convId, "ghost.txt")).rejects.toThrow();
    });

    it("recursive 整树删除时树内嵌套 symlink 不跟随目标（外部无恙，语义钉）", async () => {
      // 检视獭 2026-10-20 建议 1：fs.rm 不跟 symlink 是安全依赖但语义未锁——钉回归护栏
      await gw.ensureWorkspace(convId);
      const root = path.join(tmpDir, "workspaces", convId);
      await fs.writeFile(path.join(tmpDir, "outside.txt"), "outside");
      await fs.mkdir(path.join(root, "tree/sub"), { recursive: true });
      await fs.writeFile(path.join(root, "tree/sub/a.txt"), "a");
      // 文件型与目录型两种逃逸 symlink 各一（嵌套在树内，resolveSafe 不校验后代）
      await fs.symlink(path.join(tmpDir, "outside.txt"), path.join(root, "tree/sub/evil-file-link"));
      await fs.symlink(tmpDir, path.join(root, "tree/sub/evil-dir-link"));
      const result = await gw.deletePath(convId, "tree", { recursive: true });
      expect(result).toEqual({ deleted: "directory" });
      // 外部目标完好：递归删除不跟随 symlink
      expect(await fs.readFile(path.join(tmpDir, "outside.txt"), "utf-8")).toBe("outside");
      const outsideNames = await fs.readdir(tmpDir);
      expect(outsideNames).toContain("outside.txt");
      expect(outsideNames).toContain("workspaces");
      expect(outsideNames).toHaveLength(2); // tmpDir 未被目录型 symlink 反向吞删
    });
  });
});
