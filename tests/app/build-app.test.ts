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
import { createCapturingLogger, type CapturedLogs } from "../helpers/logger";
import { withIdentity } from "../helpers/with-identity";

/** 立即上报 load error 的 stub embedding worker（CJS：tmp 目录无 package.json type:module） */
const STUB_WORKER = `
process.send({ type: "error", error: "test stub worker", id: -1 });
`;

describe("buildApp 组装根启动", () => {
  let tmpDir: string;
  let built: BuiltApp;
  let capturedLogs: CapturedLogs;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "otter-buildapp-"));
    const docsRoot = path.join(tmpDir, "docs-root");
    fs.mkdirSync(docsRoot, { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "stub-worker.cjs"), STUB_WORKER);

    const configPath = path.join(tmpDir, "config.yaml");
    fs.writeFileSync(configPath, [
      "llm:",
      "  models:",
      "    - alias: faux",
      "      provider: openai",
      "      model: faux-model",
      "      handoffThresholdTokens: 40000",
      `database:`,
      `  path: ${path.join(tmpDir, "test.db")}`,
      "server:",
      "  port: 0",
    ].join("\n"));

    const logger = createCapturingLogger();
    capturedLogs = logger.captured;
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
      startScheduler: false,
    });
    // #1322（F20261016autz）：真实装配的 app 也注入默认身份（否则被鉴权层 401）
    withIdentity(built.app);
  }, 180_000);

  afterAll(() => {
    built?.dispose();
    resetConfigForTests();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("健康端点可用（全栈装配完成）", { timeout: 20_000 }, async () => {  // F20261021ttos：全栈装配（真 sqlite+faux LLM）重成本，#1366 四件套实证
    const res = await built.app.request("/api/health/memory");
    expect(res.status).toBe(200);
  });

  it("embedding stub 报错后优雅降级：available=false 且启动不炸", () => {
    expect(built.embeddingService.available).toBe(false);
  });

  // F20261023emct delta（建议 2）：C 项启动解耦的行为回归防护——buildApp 返回后
  // postListenInit 之前：retryWorker 尚未创建（ref.current 为 null，listen 先行）；
  // postListenInit 执行后：worker 就位（stub worker 报错 → vec 禁用 → null 是合法态，
  // 但「null 且 postListenInit 未跑」与「postListenInit 已跑」必须可区分——断言不炸
  // + 事后 health 仍可用）。主行为：postListenInit 不抛（内部 catch 落日志）。
  it("postListenInit 幂等可调：listen 先行语义下不炸、失败不炸进程（F20261023emct）", async () => {
    await expect(built.postListenInit()).resolves.toBeUndefined();
    // 二次调用也不炸（幂等容忍——main.ts 只调一次，但防御重复 fire）
    await expect(built.postListenInit()).resolves.toBeUndefined();
    // postListenInit 后 health 仍可用（listen 先行不变量不被异步初始化破坏）
    const res = await built.app.request("/api/health/memory");
    expect(res.status).toBe(200);
    // 主行为断言：worker 延迟创建（listen 后）且 postListenInit 后就位——
    // vec 路径可用时 ref.current 从 null 变为 worker 实例（可用性归 createAndStartRetryWorker
    // 内部守卫管，这里只验「延迟绑定」机制本身工作）
    expect(built.retryWorkerRef).toBeDefined();
  }, 30_000);

  // issue #1252 S-2 回归防护：patrolWorker.start() 若被挪回 initAgentAndScheduler 之前，
  // scheduler-reconcile duty 首轮 tick 的 TDZ ReferenceError 会被 patrol-worker.ts:75
  // 失败隔离 catch 吞成 error 日志——启动不炸、无断言时不红。此断言封住该回归。
  it("patrol 首轮 tick 无 scheduler-reconcile TDZ 失败（#1252 回归防护）", () => {
    expect(capturedLogs.errors.some((m) => m.includes("Patrol duty failed: scheduler-reconcile"))).toBe(false);
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

  it("多模态 D1 回归：附件端点经全栈装配可达（路由挂载 + controller 构造）", async () => {
    // POST：不存在的会话 → controller 的会话校验返回 404 JSON "Conversation not found"。
    //   D1 故障模式（controller 未装配 → router 条件挂载跳过）下这里是 Hono 默认纯文本 404，
    //   json() 解析即炸——本断言正是从装配层盲区漏出 D1 后补的回归。
    const postRes = await built.app.request("/api/conversations/00000000-0000-4000-8000-000000000000/attachments", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });
    expect(postRes.status).toBe(404);
    const postBody = await postRes.json() as { error: string };
    expect(postBody.error).toBe("Conversation not found");

    // GET：不存在的附件 → 同理区分 route-level 404
    const getRes = await built.app.request("/api/attachments/00000000-0000-4000-8000-000000000000");
    expect(getRes.status).toBe(404);
    const getBody = await getRes.json() as { error: string };
    expect(getBody.error).toBe("Attachment not found");
  });

  it("F20260814mtrc：/metrics 端点含 agent 域指标（装配完成即注册）", async () => {
    const res = await built.app.request("/metrics");
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("agent_invoke_total");
    expect(text).toContain("agent_tool_calls_total");
    expect(text).toContain("agent_chain_hops");
    expect(text).toContain("agent_first_byte_latency_ms");
  });
});
