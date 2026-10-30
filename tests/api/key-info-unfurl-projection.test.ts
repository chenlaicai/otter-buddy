import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { createTestDb } from "../helpers/db";
import { createTestLogger } from "../helpers/logger";
import { KeyInfoController } from "../../src/interface-adapters/http/controllers/key-info-controller";
import { SqliteUnfurlCacheRepository, unfurlNowIso } from "../../src/frameworks/db/conversation/sqlite-unfurl-cache-repository";
import type { ManageKeyInfo } from "../../src/usecases/conversation/manage-key-info";
import type { LinkedResource } from "../../src/entities/conversation/conversation";
import { makeLinkedResource } from "./helpers";

/**
 * F20261030draft：key-info 读侧 unfurl join 投影端到端测试（检视 r1 建议 5-3）。
 * 锁定：①GET key-resources 响应携带 unfurl 投影（曾因 toKeyInfoDTO re-map 整体丢弃，
 * 检视 r1 处置中发现的同族断链——本测试即其回归锁）；②isDraft 三态（true/false/null）
 * 经 projectOne → toKeyInfoDTO → JSON 全链无损透传；③join 落空显式 null、无 url 不带键。
 */

const logger = createTestLogger();

let db: Database.Database;
let cache: SqliteUnfurlCacheRepository;

beforeEach(() => {
  db = createTestDb();
  cache = new SqliteUnfurlCacheRepository(db, logger);
});

afterEach(() => { db.close(); });

function makeCtx(conversationId: string) {
  return {
    req: { param: (k: string) => (k === "id" ? conversationId : undefined) },
    json: (body: unknown, status = 200) => ({ status, body }),
  } as unknown as import("hono").Context;
}

function seedCache(url: string, isDraft: boolean | null) {
  cache.put({
    url, title: "PR 标题", description: null, image: null, siteName: "GitHub", host: "github.com",
    source: "github-api", state: "OPEN", isDraft,
    additions: 1, deletions: 1, error: null, fetchedAt: unfurlNowIso(),
  });
}

function buildController(resources: LinkedResource[]): KeyInfoController {
  const manageKeyInfo = {
    getLinkedResources: vi.fn().mockResolvedValue(resources),
  } as unknown as ManageKeyInfo;
  return new KeyInfoController(manageKeyInfo, logger, cache);
}

describe("key-info unfurl join 投影（F20261030draft）", () => {
  it("GET key-resources 携带 unfurl 投影，isDraft 三态无损透传（true/false/null）", async () => {
    const urlTrue = "https://github.com/a/b/pull/1";
    const urlFalse = "https://github.com/a/b/pull/2";
    const urlNull = "https://github.com/a/b/pull/3";
    seedCache(urlTrue, true);
    seedCache(urlFalse, false);
    seedCache(urlNull, null);

    const ctrl = buildController([
      makeLinkedResource({ id: "lr-1", resourceType: "pr", url: urlTrue }) as unknown as LinkedResource,
      makeLinkedResource({ id: "lr-2", resourceType: "pr", url: urlFalse }) as unknown as LinkedResource,
      makeLinkedResource({ id: "lr-3", resourceType: "pr", url: urlNull }) as unknown as LinkedResource,
    ]);

    const res = await ctrl.getKeyResources(makeCtx("conv-1")) as unknown as { status: number; body: { resources: Array<Record<string, unknown>> } };
    expect(res.status).toBe(200);
    const [r1, r2, r3] = res.body.resources;
    // unfurl 投影未被 toKeyInfoDTO re-map 剥掉（检视 r1 处置发现的断链回归锁）
    expect(r1.unfurl).toMatchObject({ source: "github-api", state: "OPEN" });
    expect((r1.unfurl as { isDraft?: boolean | null }).isDraft).toBe(true);
    expect((r2.unfurl as { isDraft?: boolean | null }).isDraft).toBe(false);
    expect((r3.unfurl as { isDraft?: boolean | null }).isDraft).toBeNull();
  });

  it("join 落空显式 null（未抓取语义），无 url 资源不携带 unfurl 键", async () => {
    const noUrlFact = {
      ...makeLinkedResource({ id: "lr-2", resourceType: "fact" }),
      url: null, // makeLinkedResource 的 ?? 默认值会吞 null，此处显式覆写
    } as unknown as LinkedResource;
    const ctrl = buildController([
      makeLinkedResource({ id: "lr-1", resourceType: "pr", url: "https://github.com/a/b/pull/99" }) as unknown as LinkedResource,
      noUrlFact,
    ]);

    const res = await ctrl.getKeyResources(makeCtx("conv-1")) as unknown as { body: { resources: Array<Record<string, unknown>> } };
    const [r1, r2] = res.body.resources;
    expect(r1.unfurl).toBeNull();
    expect("unfurl" in r2).toBe(false);
  });
});
