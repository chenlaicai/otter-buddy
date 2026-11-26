/**
 * 回归：SSE/流式响应关闭竞态致进程崩溃（undici ReadableStream already closed）。
 *
 * 根因：GET /api/attachments/:id 曾把 Node fs.ReadStream（async iterable）以类型
 * 欺骗喂给 new Response()——undici extractBody 落入 ReadableStreamFrom 包装
 * （node v24 deps/undici/undici.js:1562-1590）：pull 的 iterator.next() resolve
 * done 后 queueMicrotask(controller.close())；客户端断开（@hono/node-server
 * writable close → reader.cancel()）恰落在 pull pending 窗口内时，close 落在已
 * cancel 的 controller 上抛 ERR_INVALID_STATE → uncaughtException → 进程退出。
 *
 * 三层验证：
 * 1. 确定性竞态（子进程真 @hono/node-server + 受控流）：legacy 形态必须崩
 *    （元验证：攻击手段真实有效 = 修复前失败证据的固化）；fixed 形态
 *    （Readable.toWeb → undici 直接透传）必须存活。
 * 2. 真实 AttachmentController.getById + 真实 fs 文件 + 客户端中途 abort：
 *    服务器进程内零 uncaughtException（进程内临时接管计数）。
 * 3. 正常下载完整性：abort 攻击后的下一次请求仍可完整下载（服务未损）。
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Hono } from "hono";
import Database from "better-sqlite3";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { createTestDb } from "../../helpers/db";
import { createTestLogger } from "../../helpers/logger";
import { SqliteAttachmentRepository } from "@frameworks/db/attachment/sqlite-attachment-repository";
import { SqliteConversationRepository } from "@frameworks/db/conversation/sqlite-conversation-repository";
import { AttachmentUploadService } from "@usecases/conversation/attachment-upload-service";
import { AttachmentController } from "@interface-adapters/http/controllers/attachment-controller";
import type { Conversation } from "@entities/conversation/conversation";

const FIXTURE = fileURLToPath(new URL("./fixtures/stream-race-server.mjs", import.meta.url));

interface ChildResult { code: number | null; stderr: string; stdout: string }

/** 起子进程 fixture，执行一次「读 chunk1 → abort → 等 EOF」攻击，收集退出结果 */
async function runRaceAttack(port: number, route: string): Promise<ChildResult> {
  const child = spawn(process.execPath, [FIXTURE], {
    env: { ...process.env, RACE_PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "", stderr = "";
  child.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
  child.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });

  // 等 READY
  const readyDeadline = Date.now() + 10_000;
  while (!stdout.includes("READY") && Date.now() < readyDeadline) {
    await new Promise(r => setTimeout(r, 50));
  }
  if (!stdout.includes("READY")) throw new Error(`fixture not ready: ${stdout}${stderr}`);

  try {
    const res = await fetch(`http://127.0.0.1:${port}${route}`);
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    const first = await reader.read();
    expect(first.value?.length).toBeGreaterThan(0);
    // 客户端断开（触发 @hono/node-server writable close → reader.cancel）
    await reader.cancel(new Error("client aborted"));
  } catch {
    /* 客户端侧异常不影响判定——服务器侧结果才是断言对象 */
  }

  // 等子进程自然退出（legacy: exit 42 / fixed: 需主动杀 → 见调用方）
  const result = await new Promise<ChildResult>((resolve) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve({ code: null, stderr, stdout });
    }, 3_000);
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve({ code, stderr, stdout });
    });
  });
  child.kill("SIGKILL");
  return result;
}

