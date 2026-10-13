import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { createTestDb } from "../helpers/db";
import { UnfurlController } from "../../src/interface-adapters/http/controllers/unfurl-controller";
import { SqliteUnfurlCacheRepository, UNFURL_FAILED_TTL_MS } from "../../src/frameworks/db/conversation/sqlite-unfurl-cache-repository";
import { parseGithubUrl } from "../../src/interface-adapters/http/controllers/github-unfurl";
import { createTestLogger } from "../helpers/logger";

/**
 * F20261013csv3 T1：unfurl 三态控制器集成测试。
 * 锁定行为：①缓存命中 ok；②无记录 → pending + 后台抓取补位（og 元数据提取归一化）；
 * ③失败落 failed 记录（7 天窗口显式返回，过期重新抓取）；④github-api SWR（24h 内 fresh，
 * 过期 stale 先返旧值 + 后台刷新）；⑤恶意 URL 注入（内网段/十六进制/IPv6-mapped/flag 注入）。
 * fetch 全局 stub：不触真实网络（测试无外部依赖原则）。
 */

const logger = createTestLogger();

let db: Database.Database;
let cache: SqliteUnfurlCacheRepository;
let ctrl: UnfurlController;

beforeEach(() => {
  db = createTestDb();
  cache = new SqliteUnfurlCacheRepository(db, logger);
  ctrl = new UnfurlController(logger, cache);
});

afterEach(() => {
  vi.unstubAllGlobals();
  db.close();
});

function makeCtx(urlQuery: string | undefined) {
  const headers = new Map<string, string>();
  return {
    req: { query: () => urlQuery },
    header: (k: string, v: string) => { headers.set(k, v); },
    json: (body: unknown, status = 200) => ({ status, body, headers }),
  } as unknown as import("hono").Context;
}

function htmlResp(html: string, status = 200, ctype = "text/html") {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Map([["content-type", ctype]]),
    text: async () => html,
  } as unknown as Response;
}

const OG_HTML = `<!doctype html><html><head>
<meta property="og:title" content="示例文章 &amp; 标题">
<meta property="og:description" content="这是描述">
<meta property="og:image" content="/cover.png">
<meta property="og:site_name" content="示例站">
<title>fallback-title</title>
</head><body></body></html>`;

describe("GET /api/unfurl（F20261013csv3 三态）", () => {
  it("og 记录永久缓存：二次请求命中缓存不再发 fetch", async () => {
    const fetchMock = vi.fn(async () => htmlResp(OG_HTML));
    vi.stubGlobal("fetch", fetchMock);
    const url = "https://example.com/post/1";
    // 第一次：pending（后台抓取由 get 内部触发）——等一拍让落库完成
    const first = await ctrl.get(makeCtx(url)) as unknown as { status: number; body: Record<string, unknown> };
    expect(first.status).toBe(200);
    expect(first.body.status).toBe("pending");
    await new Promise(r => setTimeout(r, 10)); // 后台 fetchAndCache 落定
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // 第二次：缓存命中（og 永久 TTL——不随时间过期）
    const second = await ctrl.get(makeCtx(url)) as unknown as { status: number; body: Record<string, unknown> };
    expect(second.body.status).toBe("ok");
    const data = second.body.data as Record<string, unknown>;
    expect(data.title).toBe("示例文章 & 标题");
    expect(data.description).toBe("这是描述");
    expect(data.image).toBe("https://example.com/cover.png");
    expect(data.siteName).toBe("示例站");
    expect(data.host).toBe("example.com");
    expect(fetchMock).toHaveBeenCalledTimes(1); // 未再发请求
  });

  it("og:title 缺失时回退 <title> 标签", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => htmlResp(`<html><head><title>  文档标题 </title></head></html>`)));
    const url = "https://example.com/doc";
    await ctrl.fetchAndCache(url);
    const res = await ctrl.get(makeCtx(url)) as unknown as { status: number; body: Record<string, unknown> };
    expect((res.body.data as Record<string, unknown>).title).toBe("文档标题");
  });

  it("failed 记录 7 天窗口内显式返回 failed 态（不重复抓取）", async () => {
    const fetchMock = vi.fn(async () => { throw new Error("network timeout"); });
    vi.stubGlobal("fetch", fetchMock);
    const url = "https://example.com/slow";
    await ctrl.fetchAndCache(url); // 落 failed
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const res = await ctrl.get(makeCtx(url)) as unknown as { status: number; body: Record<string, unknown> };
    expect(res.body.status).toBe("failed");
    expect(res.body.error).toBe("network timeout");
    expect(fetchMock).toHaveBeenCalledTimes(1); // 未重复抓取
  });

  it("failed 记录超 7 天窗口 → miss（重新抓取）", async () => {
    const fetchMock = vi.fn(async () => htmlResp(OG_HTML));
    vi.stubGlobal("fetch", fetchMock);
    const url = "https://example.com/old-fail";
    // 落一条 8 天前的 failed 记录
    cache.put({
      url, title: null, description: null, image: null, siteName: null,
      host: "example.com", source: "failed", state: null, additions: null, deletions: null,
      error: "stale error",
      fetchedAt: new Date(Date.now() - UNFURL_FAILED_TTL_MS - 24 * 60 * 60 * 1000).toISOString(),
    });
    const res = await ctrl.get(makeCtx(url)) as unknown as { status: number; body: Record<string, unknown> };
    expect(res.body.status).toBe("pending"); // miss → 后台重抓
    await ctrl.fetchAndCache(url);
    const after = await ctrl.get(makeCtx(url)) as unknown as { status: number; body: Record<string, unknown> };
    expect(after.body.status).toBe("ok");
  });

  it("github-api SWR：24h 内 fresh 直接命中；过期 stale 先返旧值 + 后台刷新", async () => {
    const url = "https://github.com/owner/repo/pull/123";
    const oldIso = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(); // 25h 前
    cache.put({
      url, title: "Old PR title", description: "old desc", image: null, siteName: "GitHub",
      host: "github.com", source: "github-api", state: "open", additions: 10, deletions: 5,
      error: null, fetchedAt: oldIso,
    });
    // stale：先返旧值（SWR——不阻塞渲染）
    const res = await ctrl.get(makeCtx(url)) as unknown as { status: number; body: Record<string, unknown> };
    expect(res.body.status).toBe("ok");
    const data = res.body.data as Record<string, unknown>;
    expect(data.title).toBe("Old PR title");
    expect(data.state).toBe("open");
    expect(data.additions).toBe(10);
    // fresh（24h 内）：不再触发后台刷新——再请求仍返旧值，fetchAndCache 未被调（mock gh 会失败）
    cache.put({ url, title: "Fresh PR", description: null, image: null, siteName: "GitHub", host: "github.com", source: "github-api", state: "merged", additions: 20, deletions: 1, error: null, fetchedAt: new Date().toISOString() });
    const fresh = await ctrl.get(makeCtx(url)) as unknown as { status: number; body: Record<string, unknown> };
    expect((fresh.body.data as Record<string, unknown>).title).toBe("Fresh PR");
  });

  it("缺 url 参数 → 400", async () => {
    const res = await ctrl.get(makeCtx(undefined)) as unknown as { status: number; body: Record<string, unknown> };
    expect(res.status).toBe(400);
  });

  it("非法 URL → 400", async () => {
    const res = await ctrl.get(makeCtx("not-a-url")) as unknown as { status: number; body: Record<string, unknown> };
    expect(res.status).toBe(400);
  });
});

