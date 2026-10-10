import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { botKey } from "@frameworks/feishu/bot-key";
import { maskAppId } from "@frameworks/feishu/long-connection-client";
import { FeishuAppStore } from "@frameworks/feishu/app-store";
import {
  FeishuLoginSessionManager,
  describeFeishuQrFailure,
  FEISHU_QR_UNKNOWN_FAILURE_TEXT,
} from "@frameworks/feishu/login-session-manager";
import * as sdk from "@larksuiteoapi/node-sdk";
import type { Logger } from "@usecases/ports/logger";

/**
 * F20260928fsqr 单测：bot-key 统一派生 + app-store CRUD + 扫码登录会话状态机。
 * registerApp 全 mock（sdk 模块级 spy——真流程要出网到 accounts.feishu.cn）。
 */

const logger: Logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: () => logger };

function tempStateDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "fsqr-store-"));
}

describe("botKey 统一派生（F20260921wxba 键分裂防线）", () => {
  it("provision 键 === 入站路由锚（FeishuClient 同款掩码形态）", () => {
    const appId = "cli_a1b2c3d4e5f6g7h8";
    expect(botKey(appId)).toBe(`feishu-bot:${maskAppId(appId)}`);
    // 非 appKey 原文（防退化：原始 appId 直接拼会键分裂）
    expect(botKey(appId)).not.toBe(`feishu-bot:${appId}`);
  });

  it("超短 appId 走全掩码分支不抛错", () => {
    expect(botKey("cli")).toBe(`feishu-bot:${maskAppId("cli")}`);
    expect(botKey("")).toBe("feishu-bot:");
  });
});

describe("FeishuAppStore CRUD", () => {
  let dir: string;

  beforeEach(() => {
    dir = tempStateDir();
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("save → list → getApp → remove 全链（持久化到 feishu-apps.json）", () => {
    const store = new FeishuAppStore(dir);
    expect(store.listApps()).toEqual([]);

    store.saveApp({ appId: "cli_aaa111", appSecret: "s1", ownerOpenId: "ou_1", name: "joy 线", addedAt: "2026-09-28T00:00:00Z" });
    store.saveApp({ appId: "cli_bbb222", appSecret: "s2", addedAt: "2026-09-28T01:00:00Z" });

    expect(store.listApps().map((a) => a.appId).sort()).toEqual(["cli_aaa111", "cli_bbb222"]);
    // ownerOpenId 双层可选（SDK user_info 可缺席）——记录上不带该字段
    expect(store.getApp("cli_bbb222")).toMatchObject({ appId: "cli_bbb222", appSecret: "s2" });
    expect(store.getApp("cli_bbb222")!.ownerOpenId).toBeUndefined();

    store.removeApp("cli_aaa111");
    expect(store.getApp("cli_aaa111")).toBeUndefined();
    expect(store.listApps()).toHaveLength(1);
  });

  it("同 appId 重复 save 是 upsert（重扫覆盖旧凭据）", () => {
    const store = new FeishuAppStore(dir);
    store.saveApp({ appId: "cli_x", appSecret: "old", addedAt: "t1" });
    store.saveApp({ appId: "cli_x", appSecret: "new", ownerOpenId: "ou_9", addedAt: "t2" });
    expect(store.listApps()).toHaveLength(1);
    expect(store.getApp("cli_x")).toMatchObject({ appSecret: "new", ownerOpenId: "ou_9" });
  });

  it("store 文件损坏（非法 JSON）→ listApps 空集不抛错", () => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "feishu-apps.json"), "{broken json");
    const store = new FeishuAppStore(dir);
    expect(store.listApps()).toEqual([]);
  });
});

describe("describeFeishuQrFailure 文案映射（不透传第三方原文）", () => {
  it("已知 code 确定映射", () => {
    expect(describeFeishuQrFailure({ code: "expired_token" })).toContain("已过期");
    expect(describeFeishuQrFailure({ code: "access_denied" })).toContain("拒绝");
  });
  it("未知 code / 非 object / 含可疑 description → 统一兜底文案", () => {
    expect(describeFeishuQrFailure({ code: "weird", description: "internal req abc" })).toBe(FEISHU_QR_UNKNOWN_FAILURE_TEXT);
    expect(describeFeishuQrFailure(new Error("boom"))).toBe(FEISHU_QR_UNKNOWN_FAILURE_TEXT);
    expect(describeFeishuQrFailure(undefined)).toBe(FEISHU_QR_UNKNOWN_FAILURE_TEXT);
  });
});

