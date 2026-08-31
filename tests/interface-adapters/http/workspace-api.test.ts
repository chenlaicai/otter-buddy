/**
 * Workspace HTTP API 集成测试（PR #554 审视修复补齐）。
 *
 * 覆盖：
 * - S1 路径穿越：conversationId UUID 校验拒绝含路径分隔符/.. 的值
 * - S2 多字节截断：中文文件按字节截断且不破坏 UTF-8 边界
 * - S3 正常链路：listDir / readFile 核心路径
 * - 错误语义：工作区不存在 → 404（DomainError）而非 500
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { WorkspaceController } from "@interface-adapters/http/controllers/workspace-controller";
import { ManageWorkspace } from "@usecases/conversation/manage-workspace";
import { NodeWorkspaceGateway } from "@frameworks/file-system/node-workspace-gateway";
import { createTestLogger } from "../../helpers/logger";

/** 合法 conversationId 样本 */
const VALID_CONV_ID = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";

function createTestApp(dataDir: string): Hono {
  const gw = new NodeWorkspaceGateway(dataDir);
  const useCase = new ManageWorkspace(gw);
  const controller = new WorkspaceController(useCase, createTestLogger());

  const app = new Hono();
  app.get("/api/conversations/:id/workspace", (c) => controller.listDir(c));
  app.get("/api/conversations/:id/workspace/stats", (c) => controller.getStats(c));
  app.get("/api/conversations/:id/workspace/file", (c) => controller.readFile(c));
  return app;
}

