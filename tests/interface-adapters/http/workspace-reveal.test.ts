/**
 * Workspace Reveal 端点集成测试。
 *
 * 覆盖 POST /api/conversations/:id/workspace/reveal：
 * - 合法路径（文件、子目录、目录）→ 200
 * - 路径校验（绝对路径、..逃逸、缺参数）→ 400
 * - 不存在的文件/工作区 → 404
 * - conversationId UUID 校验
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

const VALID_CONV_ID = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";

function createTestApp(dataDir: string): Hono {
  const gw = new NodeWorkspaceGateway(dataDir);
  const useCase = new ManageWorkspace(gw, createTestLogger());
  const controller = new WorkspaceController(useCase, createTestLogger());

  const app = new Hono();
  app.post("/api/conversations/:id/workspace/reveal", (c) => controller.reveal(c));
  return app;
}

let tmpDir: string;
let app: Hono;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ws-reveal-test-"));
  app = createTestApp(tmpDir);
  const wsDir = path.join(tmpDir, "workspaces", VALID_CONV_ID);
  await fs.mkdir(wsDir, { recursive: true });
  await fs.writeFile(path.join(wsDir, "hello.txt"), "你好世界", "utf-8");
  await fs.mkdir(path.join(wsDir, "subdir"), { recursive: true });
  await fs.writeFile(path.join(wsDir, "subdir", "nested.txt"), "嵌套文件", "utf-8");
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("POST /api/conversations/:id/workspace/reveal", () => {
  it("合法文件路径返回 200 + { ok: true }", async () => {
    const res = await app.request(
      `/api/conversations/${VALID_CONV_ID}/workspace/reveal`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: "hello.txt" }),
      },
    );
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean };
    expect(body.ok).toBe(true);
  });

  it("子目录文件路径返回 200", async () => {
    const res = await app.request(
      `/api/conversations/${VALID_CONV_ID}/workspace/reveal`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: "subdir/nested.txt" }),
      },
    );
    expect(res.status).toBe(200);
  });

  it("目录路径返回 200（macOS open -R 支持目录）", async () => {
    const res = await app.request(
      `/api/conversations/${VALID_CONV_ID}/workspace/reveal`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: "subdir" }),
      },
    );
    expect(res.status).toBe(200);
  });

  it("不存在的文件返回 404", async () => {
    const res = await app.request(
      `/api/conversations/${VALID_CONV_ID}/workspace/reveal`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: "nonexistent.txt" }),
      },
    );
    expect(res.status).toBe(404);
  });

  it("绝对路径拒绝 400", async () => {
    const res = await app.request(
      `/api/conversations/${VALID_CONV_ID}/workspace/reveal`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: "/etc/passwd" }),
      },
    );
    expect(res.status).toBe(400);
  });

  it("含 .. 的路径拒绝 400", async () => {
    const res = await app.request(
      `/api/conversations/${VALID_CONV_ID}/workspace/reveal`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: "../../../etc/passwd" }),
      },
    );
    expect(res.status).toBe(400);
  });

  it("缺少 path 参数返回 400", async () => {
    const res = await app.request(
      `/api/conversations/${VALID_CONV_ID}/workspace/reveal`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      },
    );
    expect(res.status).toBe(400);
  });

  it("非 UUID conversationId 拒绝 400", async () => {
    const res = await app.request(
      `/api/conversations/bad-id/workspace/reveal`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: "hello.txt" }),
      },
    );
    expect(res.status).toBe(400);
  });

  it("不存在的工作区返回 404", async () => {
    const noWsId = "00000000-0000-4000-8000-000000000010";
    const res = await app.request(
      `/api/conversations/${noWsId}/workspace/reveal`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: "hello.txt" }),
      },
    );
    expect(res.status).toBe(404);
  });

  it("非法 JSON body 返回 400（非 500）", async () => {
    const res = await app.request(
      `/api/conversations/${VALID_CONV_ID}/workspace/reveal`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "not-json{{",
      },
    );
    // Why: 非法 JSON 应走 catch(() => ({})) → path 缺失 → 400，不泄漏 V8 解析器错误
    expect(res.status).toBe(400);
  });
});
