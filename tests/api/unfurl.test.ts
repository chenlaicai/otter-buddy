import { describe, it, expect, vi, afterEach } from "vitest";
import { UnfurlController } from "../../src/interface-adapters/http/controllers/unfurl-controller";
import { createTestLogger } from "../helpers/logger";

/**
 * F20261008csf1 P1：链类 unfurl 端点测试。
 * 锁定行为：①og 元数据提取（title/description/image 归一化）；②失败降级 404
 * （超时/非 HTML/og 全空/SSRF 内网段/非法协议）——前端拿到 404 渲染普通链接。
 * fetch 全局 stub：不触真实网络（测试无外部依赖原则）。
 */

const logger = createTestLogger();

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

afterEach(() => { vi.unstubAllGlobals(); });

describe("GET /api/unfurl（F20261008csf1）", () => {
  it("提取 og 元数据：title 实体解码 / image 相对路径归一化为绝对 URL", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => htmlResp(OG_HTML)));
    const ctrl = new UnfurlController(logger);
    const res = await ctrl.get(makeCtx("https://example.com/post/1")) as unknown as { status: number; body: Record<string, unknown> };
    expect(res.status).toBe(200);
    expect(res.body.title).toBe("示例文章 & 标题");
    expect(res.body.description).toBe("这是描述");
    expect(res.body.image).toBe("https://example.com/cover.png");
    expect(res.body.siteName).toBe("示例站");
    expect(res.body.host).toBe("example.com");
  });

  it("og:title 缺失时回退 <title> 标签", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => htmlResp(`<html><head><title>  文档标题 </title></head></html>`)));
    const ctrl = new UnfurlController(logger);
    const res = await ctrl.get(makeCtx("https://example.com/doc")) as unknown as { status: number; body: Record<string, unknown> };
    expect(res.status).toBe(200);
    expect(res.body.title).toBe("文档标题");
  });

  it("content 在 property 之前的 meta 形态也能提取", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => htmlResp(`<html><head><meta content="倒序内容" property="og:title"></head></html>`)));
    const ctrl = new UnfurlController(logger);
    const res = await ctrl.get(makeCtx("https://example.com/x")) as unknown as { status: number; body: Record<string, unknown> };
    expect(res.body.title).toBe("倒序内容");
  });

  it("目标站非 2xx → 404（前端降级普通链接）", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => htmlResp("err", 500)));
    const ctrl = new UnfurlController(logger);
    const res = await ctrl.get(makeCtx("https://example.com/broken")) as unknown as { status: number };
    expect(res.status).toBe(404);
  });

  it("非 HTML 响应（PDF/图片直链）→ 404", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => htmlResp("%PDF-1.4", 200, "application/pdf")));
    const ctrl = new UnfurlController(logger);
    const res = await ctrl.get(makeCtx("https://example.com/paper.pdf")) as unknown as { status: number };
    expect(res.status).toBe(404);
  });

  it("og/title/description 全空 → 404（无信息增量的空卡不如纯链接）", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => htmlResp(`<html><head></head><body>hi</body></html>`)));
    const ctrl = new UnfurlController(logger);
    const res = await ctrl.get(makeCtx("https://example.com/empty")) as unknown as { status: number };
    expect(res.status).toBe(404);
  });

  it("fetch 抛错（超时/断网）→ 404 而非 500", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("network down"); }));
    const ctrl = new UnfurlController(logger);
    const res = await ctrl.get(makeCtx("https://example.com/down")) as unknown as { status: number };
    expect(res.status).toBe(404);
  });

  it("SSRF 防护：localhost / 127. / 10. / 192.168. 内网段与 file: 协议被拒", async () => {
    const ctrl = new UnfurlController(logger);
    for (const bad of [
      "http://localhost:3000/x",
      "http://127.0.0.1/admin",
      "http://10.0.0.1/internal",
      "http://192.168.1.1/router",
      "file:///etc/passwd",
      "ftp://example.com/x",
      "not-a-url",
    ]) {
      const res = await ctrl.get(makeCtx(bad)) as unknown as { status: number };
      expect(res.status, bad).toBe(400);
    }
    // 全程未发请求（入参校验在 fetch 之前）
  });

  it("缺 url 参数 → 400", async () => {
    const ctrl = new UnfurlController(logger);
    const res = await ctrl.get(makeCtx(undefined)) as unknown as { status: number };
    expect(res.status).toBe(400);
  });

  it("超大数据截断：body 超 512KB 仍能在头部 og 正常提取", async () => {
    const huge = OG_HTML.replace("</head>", `<meta name="padding" content="${"x".repeat(600 * 1024)}"></head>`);
    vi.stubGlobal("fetch", vi.fn(async () => htmlResp(huge)));
    const ctrl = new UnfurlController(logger);
    const res = await ctrl.get(makeCtx("https://example.com/big")) as unknown as { status: number; body: Record<string, unknown> };
    expect(res.status).toBe(200);
    expect(res.body.title).toBe("示例文章 & 标题");
  });
});