describe("Workspace HTTP API", () => {
  let tmpDir: string;
  let app: Hono;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ws-api-test-"));
    app = createTestApp(tmpDir);
    // 创建工作区并写入测试文件
    const wsDir = path.join(tmpDir, "workspaces", VALID_CONV_ID);
    await fs.mkdir(wsDir, { recursive: true });
    await fs.writeFile(path.join(wsDir, "hello.txt"), "你好世界", "utf-8");
    await fs.mkdir(path.join(wsDir, "subdir"), { recursive: true });
    await fs.writeFile(path.join(wsDir, "subdir", "nested.txt"), "嵌套文件", "utf-8");
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  // ─── S1: 路径穿越防护 ───

  describe("conversationId 路径穿越防护（UUID 校验）", () => {
    it("含 .. 的 conversationId 拒绝 400", async () => {
      const res = await app.request(`/api/conversations/..%2F..%2Fetc/workspace`);
      expect(res.status).toBe(400);
      const body = await res.json() as { error: string };
      expect(body.error).toContain("conversationId");
    });

    it("含路径分隔符 / 的 conversationId 拒绝 400", async () => {
      const res = await app.request(`/api/conversations/foo/bar/workspace`);
      // Hono 路由 :id 不匹配含 / 的值，会 404 或走其他路由；验证不会 200
      expect(res.status).not.toBe(200);
    });

    it("非 UUID 格式的纯字母 conversationId 拒绝 400", async () => {
      const res = await app.request(`/api/conversations/not-a-uuid/workspace`);
      expect(res.status).toBe(400);
      const body = await res.json() as { error: string };
      expect(body.error).toContain("conversationId");
    });

    it("file 端点同样拒绝非法 conversationId", async () => {
      const res = await app.request(
        `/api/conversations/traversal-attack/workspace/file?path=hello.txt`,
      );
      expect(res.status).toBe(400);
    });

    it("合法 UUID conversationId 正常通过", async () => {
      const res = await app.request(`/api/conversations/${VALID_CONV_ID}/workspace`);
      expect(res.status).toBe(200);
      const body = await res.json() as { entries: Array<{ name: string }> };
      expect(body.entries.length).toBeGreaterThan(0);
    });
  });

  // ─── S2: 多字节截断 ───

  describe("多字节文件截断", () => {
    it("小文件不截断", async () => {
      const res = await app.request(
        `/api/conversations/${VALID_CONV_ID}/workspace/file?path=hello.txt`,
      );
      expect(res.status).toBe(200);
      const body = await res.json() as { content: string; truncated: boolean };
      expect(body.truncated).toBe(false);
      expect(body.content).toBe("你好世界");
    });

    it("大文件按字节截断且不破坏 UTF-8 边界", async () => {
      // 写入一个 ~150KB 的纯中文文件（每字符 3 字节 UTF-8）
      // 150KB ≈ 50,000 个中文字符
      const largeContent = "中".repeat(50000);
      const wsDir = path.join(tmpDir, "workspaces", VALID_CONV_ID);
      await fs.writeFile(path.join(wsDir, "large.txt"), largeContent, "utf-8");

      const res = await app.request(
        `/api/conversations/${VALID_CONV_ID}/workspace/file?path=large.txt`,
      );
      expect(res.status).toBe(200);
      const body = await res.json() as { content: string; truncated: boolean };
      expect(body.truncated).toBe(true);
      // 截断后内容应可正常解码（不包含乱码——即 U+FFFD 替换字符）
      expect(body.content).not.toContain("\uFFFD");
      // 截断后字节数应 ≤ 100KB + 截断提示文本
      const contentBytes = Buffer.byteLength(
        body.content.replace(/\n\n\.\.\. \[文件过大，已截断显示\]$/, ""),
        "utf-8",
      );
      expect(contentBytes).toBeLessThanOrEqual(100 * 1024);
      expect(contentBytes).toBeGreaterThan(0);
      // 提示文本存在
      expect(body.content).toContain("[文件过大，已截断显示]");
    });

    it("恰好 100KB 的文件不截断", async () => {
      // 100KB = 102400 字节；纯 ASCII 1字符=1字节
      const exactContent = "a".repeat(100 * 1024);
      const wsDir = path.join(tmpDir, "workspaces", VALID_CONV_ID);
      await fs.writeFile(path.join(wsDir, "exact.txt"), exactContent, "utf-8");

      const res = await app.request(
        `/api/conversations/${VALID_CONV_ID}/workspace/file?path=exact.txt`,
      );
      expect(res.status).toBe(200);
      const body = await res.json() as { truncated: boolean };
      expect(body.truncated).toBe(false);
    });
  });

  // ─── 正常链路 ───

  describe("正常 API 链路", () => {
    it("listDir 根目录返回条目", async () => {
      const res = await app.request(`/api/conversations/${VALID_CONV_ID}/workspace`);
      expect(res.status).toBe(200);
      const body = await res.json() as {
        entries: Array<{ name: string; isDirectory: boolean; isFile: boolean }>;
        basePath: string;
      };
      expect(body.basePath).toBe("");
      const names = body.entries.map((e) => e.name);
      expect(names).toContain("hello.txt");
      expect(names).toContain("subdir");
      // 验证 isDirectory/isFile 标记
      const subdir = body.entries.find((e) => e.name === "subdir")!;
      expect(subdir.isDirectory).toBe(true);
      const helloFile = body.entries.find((e) => e.name === "hello.txt")!;
      expect(helloFile.isFile).toBe(true);
    });

    it("listDir 子目录", async () => {
      const res = await app.request(
        `/api/conversations/${VALID_CONV_ID}/workspace?path=subdir`,
      );
      expect(res.status).toBe(200);
      const body = await res.json() as { entries: Array<{ name: string }> };
      expect(body.entries.map((e) => e.name)).toContain("nested.txt");
    });

    it("readFile 不存在的文件抛异常（经 handleError 处理）", async () => {
      const res = await app.request(
        `/api/conversations/${VALID_CONV_ID}/workspace/file?path=nonexistent.txt`,
      );
      // 文件不存在应报错（可能是 500 或其他错误码，取决于 gateway 实现）
      expect(res.status).toBeGreaterThanOrEqual(400);
    });

    it("readFile 缺少 path 参数返回 400", async () => {
      const res = await app.request(
        `/api/conversations/${VALID_CONV_ID}/workspace/file`,
      );
      expect(res.status).toBe(400);
      const body = await res.json() as { error: string };
      expect(body.error).toContain("path");
    });

    it("listDir 不存在的工作区返回空数组", async () => {
      // 使用一个合法 UUID 但没有创建工作区的 conversationId
      const noWsId = "00000000-0000-4000-8000-000000000000";
      const res = await app.request(`/api/conversations/${noWsId}/workspace`);
      expect(res.status).toBe(200);
      const body = await res.json() as { entries: unknown[] };
      expect(body.entries).toEqual([]);
    });

    it("readFile 不存在的工作区返回 404（DomainError 映射）", async () => {
      const noWsId = "00000000-0000-4000-8000-000000000001";
      const res = await app.request(
        `/api/conversations/${noWsId}/workspace/file?path=any.txt`,
      );
      expect(res.status).toBe(404);
    });

    it("stats 返回正确的文件数和总大小", async () => {
      // 写入额外文件以测试大小统计
      const wsDir = path.join(tmpDir, "workspaces", VALID_CONV_ID);
      await fs.writeFile(path.join(wsDir, "big.bin"), "x".repeat(5000), "utf-8");

      const res = await app.request(
        `/api/conversations/${VALID_CONV_ID}/workspace/stats`,
      );
      expect(res.status).toBe(200);
      const body = await res.json() as {
        fileCount: number;
        totalSize: number;
        topFiles: Array<{ path: string; size: number }>;
      };
      // 3 个文件：hello.txt(12字节，"你好世界"=4中文×3字节), subdir/nested.txt(12字节), big.bin(5000字节)
      expect(body.fileCount).toBe(3);
      expect(body.totalSize).toBe(12 + 12 + 5000);
      // topFiles 按大小降序
      expect(body.topFiles[0].path).toBe("big.bin");
      expect(body.topFiles[0].size).toBe(5000);
    });

    it("stats 空工作区返回零值", async () => {
      const emptyWsId = "00000000-0000-4000-8000-000000000002";
      const wsDir = path.join(tmpDir, "workspaces", emptyWsId);
      await fs.mkdir(wsDir, { recursive: true });

      const res = await app.request(
        `/api/conversations/${emptyWsId}/workspace/stats`,
      );
      expect(res.status).toBe(200);
      const body = await res.json() as { fileCount: number; totalSize: number; topFiles: unknown[] };
      expect(body.fileCount).toBe(0);
      expect(body.totalSize).toBe(0);
      expect(body.topFiles).toEqual([]);
    });

    it("stats 不存在的工作区返回零值", async () => {
      const noWsId = "00000000-0000-4000-8000-000000000003";
      const res = await app.request(
        `/api/conversations/${noWsId}/workspace/stats`,
      );
      expect(res.status).toBe(200);
      const body = await res.json() as { fileCount: number };
      expect(body.fileCount).toBe(0);
    });

    it("stats top 参数限制返回文件数", async () => {
      const res = await app.request(
        `/api/conversations/${VALID_CONV_ID}/workspace/stats?top=1`,
      );
      expect(res.status).toBe(200);
      const body = await res.json() as { topFiles: unknown[] };
      expect(body.topFiles.length).toBe(1);
    });

    it("stats top=0 返回零个 topFiles", async () => {
      const res = await app.request(
        `/api/conversations/${VALID_CONV_ID}/workspace/stats?top=0`,
      );
      expect(res.status).toBe(200);
      const body = await res.json() as { topFiles: unknown[] };
      expect(body.topFiles).toEqual([]);
    });

    it("stats top=-1 被 clamp 为 0 返回零个 topFiles", async () => {
      const res = await app.request(
        `/api/conversations/${VALID_CONV_ID}/workspace/stats?top=-1`,
      );
      expect(res.status).toBe(200);
      const body = await res.json() as { topFiles: unknown[] };
      expect(body.topFiles).toEqual([]);
    });

    it("stats top=51 被 clamp 为 50 返回全部文件", async () => {
      const res = await app.request(
        `/api/conversations/${VALID_CONV_ID}/workspace/stats?top=51`,
      );
      expect(res.status).toBe(200);
      const body = await res.json() as { fileCount: number; topFiles: unknown[] };
      // 2 个文件（hello.txt, subdir/nested.txt），topFiles 应返回全部
      expect(body.topFiles.length).toBe(body.fileCount);
    });

    it("stats 非法 conversationId 拒绝 400", async () => {
      const res = await app.request(`/api/conversations/bad-id/workspace/stats`);
      expect(res.status).toBe(400);
    });
  });
});