describe("流式响应关闭竞态（undici ReadableStream already closed）", () => {
  it("元验证（红基线）：legacy 形态 new Response(nodeStream) 在竞态下必须崩", { timeout: 20_000 }, async () => {
    const r = await runRaceAttack(3987, "/legacy");
    // 修复前失败证据固化：legacy 形态命中 ERR_INVALID_STATE → exit(42)
    expect(r.code).toBe(42);
    expect(r.stderr).toContain("ERR_INVALID_STATE");
  });

  it("修复面：Readable.toWeb() 形态在同竞态时序下存活", { timeout: 20_000 }, async () => {
    const r = await runRaceAttack(3987, "/fixed");
    // 未因竞态自杀（code=null 表示 3s 内未退出、被测试 SIGKILL——存活）
    expect(r.code).not.toBe(42);
    expect(r.stderr).not.toContain("ERR_INVALID_STATE");
  });
});

describe("真实 AttachmentController.getById 断开攻击", () => {
  let db: Database.Database;
  let attachmentRepo: SqliteAttachmentRepository;
  let tmpRoot: string;
  let attachmentId: string;
  let server: ReturnType<typeof serve> | undefined;
  const port = 3988;
  const uncaught: Error[] = [];
  const uncaughtHandler = (e: Error): void => { uncaught.push(e); };

  beforeAll(async () => {
    process.on("uncaughtException", uncaughtHandler);
    db = createTestDb();
    attachmentRepo = new SqliteAttachmentRepository(db);
    const convRepo = new SqliteConversationRepository(db, createTestLogger());
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "att-race-"));
    const uploadService = new AttachmentUploadService(
      attachmentRepo,
      { storageRoot: tmpRoot, maxImageBytes: 1024 * 1024, maxDocumentBytes: 16 * 1024 * 1024 },
      createTestLogger(),
    );
    const controller = new AttachmentController(uploadService, attachmentRepo, tmpRoot, createTestLogger(), convRepo);

    const conv: Conversation = {
      id: "conv-1", title: "t", status: "active", summary: null, pinned: false, kind: "normal", workspaceDir: null,
      createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", completedAt: null, archivedAt: null,
    };
    await convRepo.create(conv);

    // 种子：8MB 文档（多次 pull + 断开窗口）
    const big = Buffer.alloc(8 * 1024 * 1024, 7);
    const uploaded = await uploadService.upload({
      stream: bufferToNode(big),
      originalName: "big.txt",
      declaredMimeType: "text/plain",
      uploaderId: "u1",
    });
    attachmentId = uploaded.id;

    const app = new Hono();
    app.get("/api/attachments/:id", (c) => controller.getById(c));
    await new Promise<void>(resolve => {
      server = serve({ fetch: app.fetch, port, hostname: "127.0.0.1" }, () => resolve());
    });
  });

  afterAll(async () => {
    process.off("uncaughtException", uncaughtHandler);
    if (server) {
      await new Promise<void>(resolve => server!.close(() => resolve()));
    }
    if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true });
    db?.close();
  });

  it("客户端中途 abort 不产生 uncaughtException，服务器存活", { timeout: 15_000 }, async () => {
    uncaught.length = 0;
    for (let i = 0; i < 3; i++) {
      const controller = new AbortController();
      const res = await fetch(`http://127.0.0.1:${port}/api/attachments/${attachmentId}`, { signal: controller.signal });
      expect(res.status).toBe(200);
      const reader = res.body!.getReader();
      const first = await reader.read();
      expect(first.value?.length).toBeGreaterThan(0);
      controller.abort(new Error("client cancelled"));
      // 留出 EOF/清理尾部到达的时间
      await new Promise(r => setTimeout(r, 150));
    }
    // 竞态残余微任务落定后再断言
    await new Promise(r => setTimeout(r, 300));
    expect(uncaught).toHaveLength(0);
  });

  it("攻击后服务未损：完整下载仍可读全 8MB", { timeout: 15_000 }, async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/attachments/${attachmentId}`);
    expect(res.status).toBe(200);
    const buf = Buffer.from(await res.arrayBuffer());
    expect(buf.length).toBe(8 * 1024 * 1024);
  });
});

/** Buffer → Node Readable（上传种子构造用） */
function bufferToNode(buf: Buffer) {
  return Readable.from([buf]);
}
