/**
 * MatterController 只读端点测试（F20261006mtlp P1 + F20261006mlp2 P2 includeClosed）。
 *
 * P2 鉴别面：?includeClosed=1 返回含终态（折叠「近期闭环」区 = 翻案入口数据源）；
 * 默认只返回 open 清单。写路径不经 HTTP（P2 板上按钮 = 回执代执行通道 B）。
 */
import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { MatterController } from "@interface-adapters/http/controllers/matter-controller";
import type { MatterRepository } from "@usecases/matter/matter-repository";
import type { Matter } from "@entities/matter/matter";

const OPEN: Matter = {
  id: "aaaa1111-0000-4000-8000-000000000001",
  conversationId: "c1",
  title: "待裁决",
  originMessageId: null,
  ownerOtterId: "owner-1",
  level: "L2",
  state: "WAITING_PARTNER",
  waitingOn: "partner",
  waitingFor: "拍板",
  payload: null,
  resolution: null,
  resolvedBy: null,
  createdAt: "2026-10-06T00:00:00Z",
  updatedAt: "2026-10-06T00:00:00Z",
  closedAt: null,
};
const CLOSED: Matter = {
  ...OPEN,
  id: "bbbb2222-0000-4000-8000-000000000002",
  title: "已闭环",
  state: "CLOSED",
  resolution: "已处置",
  closedAt: "2026-10-06T01:00:00Z",
};

/** fake repo：openOnly 过滤复刻真实 SqliteMatterRepository 语义 */
function makeRepo(all: Matter[]): MatterRepository {
  return {
    create: async () => {},
    findById: async () => null,
    findByConversation: async (_c, filter) => {
      const rows = filter?.openOnly ? all.filter((m) => m.state !== "CLOSED" && m.state !== "SUPERSEDED" && m.state !== "ABANDONED") : all;
      return rows;
    },
    transition: async () => null,
    reopenForDissolvedOwner: async () => 0,
  } as MatterRepository;
}

const logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as never;

function buildApp(repo: MatterRepository) {
  const app = new Hono();
  const ctrl = new MatterController(repo, logger);
  app.get("/api/conversations/:id/matters", (c) => ctrl.listOpenByConversation(c));
  return app;
}

describe("MatterController.listOpenByConversation（P2 includeClosed）", () => {
  it("默认只返回 open 清单（P1 只读板数据源）", async () => {
    const app = buildApp(makeRepo([OPEN, CLOSED]));
    const res = await app.request("/api/conversations/c1/matters");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{ id: string }>;
    expect(body).toHaveLength(1);
    expect(body[0].id).toBe(OPEN.id);
  });

  it("?includeClosed=1 返回含终态（近期闭环区 = 翻案入口数据源）", async () => {
    const app = buildApp(makeRepo([OPEN, CLOSED]));
    const res = await app.request("/api/conversations/c1/matters?includeClosed=1");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{ id: string; state: string; resolution: string | null }>;
    expect(body).toHaveLength(2);
    const closed = body.find((m) => m.id === CLOSED.id);
    expect(closed).toBeDefined();
    expect(closed!.state).toBe("CLOSED");
    expect(closed!.resolution).toBe("已处置");
  });
});
