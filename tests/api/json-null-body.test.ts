/**
 * #891：13 个裸 req.json() 端点 JSON null body 回归测试。
 *
 * 背景：#889 修复了 catch 模式三处，PR #890 审视全仓扫描发现另有 13 处
 * 裸 `c.req.json()` 无任何防御——body 为合法 JSON `null` 时解引用崩 500
 * 并回显 V8 内部错误文本。本文件对全部 13 个端点实测 `body: "null"` 不再 500。
 *
 * 断言原则：不焊死具体业务状态码（各端点 null 语义不同），只断言「不 500」
 * ——本 issue 修的是崩溃与信息泄漏，业务校验语义保持不变。
 */

import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { Hono } from "hono";
import { initSchema } from "@frameworks/db/schema";
import { SqliteConnectionRepository } from "@frameworks/db/im/sqlite-connection-repository";
import { SqliteConversationRepository } from "@frameworks/db/conversation/sqlite-conversation-repository";
import { SqliteEntryRepository } from "@frameworks/db/conversation/sqlite-entry-repository";
import { SqliteInvokeRepository } from "@frameworks/db/conversation/sqlite-invoke-repository";
import { ManageConnection } from "@usecases/im/manage-connection";
import { ConnectionController } from "@interface-adapters/http/controllers/connection-controller";
import { createTestLogger } from "../helpers/logger";
import { createTestApp, createMockDeps, makeConversation, makeOtter, makeLinkedResource, makeScheduledTask } from "./helpers";
import { DomainError } from "../../src/entities/errors";
import { SqliteOtterRepository } from "@frameworks/db/otter/sqlite-otter-repository";
import { CreateOtter } from "@usecases/otter/create-otter";
import { ManageConversation } from "@usecases/conversation/manage-conversation";
import { ManageParticipant } from "@usecases/conversation/manage-participant";
import { OtterController } from "@interface-adapters/http/controllers/otter-controller";
import { ConversationController } from "@interface-adapters/http/controllers/conversation-controller";
import { fakeAgentGateway } from "../helpers/agent-gateway.fake";
import type { TestDeps } from "./helpers";

describe("#891: JSON null body 不崩 500（13 端点回归）", () => {
  let deps: TestDeps;
  let app: ReturnType<typeof createTestApp>;

  beforeEach(() => {
    deps = createMockDeps();
    app = createTestApp(deps);
  });

  /**
   * 各端点 null body → {} 后流入 mock usecase，部分 mock 返回 undefined
   * 会在 controller 后续渲染链崩出与 null body 无关的假 500。
   * 此处补齐最小 mock 形状，让断言只检验「null body 不再崩」这一件事。
   */
  function setupMocks() {
    deps.manageConversation.create.mockResolvedValue(makeConversation({ id: "conv-1" }));
    deps.manageParticipant.getActiveParticipants.mockResolvedValue([]);
    deps.createOtterUseCase.execute.mockResolvedValue(makeOtter({ id: "otter-1" }));
    deps.searchMemory.searchSimilar.mockResolvedValue({ entries: [], total: 0 });
    deps.manageKeyInfo.linkResource.mockResolvedValue(makeLinkedResource({ id: "lr-1" }));
    // scheduled-task：controller 拿 usecase 返回的 task 过 getNextTriggerAt（读 scheduleType），
    // mock 必须给完整 task 形状——但真实 usecase 对空 input 会先抛 validation（400），
    // 更符合真实的 mock 是直接抛 DomainError（null body → {} → validation 失败）
    deps.manageScheduledTask.create.mockRejectedValue(
      new DomainError("cron is required for scheduleType=cron", "validation"),
    );
    deps.manageScheduledTask.getById.mockResolvedValue(makeScheduledTask({ id: "task-1" }));
    deps.manageScheduledTask.update.mockResolvedValue(makeScheduledTask({ id: "task-1" }));
    // controller getNextTriggerAt 会调 cronParser.getNextTime(...).toISOString()，mock 需返 Date
    deps.cronParser.getNextTime.mockReturnValue(new Date("2026-09-11T09:00:00Z"));
  }
  beforeEach(setupMocks);

  const nullBody = {
    headers: { "Content-Type": "application/json" },
    body: "null",
  } as const;

  it("POST /api/conversations（conversation-controller:53）", async () => {
    // 对抗审视发现 2：mock usecase 会掩盖真实 NOT NULL 崩溃——走真实 sqlite 链路
    const res = await createRealApp().request("/api/conversations", { method: "POST", ...nullBody });
    expect(res.status).toBe(400);
  });

  it("PUT /api/settings（settings-controller:51）", async () => {
    const res = await app.request("/api/settings", { method: "PUT", ...nullBody });
    expect(res.status).not.toBe(500);
  });

  it("POST /api/otters（otter-controller:53）", async () => {
    // 对抗审视发现 1：同发现 2，mock 掩盖 NOT NULL 崩溃——走真实 sqlite 链路
    const res = await createRealApp().request("/api/otters", { method: "POST", ...nullBody });
    expect(res.status).toBe(400);
  });

  it("POST /api/conversations/:id/messages（message-controller:171）", async () => {
    const res = await app.request("/api/conversations/conv-1/messages", { method: "POST", ...nullBody });
    // controller 前置校验 senderId 缺失 → 400（审视走查确认）
    expect(res.status).toBe(400);
  });

  it("POST /api/conversations/:id/read（message-controller:649）", async () => {
    const res = await app.request("/api/conversations/conv-1/read", { method: "POST", ...nullBody });
    // controller typeof messageSeq 校验 → 400（审视走查确认）
    expect(res.status).toBe(400);
  });

  it("POST /api/memory/search/similar（memory-controller:130）", async () => {
    const res = await app.request("/api/memory/search/similar", { method: "POST", ...nullBody });
    expect(res.status).not.toBe(500);
  });

  it("PATCH /api/memory/:id/flag（memory-controller:210）", async () => {
    const res = await app.request("/api/memory/mem-1/flag", { method: "PATCH", ...nullBody });
    expect(res.status).not.toBe(500);
  });

  it("POST /api/conversations/:id/resources（key-info-controller:29）", async () => {
    const res = await app.request("/api/conversations/conv-1/resources", { method: "POST", ...nullBody });
    // 真实 usecase：validateInput 的 `!== 'fact' && !url` 会拦空 input → 400；
    // 但 helpers mock 的 linkResource 直接返成功（201），mock 路径下只能证「不 500」
    expect(res.status).not.toBe(500);
  });

  it("PATCH /api/resources/:resourceId/flag（key-info-controller:53）", async () => {
    const res = await app.request("/api/resources/lr-1/flag", { method: "PATCH", ...nullBody });
    expect(res.status).not.toBe(500);
  });

  it("POST /api/conversations/:id/scheduled-tasks（scheduled-task-controller:35）", async () => {
    const res = await app.request("/api/conversations/conv-1/scheduled-tasks", { method: "POST", ...nullBody });
    // 已知走真实 validation 路径（空 input 缺 cron）→ 断言 400，防 mock 假绿（审视建议 1）
    expect(res.status).toBe(400);
  });

  it("PATCH /api/scheduled-tasks/:taskId（scheduled-task-controller:90）", async () => {
    const res = await app.request("/api/scheduled-tasks/task-1", { method: "PATCH", ...nullBody });
    expect(res.status).not.toBe(500);
  });

  it("POST /api/connections（connection-controller:29）", async () => {
    const res = await createConnectionApp().request("/api/connections", { method: "POST", ...nullBody });
    // entity typeof 守卫 → usecase validation → 400
    expect(res.status).toBe(400);
  });

  it("POST /api/connections/:id/enter（connection-controller:66）", async () => {
    const res = await createConnectionApp().request("/api/connections/conn-1/enter", { method: "POST", ...nullBody });
    // conn-1 不存在 → not_found → 404（先于 body 消费）
    expect(res.status).toBe(404);
  });
});

