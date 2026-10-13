/**
 * F20261012qtbc：QuotaService 编排单测（假会话注入，无浏览器）。
 * 覆盖：ok 归一化 / needs-login 双路径（401、跳登录页）/ TTL 缓存 /
 * refresh 强制重采 / fail-closed 未识别 / 采集异常 / openLogin 清缓存。
 */
import { describe, it, expect } from "vitest";
import { QuotaService } from "@usecases/quota/quota-service";
import type { CaptureResult, CapturedResponse, QuotaCaptureSession, QuotaProviderSpec } from "@usecases/quota/quota-ports";
import { QUOTA_PROVIDERS } from "@frameworks/quota/providers";
import type { Logger } from "@usecases/ports/logger";

function stubLogger(): Logger & { infos: string[] } {
  const infos: string[] = [];
  const logger = {
    infos,
    info: (msg: string) => { infos.push(msg); },
    warn: () => undefined,
    error: () => undefined,
    debug: () => undefined,
    child: () => logger,
  } as unknown as Logger & { infos: string[] };
  return logger;
}

const glmSpec = QUOTA_PROVIDERS.find(p => p.id === "glm")!;

// 真实响应结构（2026-10-13 首登冒烟锁定）：usage=窗口总量、currentValue=已用、remaining=剩余
const GLM_PAYLOAD = {
  data: {
    limits: [
      { type: "CREDIT_LIMIT", unit: 3, number: 5, usage: 28000, currentValue: 250, remaining: 27750, percentage: 0 },
      { type: "CREDIT_LIMIT", unit: 6, number: 1, usage: 140000, currentValue: 140000, remaining: 0, percentage: 100, nextResetTime: 1792039565977 },
    ],
  },
};

function captureResult(responses: CapturedResponse[], finalUrl = glmSpec.consoleUrl, visitedUrls: string[] = []): CaptureResult {
  return { responses, finalUrl, redirectedToLogin: /login|passport|signin|auth/i.test(finalUrl), visitedUrls };
}

/** 脚本化假会话：按调用序回放结果，记录调用轨迹 */
function fakeSession(script: Array<CaptureResult | Error>) {
  const calls: string[] = [];
  let i = 0;
  const session: QuotaCaptureSession = {
    capture: async (spec: QuotaProviderSpec) => {
      calls.push(spec.id);
      const r = script[Math.min(i, script.length - 1)];
      i += 1;
      if (r instanceof Error) throw r;
      return r;
    },
    openLogin: async (spec: QuotaProviderSpec) => {
      calls.push(`login:${spec.id}`);
    },
  };
  return { session, calls };
}

function makeService(session: QuotaCaptureSession, nowRef: { t: number }, opts?: { logger?: Logger }) {
  return new QuotaService({
    session,
    providers: [glmSpec],
    logger: opts?.logger ?? stubLogger(),
    now: () => nowRef.t,
  });
}