describe("FeishuLoginSessionManager 状态机（registerApp mock）", () => {
  const registerAppSpy = vi.spyOn(sdk, "registerApp");

  afterEach(() => {
    registerAppSpy.mockReset();
  });

  it("start → pending；onQRCodeReady → waiting_scan + PNG 渲染", async () => {
    registerAppSpy.mockImplementation(async (opts) => {
      opts.onQRCodeReady({ url: "https://accounts.feishu.cn/device-code/abc", expireIn: 300 });
      return { client_id: "cli_ok", client_secret: "sec" } as never;
    });
    // onSuccess 副本断言（非 mock 参数断言）：凭据快照落入回调副作用
    let gotCreds: { appId?: string; appSecret?: string; ownerOpenId?: string; name?: string } | undefined;
    const mgr = new FeishuLoginSessionManager({ logger, onSuccess: async (creds) => { gotCreds = { ...creds }; } });

    const s0 = mgr.start("joy 线");
    expect(s0.id).toMatch(/^fslogin-/);
    // mock 同步跑完 QR+resolve：终态 success，但 QR 字段已落会话（供前端渲染）
    await vi.waitFor(() => {
      const s = mgr.get(s0.id)!;
      expect(s.status).toBe("success");
      expect(s.qrcodeUrl).toContain("device-code");
      expect(s.qrcodePng).toMatch(/^data:image\/png;base64,/);
    });
    await vi.waitFor(() => expect(gotCreds).toEqual(expect.objectContaining({ appId: "cli_ok", appSecret: "sec", name: "joy 线" })));
    expect(mgr.get(s0.id)!.status).toBe("success");
  });

  it("ownerOpenId 双层可选：user_info 缺席时 credentials 不带该字段", async () => {
    registerAppSpy.mockImplementation(async (opts) => {
      opts.onQRCodeReady({ url: "https://x", expireIn: 300 });
      return { client_id: "cli_nouser", client_secret: "s" } as never; // 无 user_info
    });
    // ownerOpenId 缺失：凭据副本不含该字段
    let gotCreds2: { ownerOpenId?: string } | undefined;
    const mgr2 = new FeishuLoginSessionManager({ logger, onSuccess: async (creds) => { gotCreds2 = { ...creds }; } });
    mgr2.start();
    await vi.waitFor(() => expect(gotCreds2).toBeDefined());
    expect(gotCreds2!.ownerOpenId).toBeUndefined();
  });

  it("registerApp 拒绝（expired_token）→ 会话 expired + 确定文案", async () => {
    registerAppSpy.mockRejectedValue({ code: "expired_token", description: "raw third-party" });
    const mgr = new FeishuLoginSessionManager({ logger });
    const s = mgr.start();
    await vi.waitFor(() => {
      expect(mgr.get(s.id)!.status).toBe("expired");
      expect(mgr.get(s.id)!.error).toContain("已过期");
    });
  });

  it("cancel → cancelled 终态（终态后 QR 异步到达不覆写）", async () => {
    let releaseQr: (() => void) | undefined;
    registerAppSpy.mockImplementation(async (opts) => {
      await new Promise<void>((r) => (releaseQr = r));
      opts.onQRCodeReady({ url: "https://late", expireIn: 300 });
      return { client_id: "cli_late", client_secret: "s" } as never;
    });
    const onSuccess = vi.fn();
    const mgr = new FeishuLoginSessionManager({ logger, onSuccess });
    const s = mgr.start();
    expect(mgr.cancel(s.id)).toBe(true);
    expect(mgr.get(s.id)!.status).toBe("cancelled");
    releaseQr?.();
    await new Promise((r) => setTimeout(r, 30));
    // 已取消：QR/成功回调都不覆写终态
    expect(mgr.get(s.id)!.status).toBe("cancelled");
    expect(mgr.get(s.id)!.qrcodeUrl).toBeUndefined();
    expect(onSuccess).not.toHaveBeenCalled();
  });

  it("onSuccess 自身失败：会话仍 success（app 已建成，provision 可补建）+ error 日志", async () => {
    registerAppSpy.mockImplementation(async (opts) => {
      opts.onQRCodeReady({ url: "https://x", expireIn: 300 });
      return { client_id: "cli_p", client_secret: "s" } as never;
    });
    const errorLog = vi.fn();
    const l: Logger = { ...logger, error: errorLog };
    const mgr = new FeishuLoginSessionManager({ logger: l, onSuccess: async () => { throw new Error("provision 炸了"); } });
    const s = mgr.start();
    await vi.waitFor(() => expect(errorLog).toHaveBeenCalled());
    expect(mgr.get(s.id)!.status).toBe("success");
  });

  it("F20261010fspm：registerApp 携带 addons 增量权限（发言人真名两权限，治本扫码 app 权限缺失）", async () => {
    let capturedOpts: { addons?: { scopes?: { tenant?: string[] } } } | undefined;
    registerAppSpy.mockImplementation(async (opts) => {
      capturedOpts = opts as typeof capturedOpts;
      opts.onQRCodeReady({ url: "https://x", expireIn: 300 });
      return { client_id: "cli_addons", client_secret: "s" } as never;
    });
    const mgr = new FeishuLoginSessionManager({ logger, onSuccess: async () => {} });
    mgr.start();
    await vi.waitFor(() => expect(capturedOpts).toBeDefined());
    // additive 语义：不传 preset:false（保留默认模板底座），只叠加业务 scope
    expect(capturedOpts!.addons?.scopes?.tenant).toEqual(
      expect.arrayContaining(["contact:contact.base:readonly", "im:chat.members:read"]),
    );
  });
});