describe("SSRF 防护（F20261013csv3 恶意 URL 注入用例）", () => {
  it.each([
    ["file 协议", "file:///etc/passwd"],
    ["ftp 协议", "ftp://example.com/x"],
    ["localhost", "http://localhost/admin"],
    ["127.0.0.1", "http://127.0.0.1:8080/"],
    ["10.x 内网", "http://10.0.0.1/internal"],
    ["172.16-31 内网", "http://172.16.0.1/internal"],
    ["192.168 内网", "http://192.168.1.1/router"],
    ["0.0.0.0", "http://0.0.0.0/"],
    ["十六进制 IPv4", "http://0x7f000001/"],
    ["十进制 IPv4", "http://2130706433/"],
    ["IPv6 环回", "http://[::1]/"],
    ["IPv6 ULA", "http://[fd00::1]/"],
    ["IPv6 链路本地", "http://[fe80::1]/"],
    ["IPv4-mapped 点分", "http://[::ffff:10.0.0.1]/"],
    ["IPv4-mapped 十六进制", "http://[::ffff:7f00:1]/"],
  ])("%s → 400 blocked", async (_label, url) => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const res = await ctrl.get(makeCtx(url)) as unknown as { status: number; body: Record<string, unknown> };
    expect(res.status).toBe(400);
    expect(["blocked host", "unsupported protocol"]).toContain(res.body.error);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("flag 注入形态的 owner/repo 被白名单拒绝（parseGithubUrl 不解析超集字符）", () => {
    expect(parseGithubUrl("https://github.com/owner;rm -rf/repo")).toBeNull();
    expect(parseGithubUrl("https://github.com/owner/repo$(whoami)")).toBeNull();
    // PR 号段非纯数字 → 不命中 pr 分支（降 repo 元数据取数——gh 参数数组无注入面）
    const semi = parseGithubUrl("https://github.com/owner/repo/pull/1;cat /etc/passwd");
    expect(semi?.kind).toBe("repo");
  });
});

describe("parseGithubUrl（URL 分类）", () => {
  it("PR / issue / 仓库主页 / 文件路径四类正确分类", () => {
    expect(parseGithubUrl("https://github.com/a/b/pull/42")).toMatchObject({ kind: "pr", owner: "a", repo: "b", number: 42 });
    expect(parseGithubUrl("https://github.com/a/b/issues/7")).toMatchObject({ kind: "issue", owner: "a", repo: "b", number: 7 });
    expect(parseGithubUrl("https://github.com/a/b")).toMatchObject({ kind: "repo", owner: "a", repo: "b", number: null });
    expect(parseGithubUrl("https://github.com/a/b/blob/main/src/x.ts")).toMatchObject({ kind: "repo", owner: "a", repo: "b" });
  });
  it("非 GitHub / 非 http 返回 null", () => {
    expect(parseGithubUrl("https://gitlab.com/a/b")).toBeNull();
    expect(parseGithubUrl("ftp://github.com/a/b")).toBeNull();
    expect(parseGithubUrl("not-a-url")).toBeNull();
  });
});
