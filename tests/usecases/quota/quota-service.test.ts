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

function stubLogger(): Logger {
  const logger: Logger = {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    debug: () => undefined,
    child: () => logger,
  };
  return logger;
}

const glmSpec = QUOTA_PROVIDERS.find(p => p.id === "glm")!;

const GLM_PAYLOAD = {
  data: {
    limits: [
      { title: "5 小时", currentValue: 250, showLimitCount: 1000, nextResetTime: "2026-10-12 18:00:00" },
      { title: "本周", currentValue: 1000, showLimitCount: 1000, nextResetTime: "2026-10-15 12:46:05" },
    ],
  },
};

function captureResult(responses: CapturedResponse[], finalUrl = glmSpec.consoleUrl): CaptureResult {
  return { responses, finalUrl, redirectedToLogin: /login|passport|signin|auth/i.test(finalUrl) };
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

function makeService(session: QuotaCaptureSession, nowRef: { t: number }) {
  return new QuotaService({
    session,
    providers: [glmSpec],
    logger: stubLogger(),
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

  it("openLogin 后清缓存：下次读取即重采", async () => {
    const nowRef = { t: 0 };
    const { session, calls } = fakeSession([captureResult([{ url: "u", status: 200, json: GLM_PAYLOAD }])]);
    const svc = makeService(session, nowRef);
    await svc.getSnapshot();
    await svc.openLogin("glm");
    expect(calls).toContain("login:glm");
    await svc.getSnapshot();
    expect(calls.filter(c => c === "glm")).toHaveLength(2);
  });
});