/** connection 两端点：helpers 的 createTestApp 用 stub，参照 connection.test.ts 独立建真实 app */
function createConnectionApp(): Hono {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  initSchema(db);
  const manageConnection = new ManageConnection(
    new SqliteConnectionRepository(db),
    new SqliteConversationRepository(db),
    createTestLogger() as never,
  );
  const ctrl = new ConnectionController(manageConnection, createTestLogger() as never);
  const app = new Hono();
  app.post("/api/connections", (c) => ctrl.create(c));
  app.post("/api/connections/:id/enter", (c) => ctrl.enterConversation(c));
  return app;
}

/**
 * otter/conversation 两端点：mock usecase 会掩盖真实 NOT NULL 崩溃（对抗审视发现 1/2）——
 * 真实 sqlite repo + 真实 usecase + 真实 controller，仅 agent 层用 fakeAgentGateway seam。
 * settingsRepo 仅 read 路径使用，create null body 路径不触达，最小 stub。
 */
function createRealApp(): Hono {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  initSchema(db);
  const otterRepo = new SqliteOtterRepository(db);
  const convRepo = new SqliteConversationRepository(db);
  const logger = createTestLogger() as never;
  const createOtter = new CreateOtter(otterRepo, fakeAgentGateway(), logger);
  const manageConversation = new ManageConversation(convRepo, createOtter);
  // F20260913ctlv 批4c：entryDeps 必注入（messages 降级路径已删）
  const manageParticipant = new ManageParticipant(convRepo, otterRepo, {
    entryRepo: new SqliteEntryRepository(db),
    invokeRepo: new SqliteInvokeRepository(db),
  });
  const settingsStub = { get: async () => null, set: async () => {} } as never;

  const app = new Hono();
  const otterCtrl = new OtterController(
    createOtter,
    { execute: async () => {} } as never,
    {} as never,
    { getById: async () => null } as never,
    logger,
  );
  app.post("/api/otters", (c) => otterCtrl.create(c));
  const convCtrl = new ConversationController(manageConversation, manageParticipant, settingsStub, logger);
  app.post("/api/conversations", (c) => convCtrl.create(c));
  return app;
}
