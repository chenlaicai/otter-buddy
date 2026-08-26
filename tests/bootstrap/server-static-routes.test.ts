/**
 * F20260826hfix：buildHttpApp MPA 静态路由注册测试。
 * 防 PR #444 类遗漏再犯——TopBar 加了页面入口、vite 加了入口、但 server.ts 漏注册路由 → 404。
 * Proxy mock controllers（静态路由命中前不触达 API 层），tmp 目录伪造 dist 页面文件。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
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
    for (const page of ["index", "conversation", "memory", "skills", "settings", "connections", "health"]) {
      writeFileSync(path.join(staticRoot, `${page}.html`), `<html>${page}</html>`);
    }
    app = buildHttpApp(minimalControllers(), logger, staticRoot);
  });

  afterAll(() => {
    rmSync(staticRoot, { recursive: true, force: true });
  });

  /** 每个已交付 MPA 页面都必须有路由 → 200。新增页面时在此追加 */
  it.each([
    ["/", "index"],
    ["/conversation/abc", "conversation"],
    ["/memory", "memory"],
    ["/skills", "skills"],
    ["/settings", "settings"],
    ["/connections", "connections"],
    ["/health", "health"],
  ])("%s 返回对应页面", async (route, page) => {
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

  it("staticRoot=false 时不挂任何页面路由", async () => {
    const bare = buildHttpApp(minimalControllers(), logger, false);
    expect((await bare.request("/health")).status).toBe(404);
  });
});
