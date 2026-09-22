import { describe, it, expect, vi, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { WeixinLoginFlow } from "@frameworks/weixin/login-flow";
import { WeixinApiClient } from "@frameworks/weixin/api-client";
import { WeixinAccountStore } from "@frameworks/weixin/account-store";
import type { Logger } from "@usecases/ports/logger";

/**
 * 微信扫码登录流程单测——#571：scaned_but_redirect 网关切换。
 *
 * fetch 按 URL 路由记录每次请求的 base，断言重定向后后续轮询打到新网关；
 * 非白名单域拒绝切换（扫码轮询含 qrcode/verify_code，盲跳会导流到第三方）。
 */

const logger: Logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: () => logger };

function tempStateDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "wx-login-flow-"));
}

/**
 * 脚本化 fetch：script[0] 响应用于 get_bot_qrcode，后续元素按序回放
 * get_qrcode_status；script 耗尽后回 expired 终止 5 分钟轮询循环。
 */
function scriptFetch(script: Array<Record<string, unknown>>) {
  const calls: string[] = [];
  let statusIdx = 0;
  const fetchMock = vi.fn(async (url: string | URL) => {
    calls.push(String(url));
    // 10ms 模拟网络往返——零延迟会让 5 分钟轮询窗口在测试窗口内无限空转
    await new Promise((r) => setTimeout(r, 10));
    let resp: Record<string, unknown>;
    if (String(url).includes("get_bot_qrcode")) {
      resp = script[0];
    } else {
      statusIdx += 1;
      resp = script[statusIdx] ?? { status: "expired" };
    }
    return new Response(JSON.stringify(resp), { status: 200 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return { calls, restore: () => vi.unstubAllGlobals() };
}

function makeFlow(store: WeixinAccountStore) {
  // 用真实 client（baseUrl 指向假域名，fetch 已全 mock 不出网）——
  // redirect 断言依赖 WeixinApiClient.withBaseUrl 真实派生新网关 client
  return new WeixinLoginFlow({
    api: new WeixinApiClient({ baseUrl: "https://ilinkai.weixin.qq.com" }),
    accountStore: store,
    onQrCode: () => {},
    logger,
  });
}

describe("WeixinLoginFlow (#571 scaned_but_redirect)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("收到 scaned_but_redirect + redirect_host 后切换网关，后续轮询打到新域名并 confirmed", async () => {
    const { calls, restore } = scriptFetch([
      { ret: 0, qrcode: "qr-1", qrcode_img_content: "https://x" },
      { status: "wait" },
      { status: "scaned_but_redirect", redirect_host: "szshort.weixin.qq.com" },
      { status: "confirmed", bot_token: "tok-new", ilink_user_id: "u-1" },
    ]);
    try {
      const store = new WeixinAccountStore({ stateDir: tempStateDir() });
      const flow = makeFlow(store);
      const { accountId, ilinkUserId } = await flow.run();
      expect(ilinkUserId).toBe("u-1");
      expect(accountId).toMatch(/^weixin-/);
      const pollUrls = calls.filter((u) => u.includes("get_qrcode_status"));
      // 前两轮在原网关，redirect 后轮询打到新网关
      expect(pollUrls[0]).toContain("https://ilinkai.weixin.qq.com/");
      expect(pollUrls[1]).toContain("https://ilinkai.weixin.qq.com/");
      expect(pollUrls[2]).toContain("https://szshort.weixin.qq.com/");
      expect(store.getAccount(accountId)?.token).toBe("tok-new");
    } finally {
      restore();
    }
  });

  it("baseurl 形式的重定向同样切换网关", async () => {
    const { calls, restore } = scriptFetch([
      { ret: 0, qrcode: "qr-1" },
      { status: "scaned_but_redirect", baseurl: "https://shlong.weixin.qq.com" },
      { status: "confirmed", bot_token: "tok", ilink_user_id: "u-2" },
    ]);
    try {
      const store = new WeixinAccountStore({ stateDir: tempStateDir() });
      await makeFlow(store).run();
      const pollUrls = calls.filter((u) => u.includes("get_qrcode_status"));
      expect(pollUrls[1]).toContain("https://shlong.weixin.qq.com/");
    } finally {
      restore();
    }
  });

  it("非白名单域拒绝切换：继续原网关轮询并告警", async () => {
    const { calls, restore } = scriptFetch([
      { ret: 0, qrcode: "qr-1" },
      { status: "scaned_but_redirect", redirect_host: "evil.example.com" },
      { status: "confirmed", bot_token: "tok", ilink_user_id: "u-3" },
    ]);
    try {
      const store = new WeixinAccountStore({ stateDir: tempStateDir() });
      await makeFlow(store).run();
      const pollUrls = calls.filter((u) => u.includes("get_qrcode_status"));
      // 拒绝后所有轮询都留在原网关
      for (const u of pollUrls) {
        expect(u).toContain("https://ilinkai.weixin.qq.com/");
        expect(u).not.toContain("evil.example.com");
      }
      // 拒绝切换的可观察副作用：下一次轮询仍留在原网关（上方已断言），
      // 且告警落日志——侧效应断言（warn 被触发），不绑定实现参数
      expect(vi.mocked(logger.warn).mock.calls.length).toBeGreaterThan(0);
    } finally {
      restore();
    }
  });

  it("redirect 状态缺 redirect_host/baseurl 时保持原网关（warn 兜底，不炸）", async () => {
    const { calls, restore } = scriptFetch([
      { ret: 0, qrcode: "qr-1" },
      { status: "scaned_but_redirect" },
      { status: "confirmed", bot_token: "tok", ilink_user_id: "u-4" },
    ]);
    try {
      const store = new WeixinAccountStore({ stateDir: tempStateDir() });
      await makeFlow(store).run();
      const pollUrls = calls.filter((u) => u.includes("get_qrcode_status"));
      expect(pollUrls.every((u) => u.includes("ilinkai.weixin.qq.com"))).toBe(true);
      expect(vi.mocked(logger.warn).mock.calls.length).toBeGreaterThan(0);
    } finally {
      restore();
    }
  });
});
