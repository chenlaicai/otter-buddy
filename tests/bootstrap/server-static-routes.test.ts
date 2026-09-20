/**
 * F20260920spa：buildHttpApp SPA fallback 测试。
 *
 * 从 MPA 静态路由测试改造为 SPA fallback 测试。
 * 核心行为：所有非 API GET 请求 fallback 到 index.html（SPA 入口），
 * 由客户端 React Router 处理页面路由。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildHttpApp } from "../../src/bootstrap/server";
import { SPA_ROUTES } from "@contract/web/pages";
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

/** 最小 controllers mock——SPA fallback 测试不触达 API 层 */
function minimalControllers(): Controllers {
  return new Proxy({}, {
    get: () => new Proxy(function () {}, { get: () => () => {} }),
  }) as unknown as Controllers;
}

describe("buildHttpApp SPA fallback（F20260920spa）", () => {
  let staticRoot: string;
  let app: ReturnType<typeof buildHttpApp>;

  beforeAll(() => {
    staticRoot = mkdtempSync(path.join(tmpdir(), "spa-root-"));
    // SPA 只有一个 index.html 入口
    writeFileSync(path.join(staticRoot, "index.html"), "<html><div id='root'>SPA</div></html>");
    writeFileSync(path.join(staticRoot, "otter-icon.png"), "fake-icon");
    app = buildHttpApp(minimalControllers(), logger, staticRoot);
  });

  afterAll(() => {
    rmSync(staticRoot, { recursive: true, force: true });
  });

  /** SPA 深链接测试：所有页面路径都应返回 index.html（200） */
  it.each(
    SPA_ROUTES.map(r => [r.testUrl ?? r.path.replace(/:[^/]+/g, "abc")])
  )("%s 深链接返回 SPA 入口", async (route: string) => {
    const res = await app.request(route);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("SPA");
  });

  /** 根路径重定向到 /conversation */
  it("根路径 / 返回 SPA 入口", async () => {
    const res = await app.request("/");
    expect(res.status).toBe(200);
  });

  /** 未知路径也应返回 SPA 入口（SPA 通配路由处理 404） */
  it("未知路径返回 SPA 入口（SPA 通配处理 404）", async () => {
    const res = await app.request("/not-a-page");
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("SPA");
  });

  /** 静态资源文件能正确返回（非 SPA fallback） */
  it("静态资源文件正确返回", async () => {
    const res = await app.request("/otter-icon.png");
    expect(res.status).toBe(200);
  });

  it("staticRoot=false 时不挂任何页面路由", async () => {
    const bare = buildHttpApp(minimalControllers(), logger, false);
    expect((await bare.request("/health")).status).toBe(404);
  });

  // F20260901chun：旧 URL 301 重定向测试
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