describe("QuotaService", () => {
  it("ok：捕获响应经 GLM 归一化为窗口", async () => {
    const { session } = fakeSession([captureResult([{ url: "https://bigmodel.cn/monitor/usage/quota/limit", status: 200, json: GLM_PAYLOAD }])]);
    const snap = await makeService(session, { t: 1_000_000 }).getSnapshot();
    expect(snap.providers[0]!.status).toBe("ok");
    expect(snap.providers[0]!.windows).toHaveLength(2);
    expect(snap.providers[0]!.windows[1]!.remaining).toBe(0);
  });

  it("needs-login：401 响应", async () => {
    const { session } = fakeSession([captureResult([{ url: "https://bigmodel.cn/monitor/usage/quota/limit", status: 401 }])]);
    const snap = await makeService(session, { t: 0 }).getSnapshot();
    expect(snap.providers[0]!.status).toBe("needs-login");
  });

  it("needs-login：页面跳登录页（无捕获）", async () => {
    const { session } = fakeSession([captureResult([], "https://bigmodel.cn/login?next=%2F")]);
    const snap = await makeService(session, { t: 0 }).getSnapshot();
    expect(snap.providers[0]!.status).toBe("needs-login");
  });

  it("诊断：空捕获 + 未跳登录 → error 且落 visitedUrls 日志（区分「未登录」与「端点改了」）", async () => {
    const logger = stubLogger();
    const visited = ["https://www.kimi.com/code", "https://www.kimi.com/apiv2/ConfigService/GetConfig"];
    const { session } = fakeSession([captureResult([], "https://www.kimi.com/code", visited)]);
    const snap = await makeService(session, { t: 0 }, { logger }).getSnapshot();
    // 空捕获 + finalUrl 非登录页 → 不是 needs-login，是 error（端点可能改了）
    expect(snap.providers[0]!.status).toBe("error");
    // 诊断日志落 visitedUrls
    const diagLog = logger.infos.find(m => m.includes("未捕获响应"));
    expect(diagLog).toBeDefined();
    expect(diagLog).toContain("finalUrl=https://www.kimi.com/code");
    expect(diagLog).toContain("kimi.com/apiv2");
  });

  it("fail-closed：结构未识别 → error（不猜数字）", async () => {
    const { session } = fakeSession([captureResult([{ url: "https://bigmodel.cn/monitor/usage/quota/limit", status: 200, json: { data: { foo: 1 } } }])]);
    const snap = await makeService(session, { t: 0 }).getSnapshot();
    expect(snap.providers[0]!.status).toBe("error");
    expect(snap.providers[0]!.windows).toHaveLength(0);
  });

  it("采集异常 → error 并带原因", async () => {
    const { session } = fakeSession([new Error("browser exploded")]);
    const snap = await makeService(session, { t: 0 }).getSnapshot();
    expect(snap.providers[0]!.status).toBe("error");
    expect(snap.providers[0]!.error).toContain("browser exploded");
  });

  it("TTL：窗口期内二次读取走缓存不重采；refresh=1 强制重采", async () => {
    const nowRef = { t: 0 };
    const { session, calls } = fakeSession([
      captureResult([{ url: "u", status: 200, json: GLM_PAYLOAD }]),
      captureResult([{ url: "u", status: 200, json: GLM_PAYLOAD }]),
      captureResult([{ url: "u", status: 200, json: GLM_PAYLOAD }]),
    ]);
    const svc = makeService(session, nowRef);
    await svc.getSnapshot();
    nowRef.t = 4 * 60_000; // TTL=5min 内
    const snap2 = await svc.getSnapshot();
    expect(snap2.stale).toBe(true);
    expect(calls.filter(c => c === "glm")).toHaveLength(1);
    await svc.getSnapshot({ refresh: true });
    expect(calls.filter(c => c === "glm")).toHaveLength(2);
  });

  it("TTL 过期后重采（stale=false）", async () => {
    const nowRef = { t: 0 };
    const { session, calls } = fakeSession([captureResult([{ url: "u", status: 200, json: GLM_PAYLOAD }])]);
    const svc = makeService(session, nowRef);
    await svc.getSnapshot();
    nowRef.t = 6 * 60_000; // TTL=5min 过期
    const snap = await svc.getSnapshot();
    expect(snap.stale).toBe(false);
    expect(calls.filter(c => c === "glm")).toHaveLength(2);
  });

  it("openLogin 后清缓存：下次读取即重采（A2 非阻塞启动）", async () => {
    const nowRef = { t: 0 };
    const { session, calls } = fakeSession([captureResult([{ url: "u", status: 200, json: GLM_PAYLOAD }])]);
    const svc = makeService(session, nowRef);
    await svc.getSnapshot();
    svc.openLogin("glm");
    expect(calls).toContain("login:glm");
    await svc.getSnapshot();
    expect(calls.filter(c => c === "glm")).toHaveLength(2);
  });

  it("A4：并发 getSnapshot 共享同一次采集（in-flight 去重）", async () => {
    const nowRef = { t: 0 };
    const { session, calls } = fakeSession([captureResult([{ url: "u", status: 200, json: GLM_PAYLOAD }])]);
    const svc = makeService(session, nowRef);
    const [a, b] = await Promise.all([svc.getSnapshot(), svc.getSnapshot()]);
    expect(calls.filter(c => c === "glm")).toHaveLength(1);
    expect(a.providers[0]!.fetchedAt).toBe(b.providers[0]!.fetchedAt);
  });

  it("A2：重复 openLogin 不重复弹窗（in-flight 守卫）", async () => {
    const nowRef = { t: 0 };
    const { session, calls } = fakeSession([captureResult([{ url: "u", status: 200, json: GLM_PAYLOAD }])]);
    const svc = makeService(session, nowRef);
    svc.openLogin("glm");
    svc.openLogin("glm");
    expect(calls.filter(c => c === "login:glm")).toHaveLength(1);
  });
});
