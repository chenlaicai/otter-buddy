/**
 * buildApp Class A 启动测试：验证组装根可被测试导入、无 import 时副作用、
 * 全栈装配（真 sqlite/真仓库/真用例/真控制器/真路由）可启动并服务请求。
 *
 * LLM 用 initFauxModels（pi-ai 官方假 provider，不触网）；
 * embedding worker 用立即报错的 stub（验证降级不炸启动）；
 * 全部路径指向临时目录，syncAuth=false 隔离全局副作用。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { buildApp, type BuiltApp } from "../../src/app";
import { loadConfig, resetConfigForTests } from "../../src/frameworks/config";
import { initFauxModels } from "../../src/frameworks/llm/models-factory";
import type { Logger } from "../../src/usecases/ports/logger";

function noopLogger(): Logger {
  const logger: Logger = {
    info: () => {}, warn: () => {}, error: () => {}, debug: () => {},
    child: () => logger,
  };
  return logger;
}

/** 立即上报 load error 的 stub embedding worker（CJS：tmp 目录无 package.json type:module） */
const STUB_WORKER = `
const { parentPort } = require("worker_threads");
parentPort.postMessage({ type: "error", error: "test stub worker", id: -1 });
`;

describe("buildApp 组装根启动", () => {
  let tmpDir: string;
  let built: BuiltApp;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "otter-buildapp-"));
    const docsRoot = path.join(tmpDir, "docs-root");
    fs.mkdirSync(docsRoot, { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "stub-worker.cjs"), STUB_WORKER);

    const configPath = path.join(tmpDir, "config.yaml");
    fs.writeFileSync(configPath, [
      "llm:",
      "  provider: openai",
      "  model: faux-model",
      `database:`,
      `  path: ${path.join(tmpDir, "test.db")}`,
      "server:",
      "  port: 0",
    ].join("\n"));

    const logger = noopLogger();
    const config = loadConfig(logger, configPath);
    config.embedding.workerPath = path.join(tmpDir, "stub-worker.cjs");

    const { model } = await initFauxModels([]);

    built = await buildApp({
      config,
      logger,
      models: { model },
      dataDir: path.join(tmpDir, "data"),
      sessionDir: path.join(tmpDir, "sessions"),
      rootDir: docsRoot,
      staticRoot: false,
      syncAuth: false,
      enableFeishu: false,
      startScheduler: false,
    });
  }, 180_000);

  afterAll(() => {
    built?.dispose();
    resetConfigForTests();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("健康端点可用（全栈装配完成）", async () => {
    const res = await built.app.request("/api/health/memory");
    expect(res.status).toBe(200);
  });

  it("embedding stub 报错后优雅降级：available=false 且启动不炸", () => {
    expect(built.embeddingService.available).toBe(false);
  });

  it("建獭全链路：POST /api/otters → 真 sqlite 落行 → GET 可取回", async () => {
    const createRes = await built.app.request("/api/otters", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "启动测试獭", type: "big" }),
    });
    expect(createRes.status).toBe(201);
    const otter = await createRes.json() as { id: string; name: string };

    const getRes = await built.app.request(`/api/otters/${otter.id}`);
    expect(getRes.status).toBe(200);
    const fetched = await getRes.json() as { name: string };
    expect(fetched.name).toBe("启动测试獭");

    /** 真 DB 断言：otters 表有行，且 F20260805rsto 不变量（出生即建首世 domain session）成立 */
    const row = built.db.prepare("SELECT name FROM otters WHERE id = ?").get(otter.id) as { name: string };
    expect(row.name).toBe("启动测试獭");
    const session = await built.repos.otter.getActiveSession(otter.id);
    expect(session).not.toBeNull();
  });

  it("静态路由关闭时不挂页面路由", async () => {
    const res = await built.app.request("/memory");
    expect(res.status).toBe(404);
  });
});
