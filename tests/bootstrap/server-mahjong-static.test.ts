/**
 * F20261015mjsg 模块四·缺口④：三麻牌局页静态挂载（/mahjong 大厅 + /mahjong/:roomId 牌局页）。
 *
 * 覆盖点：
 *  ① 深链接直达牌局页（不被 SPA fallback 吞成 SPA 入口——方案模块四「注意与 SPA fallback 的交互」）
 *  ② 静态资源 /mahjong/assets/* 映射到 web-mahjong/*（serveStatic 的 root 拼 URL 路径，需改写）
 *  ③ SPA fallback 与 /api 404 行为不受影响（F20260920spa 防回归）
 *  ④ staticRoot=false 时页面路由一并不挂（静态页总开关语义）
 *  ⑤ 仓库内真页面（web-mahjong/index.html + style.css + js）可达
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildHttpApp } from "../../src/bootstrap/server";
import type { initControllers } from "../../src/bootstrap/controllers";
import type { Logger } from "../../src/usecases/ports/logger";

type Controllers = ReturnType<typeof initControllers>;

const logger: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  child: () => logger,
};

/** 最小 controllers mock——静态路由测试不触达 API 层 */
function minimalControllers(): Controllers {
  return new Proxy({}, { get: () => new Proxy(function () {}, { get: () => () => {} }) }) as unknown as Controllers;
}

describe("三麻牌局页静态挂载（web-mahjong）", () => {
  let pageRoot: string;
  let spaRoot: string;
  let app: ReturnType<typeof buildHttpApp>;

  beforeAll(() => {
    pageRoot = mkdtempSync(path.join(tmpdir(), "mahjong-page-"));
    writeFileSync(path.join(pageRoot, "index.html"), "<html><div id='app'>MAHJONG_PAGE</div></html>");
    mkdirSync(path.join(pageRoot, "js"), { recursive: true });
    writeFileSync(path.join(pageRoot, "js", "view.js"), "export const marker = 'view-module';\n");
    writeFileSync(path.join(pageRoot, "style.css"), ".tile{width:40px}\n");

    spaRoot = mkdtempSync(path.join(tmpdir(), "spa-root-"));
    writeFileSync(path.join(spaRoot, "index.html"), "<html><div id='root'>SPA</div></html>");

    app = buildHttpApp(minimalControllers(), logger, spaRoot, pageRoot);
  });

  afterAll(() => {
    rmSync(pageRoot, { recursive: true, force: true });
    rmSync(spaRoot, { recursive: true, force: true });
  });

  it("GET /mahjong 返回牌局页入口", async () => {
    const res = await app.request("/mahjong");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/html");
    expect(await res.text()).toContain("MAHJONG_PAGE");
  });

  it("GET /mahjong/:roomId 深链接直达牌局页，不被 SPA fallback 吞掉", async () => {
    for (const url of ["/mahjong/abc", "/mahjong/room-with-dash_1.2", "/mahjong/%E4%B8%89%E9%BA%BB"]) {
      const res = await app.request(url);
      expect(res.status, url).toBe(200);
      const text = await res.text();
      expect(text, url).toContain("MAHJONG_PAGE");
      expect(text, url).not.toContain("SPA");
    }
  });

  it("静态资源 /mahjong/assets/* 映射到 web-mahjong/*", async () => {
    const js = await app.request("/mahjong/assets/js/view.js");
    expect(js.status).toBe(200);
    expect(await js.text()).toContain("view-module");
    expect(js.headers.get("Content-Type")).toContain("javascript");

    const css = await app.request("/mahjong/assets/style.css");
    expect(css.status).toBe(200);
    expect(await css.text()).toContain(".tile{width:40px}");
  });

  it("不存在的资源不回落到牌局页也不 500", async () => {
    const res = await app.request("/mahjong/assets/nope.js");
    expect(res.status).toBe(404);
  });

  it("SPA fallback 与 /api 404 行为不受影响（F20260920spa 防回归）", async () => {
    expect(await (await app.request("/memory")).text()).toContain("SPA");
    expect((await app.request("/api/unknown")).status).toBe(404);
  });

  it("staticRoot=false（关静态页）时牌局页路由一并不挂", async () => {
    const bare = buildHttpApp(minimalControllers(), logger, false);
    expect((await bare.request("/mahjong")).status).toBe(404);
    expect((await bare.request("/mahjong/any")).status).toBe(404);
  });
});

describe("仓库内真页面可达", () => {
  const pageRoot = path.resolve(process.cwd(), "web-mahjong");
  let app: ReturnType<typeof buildHttpApp>;

  beforeAll(() => {
    expect(existsSync(path.join(pageRoot, "index.html")), `页面根不存在：${pageRoot}`).toBe(true);
    app = buildHttpApp(minimalControllers(), logger, false, pageRoot);
  });

  it("index.html 含牌桌挂载点与入口脚本", async () => {
    const res = await app.request("/mahjong/real-room");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('id="hand"');
    expect(html).toContain('id="actionbar"');
    expect(html).toContain("/mahjong/assets/js/app.js");
    expect(html).toContain("/mahjong/assets/style.css");
  });

  it("js 三件套与样式表可被页面按 URL 取到", async () => {
    for (const p of ["/mahjong/assets/js/app.js", "/mahjong/assets/js/view.js", "/mahjong/assets/js/sse.js", "/mahjong/assets/js/api.js", "/mahjong/assets/style.css"]) {
      const res = await app.request(p);
      expect(res.status, p).toBe(200);
      expect((await res.text()).length, p).toBeGreaterThan(100);
    }
  });
});
