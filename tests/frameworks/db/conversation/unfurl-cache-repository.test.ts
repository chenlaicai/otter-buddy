import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { createTestDb } from "../../../helpers/db";
import { SqliteUnfurlCacheRepository, UNFURL_FAILED_TTL_MS, UNFURL_GITHUB_TTL_MS, githubFreshness, unfurlNowIso } from "../../../../src/frameworks/db/conversation/sqlite-unfurl-cache-repository";
import { createTestLogger } from "../../../helpers/logger";

/**
 * F20261013csv3 T1：unfurl_cache 缓存读写单测。
 * 锁定：①put/get round-trip 全字段；②TTL 三分支（og 永久 / failed 7 天 / github-api 24h SWR）；
 * ③getByUrls 批量投影（join 键口径）；④upsert 覆盖语义。
 */

const logger = createTestLogger();

let db: Database.Database;
let repo: SqliteUnfurlCacheRepository;

beforeEach(() => {
  db = createTestDb();
  repo = new SqliteUnfurlCacheRepository(db, logger);
});

afterEach(() => { db.close(); });

describe("unfurl_cache 读写", () => {
  it("put/get round-trip：全字段无损", () => {
    const row = {
      url: "https://example.com/a",
      title: "标题", description: "描述", image: "https://example.com/i.png",
      siteName: "站点", host: "example.com", source: "og" as const,
      state: null, additions: null, deletions: null,
      error: null, fetchedAt: unfurlNowIso(),
    };
    repo.put(row);
    const got = repo.get(row.url);
    expect(got.kind).toBe("hit");
    expect(got.row).toMatchObject({ title: "标题", host: "example.com", source: "og" });
  });

  it("github-api 记录：state/additions/deletions 结构化字段落库读出", () => {
    repo.put({
      url: "https://github.com/a/b/pull/1", title: "PR", description: null, image: null,
      siteName: "GitHub", host: "github.com", source: "github-api",
      state: "merged", additions: 42, deletions: 7, error: null, fetchedAt: unfurlNowIso(),
    });
    const got = repo.get("https://github.com/a/b/pull/1");
    expect(got.row).toMatchObject({ state: "merged", additions: 42, deletions: 7 });
  });

  it("upsert：同 URL 重复 put 覆盖旧值", () => {
    const url = "https://example.com/x";
    repo.put({ url, title: "旧", description: null, image: null, siteName: null, host: "example.com", source: "og", state: null, additions: null, deletions: null, error: null, fetchedAt: unfurlNowIso() });
    repo.put({ url, title: "新", description: null, image: null, siteName: null, host: "example.com", source: "og", state: null, additions: null, deletions: null, error: null, fetchedAt: unfurlNowIso() });
    expect(repo.get(url).row?.title).toBe("新");
  });

  it("getByUrls：批量投影 keyed by url；落空 URL 不在结果中", () => {
    repo.put({ url: "https://a.com/1", title: "A", description: null, image: null, siteName: null, host: "a.com", source: "og", state: null, additions: null, deletions: null, error: null, fetchedAt: unfurlNowIso() });
    repo.put({ url: "https://b.com/2", title: "B", description: null, image: null, siteName: null, host: "b.com", source: "og", state: null, additions: null, deletions: null, error: null, fetchedAt: unfurlNowIso() });
    const map = repo.getByUrls(["https://a.com/1", "https://b.com/2", "https://missing.com/3"]);
    expect(map.size).toBe(2);
    expect(map.get("https://a.com/1")?.title).toBe("A");
    expect(map.has("https://missing.com/3")).toBe(false);
  });

  it("getByUrls：过期 failed 记录不投影（等同未抓取）", () => {
    const url = "https://old-fail.com/";
    repo.put({
      url, title: null, description: null, image: null, siteName: null, host: "old-fail.com",
      source: "failed", state: null, additions: null, deletions: null, error: "boom",
      fetchedAt: new Date(Date.now() - UNFURL_FAILED_TTL_MS - 1000).toISOString(),
    });
    expect(repo.getByUrls([url]).size).toBe(0);
  });
});

describe("TTL 三分支", () => {
  it("og 永久缓存：任意旧时间仍命中", () => {
    repo.put({
      url: "https://old.com/", title: "旧文", description: null, image: null, siteName: null,
      host: "old.com", source: "og", state: null, additions: null, deletions: null, error: null,
      fetchedAt: new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString(),
    });
    expect(repo.get("https://old.com/").kind).toBe("hit");
  });

  it("failed 7 天窗口内 hit，窗口外 miss", () => {
    const url = "https://fail.com/";
    repo.put({
      url, title: null, description: null, image: null, siteName: null, host: "fail.com",
      source: "failed", state: null, additions: null, deletions: null, error: "x",
      fetchedAt: new Date(Date.now() - UNFURL_FAILED_TTL_MS + 1000).toISOString(),
    });
    expect(repo.get(url).kind).toBe("hit");
    repo.put({
      url, title: null, description: null, image: null, siteName: null, host: "fail.com",
      source: "failed", state: null, additions: null, deletions: null, error: "x",
      fetchedAt: new Date(Date.now() - UNFURL_FAILED_TTL_MS - 1000).toISOString(),
    });
    expect(repo.get(url).kind).toBe("miss");
  });

  it("github-api 24h 内 fresh，24h 外 stale（SWR 旧值可用）", () => {
    const url = "https://github.com/a/b/pull/9";
    repo.put({
      url, title: "PR", description: null, image: null, siteName: "GitHub", host: "github.com",
      source: "github-api", state: "open", additions: 1, deletions: 1, error: null,
      fetchedAt: new Date(Date.now() - UNFURL_GITHUB_TTL_MS + 1000).toISOString(),
    });
    expect(repo.get(url).kind).toBe("hit");
    repo.put({
      url, title: "PR-old", description: null, image: null, siteName: "GitHub", host: "github.com",
      source: "github-api", state: "open", additions: 1, deletions: 1, error: null,
      fetchedAt: new Date(Date.now() - UNFURL_GITHUB_TTL_MS - 1000).toISOString(),
    });
    const stale = repo.get(url);
    expect(stale.kind).toBe("stale");
    expect(stale.row?.title).toBe("PR-old"); // SWR：旧值仍返回
  });

  it("githubFreshness 纯函数：NaN → miss", () => {
    expect(githubFreshness("not-a-date")).toBe("miss");
    expect(githubFreshness(new Date().toISOString())).toBe("fresh");
    expect(githubFreshness(new Date(Date.now() - UNFURL_GITHUB_TTL_MS - 1).toISOString())).toBe("stale");
  });
});
