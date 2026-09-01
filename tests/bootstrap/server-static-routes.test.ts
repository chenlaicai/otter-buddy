/**
 * F20260826hfix：buildHttpApp MPA 静态路由注册测试。
 * 防 PR #444 类遗漏再犯——TopBar 加了页面入口、vite 加了入口、但 server.ts 漏注册路由 → 404。
 * #487（F20260827mpss）：用例与夹具页面集合改从单一清单（api-contract/web/pages.ts）派生；新增清单外 html 的守卫。
 * Proxy mock controllers（静态路由命中前不触达 API 层），tmp 目录伪造 dist 页面文件。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildHttpApp } from "../../src/bootstrap/server";
import { MPA_PAGES } from "@contract/web/pages";
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

/** 最小 controllers mock——静态路由测试不触达 API 层，get 返回 vi.fn 占位 */
function minimalControllers(): Controllers {
  return new Proxy({}, {
    get: () => new Proxy(function () {}, { get: () => () => {} }),
  }) as unknown as Controllers;
}

describe("buildHttpApp MPA 静态路由（F20260826hfix）", () => {
  let staticRoot: string;
  let app: ReturnType<typeof buildHttpApp>;

  beforeAll(() => {
    staticRoot = mkdtempSync(path.join(tmpdir(), "static-root-"));
    for (const page of MPA_PAGES) {
      writeFileSync(path.join(staticRoot, `${page.entry}.html`), `<html>${page.entry}</html>`);
    }
    app = buildHttpApp(minimalControllers(), logger, staticRoot);
  });

  afterAll(() => {
    rmSync(staticRoot, { recursive: true, force: true });
  });

  /** 每个已交付 MPA 页面都必须有路由 → 200。新增页面时在此追加 */
  /** #487（F20260827mpss）：用例从单一清单派生（testUrl 缺省 = pattern 中 :param 替换为 abc），新增页面自动纳入断言 */
  it.each(
    MPA_PAGES.map(p => [p.testUrl ?? p.pattern.replace(/:[^/]+/g, "abc"), p.entry])
  )("%s 返回对应页面", async (route, page) => {
    const res = await app.request(route);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain(page);
  });

  /**
   * 尾斜杠行为快照：显式路由不匹配 /health/，catch-all 在 staticRoot 下找不到目录也 404。
   * 这是全部 7 个页面的既有一致行为（TopBar 链接均无尾斜杠，正常导航不触达）。
   * 如需支持尾斜杠重定向，是独立改进，不属本 BugFix 范围。
   */
  it("尾斜杠路径 404（行为快照，全部页面一致）", async () => {
    expect((await app.request("/health/")).status).toBe(404);
    expect((await app.request("/memory/")).status).toBe(404);
  });

  it("未注册路径不落入页面兜底（404）", async () => {
    const res = await app.request("/not-a-page");
    expect(res.status).toBe(404);
  });

  /** #487 第 5 处漂移点守卫：web/ 目录 html 文件集合 === 清单 entry 集合。
   *  新增一个 html 却不登记清单（或反之）→ 本守卫红。 */
  it("web 目录 html 文件与清单一一对应", () => {
    const htmlFiles = readdirSync(path.join(__dirname, "../../web"))
      .filter(f => f.endsWith(".html"))
      .map(f => f.replace(/\.html$/, ""))
      .sort();
    const registryEntries = [...new Set(MPA_PAGES.map(p => p.entry))].sort();
    expect(htmlFiles).toEqual(registryEntries);
  });

  it("staticRoot=false 时不挂任何页面路由", async () => {
    const bare = buildHttpApp(minimalControllers(), logger, false);
    expect((await bare.request("/health")).status).toBe(404);
  });

  // F20260901chun：旧 URL 301 重定向测试（方案验收标准T1）
  it("/connections 301 重定向到 /im", async () => {
    const res = await app.request("/connections");
    expect(res.status).toBe(301);
    expect(res.headers.get("location")).toBe("/im");
  });

  it("/weixin 301 重定向到 /im", async () => {
    const res = await app.request("/weixin");
    expect(res.status).toBe(301);
    expect(res.headers.get("location")).toBe("/im");
  });
});
