/**
 * F20261012qtbc：配额采集浏览器会话（Playwright 持久档案）。
 *
 * 机制：单一持久化 profile（三家站点共用，各自登录一次），headless 访问控制台页 +
 * 网络拦截配额 XHR。登录态缺失/过期时由服务层触发 openLogin()——关掉 headless
 * 会话、弹有头窗口让搭档扫码（关窗或超时后自动收回，恢复 headless）。
 *
 * 边界：只访问三家控制台页；profile 只存本地（data/quota-browser/，不进 git）。
 * 串行化：单 context 互斥，capture/login 经 lock 串行。
 */
import { chromium, type BrowserContext } from "playwright";
import type { Logger } from "@usecases/ports/logger";
import type {
  CaptureResult,
  CapturedResponse,
  QuotaCaptureSession,
  QuotaProviderSpec,
} from "@usecases/quota/quota-ports";

const LOGIN_URL_PATTERN = /login|passport|signin|sign-in|auth/i;

export function isLoginUrl(url: string): boolean {
  return LOGIN_URL_PATTERN.test(url);
}

export class QuotaBrowserSession implements QuotaCaptureSession {
  private context: BrowserContext | null = null;
  /** 单 context 互斥锁（capture / login 串行） */
  private lock: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly opts: { profileDir: string; logger: Logger },
  ) {}

  /** 采集：开页 → 拦截配额响应 → 等首个命中或超时 */
  capture(spec: QuotaProviderSpec, timeoutMs = 20000): Promise<CaptureResult> {
    const run = this.lock.then(() => this.captureOnce(spec, timeoutMs));
    this.lock = run.catch(() => undefined);
    return run;
  }

  /** 弹有头登录窗：等搭档自己关窗（登录完成的自然信号）或超时自动关 */
  openLogin(spec: QuotaProviderSpec, waitMs = 180_000): Promise<void> {
    const run = this.lock.then(() => this.loginOnce(spec, waitMs));
    this.lock = run.catch(() => undefined);
    return run;
  }

  async shutdown(): Promise<void> {
    const run = this.lock.then(() => this.closeContext());
    this.lock = run.catch(() => undefined);
    await run;
  }

  private async ensureContext(): Promise<BrowserContext> {
    if (this.context) return this.context;
    const ctx = await chromium.launchPersistentContext(this.opts.profileDir, {
      headless: true,
      viewport: { width: 1440, height: 900 },
    });
    ctx.on("close", () => {
      if (this.context === ctx) this.context = null;
    });
    this.context = ctx;
    return ctx;
  }

  private async closeContext(): Promise<void> {
    const ctx = this.context;
    this.context = null;
    if (!ctx) return;
    try {
      await ctx.close();
    } catch (err) {
      this.opts.logger.warn(`[quota] 关闭浏览器会话失败（忽略）: ${String(err)}`);
    }
  }

  private async captureOnce(spec: QuotaProviderSpec, timeoutMs: number): Promise<CaptureResult> {
    const ctx = await this.ensureContext();
    const page = await ctx.newPage();
    const responses: CapturedResponse[] = [];
    const onResp = async (res: { url(): string; status(): number; json(): Promise<unknown> }): Promise<void> => {
      const url = res.url();
      if (!spec.match(url)) return;
      try {
        const json = await res.json();
        responses.push({ url, status: res.status(), json });
      } catch {
        responses.push({ url, status: res.status() });
      }
    };
    page.on("response", onResp);
    let finalUrl: string | undefined;
    try {
      await page.goto(spec.consoleUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline && responses.length === 0) {
        // A3（对抗审视）：已跳登录页则短路，不再空等采集超时（首屏最坏 90s → 即时）
        if (isLoginUrl(page.url())) break;
        await page.waitForTimeout(300);
      }
      // 首个命中后再等一小段，容忍同页多个配额响应（如 detail + usage）
      if (responses.length > 0) await page.waitForTimeout(600);
      finalUrl = page.url();
    } finally {
      page.off("response", onResp);
      await page.close().catch(() => undefined);
    }
    const settledUrl = finalUrl ?? spec.consoleUrl;
    return { responses, finalUrl: settledUrl, redirectedToLogin: isLoginUrl(settledUrl) };
  }

  private async loginOnce(spec: QuotaProviderSpec, waitMs: number): Promise<void> {
    // 有头登录与 headless 采集共用同一 profile（互斥），先关再开
    await this.closeContext();
    const ctx = await chromium.launchPersistentContext(this.opts.profileDir, {
      headless: false,
      viewport: { width: 1280, height: 860 },
    });
    ctx.on("close", () => {
      if (this.context === ctx) this.context = null;
    });
    this.context = ctx;
    try {
      const page = await ctx.newPage();
      await page.goto(spec.consoleUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
      this.opts.logger.info(`[quota] 登录窗已弹出（${spec.label}），等待搭档登录：关窗即视为完成，${Math.round(waitMs / 1000)}s 未关自动收回`);
      // 搭档登录完成 = 自己关窗；窗口被关（close 事件）即结束等待
      await Promise.race([
        ctx.waitForEvent("close", { timeout: waitMs }).catch(() => undefined),
      ]);
    } finally {
      await this.closeContext();
    }
  }
}
