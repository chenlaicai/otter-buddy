import { describe, it, expect, vi, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { WeixinLoginSessionManager } from "@frameworks/weixin/login-session-manager";
import { WeixinAccountStore } from "@frameworks/weixin/account-store";
import type { Logger } from "@usecases/ports/logger";

/**
 * web 扫码登录会话管理单测（issue #566）。
 * fetch 全 mock（复用 api-client.test.ts 的 capture 模式），断言会话状态机
 * 迁移：pending → waiting_scan（PNG 渲染）→ scaned → success + onSuccess 回调。
 */

const logger: Logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: () => logger };

function tempStateDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "wx-login-session-"));
}

/** mock fetch：按 URL 路由（get_bot_qrcode vs get_qrcode_status），状态按序回放。
 * script 耗尽后回 expired（终止 login-flow 轮询循环，防测试环境下无限空转 OOM）。
 * script 元素可为响应对象或返回响应的函数（对齐 api-client.test.ts 的 ok() 风格） */
function scriptFetch(script: unknown[]) {
  let statusIdx = 0;
  const resolve = (item: unknown): unknown => (typeof item === "function" ? (item as () => unknown)() : item);
  const fetchMock = vi.fn(async (url: string | URL) => {
    // 10ms 模拟网络往返——零延迟会让 login-flow 的 5 分钟轮询窗口在测试的
    // waitFor 窗口内无限空转（OOM / script 秒耗尽）
    await new Promise((r) => setTimeout(r, 10));
    let resp: unknown;
    if (String(url).includes("get_bot_qrcode")) {
      resp = resolve(script[0]);
    } else {
      statusIdx += 1;
      resp = resolve(script[statusIdx] ?? { status: "expired" });
    }
    // 后台 flow 可能比用例活得久：stop 后回 expired 让 login-flow 走终态退出
    if (stopped) resp = { status: "expired" };
    return new Response(JSON.stringify(resp), { status: 200 });
  });
  let stopped = false;
  const stopFn = () => {
    stopped = true;
    vi.unstubAllGlobals();
  };
  vi.stubGlobal("fetch", fetchMock);
  return stopFn;
}

describe("WeixinLoginSessionManager", () => {
  let restore: () => void;
  let mgr: WeixinLoginSessionManager;

  afterEach(() => {
    // 关键：先停掉后台轮询的 flow，再恢复 fetch——否则上一用例的 flow
    // 会继续消费下一用例的 mock script（双倍消耗，状态错乱）甚至真出网
    mgr?.dispose();
    restore?.();
    vi.restoreAllMocks();
  });

  it("start() 立即返回 pending 会话，不阻塞", () => {
    const store = new WeixinAccountStore({ stateDir: tempStateDir() });
    restore = scriptFetch([{ ret: 0, qrcode: "qr", qrcode_img_content: "https://qr.example/x" }]);
    mgr = new WeixinLoginSessionManager({ accountStore: store, logger });
    const s = mgr.start();
    expect(s.status).toBe("pending");
    expect(s.id).toMatch(/^wxlogin-/);
  });

  it("二维码到达后转 waiting_scan 且 qrcodePng 为 dataURL", async () => {
    const store = new WeixinAccountStore({ stateDir: tempStateDir() });
    // script：qrcode 后回 wait（有限轮），之后 expired 终止。10ms/轮的延迟
    // 让 waitFor 能及时看到 waiting_scan 状态
    const script: unknown[] = [{ ret: 0, qrcode: "qr", qrcode_img_content: "https://qr.example/x" }, ...Array.from({ length: 300 }, () => () => ({ status: "wait" }))];
    restore = scriptFetch(script);
    mgr = new WeixinLoginSessionManager({ accountStore: store, logger });
    const { id } = mgr.start();

    await vi.waitFor(() => {
      const s = mgr.get(id)!;
      expect(s.status).toBe("waiting_scan");
      expect(s.qrcodePng).toMatch(/^data:image\/png;base64,/);
    });
  });

  it("confirmed 后转 success、账号落盘、onSuccess 回调触发", async () => {
    const stateDir = tempStateDir();
    const store = new WeixinAccountStore({ stateDir });
    const onSuccess = vi.fn();
    restore = scriptFetch([
      { ret: 0, qrcode: "qr", qrcode_img_content: "https://qr.example/x" },
      { status: "scaned" },
      { status: "confirmed", bot_token: "tok-1", ilink_user_id: "u-1", ilink_bot_id: "b-1" },
    ]);
    mgr = new WeixinLoginSessionManager({ accountStore: store, logger, onSuccess });
    const { id } = mgr.start();

    await vi.waitFor(() => {
      const s = mgr.get(id)!;
      expect(s.status).toBe("success");
      expect(s.accountId).toBeDefined();
      expect(s.ilinkUserId).toBe("u-1");
    });
    // 账号已持久化
    const accounts = store.listAccounts();
    expect(accounts).toHaveLength(1);
    expect(accounts[0].token).toBe("tok-1");
  });

  it("expired 状态映射为 expired 终态", async () => {
    const store = new WeixinAccountStore({ stateDir: tempStateDir() });
    restore = scriptFetch([
      { ret: 0, qrcode: "qr", qrcode_img_content: "https://x" },
      { status: "expired" },
    ]);
    mgr = new WeixinLoginSessionManager({ accountStore: store, logger });
    const { id } = mgr.start();

    await vi.waitFor(() => {
      expect(mgr.get(id)!.status).toBe("expired");
    });
  });

  it("cancel() 后流仍在跑时：登录完成仍落盘（不回滚微信侧授权）", async () => {
    const store = new WeixinAccountStore({ stateDir: tempStateDir() });
    // 第 1 轮 wait（给 waitFor 留窗口），第 2 轮 confirmed——模拟扫码后用户确认。
    // mock 延迟 10ms，cancel 时 confirmed 可能已到（竞态窗口窄）——两种结局都合法：
    // a) cancel 先到：状态停 cancelled，账号保留，不热启动；
    // b) confirmed 先到：状态 success，账号保留 + onSuccess 触发
    restore = scriptFetch([
      { ret: 0, qrcode: "qr", qrcode_img_content: "https://x" },
      () => ({ status: "wait" }),
      { status: "confirmed", bot_token: "tok-2" },
    ]);
    const onSuccess = vi.fn();
    mgr = new WeixinLoginSessionManager({ accountStore: store, logger, onSuccess });
    const { id } = mgr.start();
    await vi.waitFor(() => expect(mgr.get(id)!.qrcodeUrl).toBeDefined());
    mgr.cancel(id); // 返回值竞态相关，不断言

    await vi.waitFor(() => {
      // 无论竞态走向：微信侧授权已成，账号必须落盘
      expect(store.listAccounts()).toHaveLength(1);
    });
    const final = mgr.get(id)!.status;
    expect(["cancelled", "success"]).toContain(final);
    // cancel 先到的分支不应热启动（onSuccess 只在 success 分支触发）
    expect(onSuccess.mock.calls.length === 0 || final === "success").toBe(true);
  });

  it("cancel() 幂等保护：终态会话不可取消", async () => {
    const store = new WeixinAccountStore({ stateDir: tempStateDir() });
    restore = scriptFetch([
      { ret: 0, qrcode: "qr", qrcode_img_content: "https://x" },
      { status: "expired" },
    ]);
    mgr = new WeixinLoginSessionManager({ accountStore: store, logger });
    const { id } = mgr.start();
    await vi.waitFor(() => expect(mgr.get(id)!.status).toBe("expired"));
    expect(mgr.cancel(id)).toBe(false);
  });

  it("pending 态取消后 QR 迟到：状态保持 cancelled，不被覆写回 waiting_scan（检视修复回归）", async () => {
    const store = new WeixinAccountStore({ stateDir: tempStateDir() });
    // script 耗尽后回 expired，让后台 flow 走终态退出，不残留轮询
    restore = scriptFetch([{ ret: 0, qrcode: "qr", qrcode_img_content: "https://qr.example/x" }]);
    mgr = new WeixinLoginSessionManager({ accountStore: store, logger });
    const { id } = mgr.start();
    // fetch 有 10ms 网络延迟——立即取消，制造「QR 迟到于 cancel」的确定竞态窗口
    expect(mgr.cancel(id)).toBe(true);
    expect(mgr.get(id)!.status).toBe("cancelled");

    await new Promise((r) => setTimeout(r, 60)); // 等 QR 到达 + onQrCode 回调触发
    const s = mgr.get(id)!;
    expect(s.status).toBe("cancelled"); // 会话不复活
    expect(s.qrcodeUrl).toBeUndefined(); // QR 不写入已取消会话
  });

  // ── #592：账号删除时的会话清理（防「删了又复活」）──
  describe("cancelByAccountId / cancelByIlinkUserId（#592）", () => {
    it("cancelByAccountId：仅取消该账号的非终态会话，终态不动", async () => {
      const store = new WeixinAccountStore({ stateDir: tempStateDir() });
      // 两轮 wait 后 script 耗尽回 expired，会话最终落 expired 终态（供终态断言）
      restore = scriptFetch([
        { ret: 0, qrcode: "qr", qrcode_img_content: "https://x" },
        () => ({ status: "wait" }),
        { status: "expired" },
      ]);
      mgr = new WeixinLoginSessionManager({ accountStore: store, logger });
      const a = mgr.start();
      await vi.waitFor(() => expect(mgr.get(a.id)!.status).toBe("expired"));

      // 手工构造另一条非终态会话（借用内部 sessions——直接用 start 开第二条）
      const b = mgr.start();
      await vi.waitFor(() => expect(mgr.get(b.id)!.qrcodeUrl).toBeDefined());
      // 模拟 success 后回填的 accountId（b 的 accountId 在 confirmed 前未知）
      // ——直接给 expired 的 a 借一个：a 已终态，不可被取消
      (mgr as any).sessions.get(a.id).accountId = "weixin-accX";

      const cancelled = mgr.cancelByAccountId("weixin-accX");
      expect(cancelled).toBe(0); // a 已终态，不动
      expect(mgr.get(a.id)!.status).toBe("expired");

      // b 无 accountId 且非终态：不被 accountId 路径取消
      expect(mgr.get(b.id)!.status).not.toBe("cancelled");
    });

    it("cancelByIlinkUserId：取消同扫码人的非终态会话并标记 account_deleted", async () => {
      const store = new WeixinAccountStore({ stateDir: tempStateDir() });
      restore = scriptFetch([
        { ret: 0, qrcode: "qr", qrcode_img_content: "https://x" },
        ...Array.from({ length: 50 }, () => () => ({ status: "wait" })),
      ]);
      mgr = new WeixinLoginSessionManager({ accountStore: store, logger });
      const s = mgr.start();
      await vi.waitFor(() => expect(mgr.get(s.id)!.qrcodeUrl).toBeDefined());
      // ilinkUserId 在 confirmed 后才回填——非终态期手动注入（模拟另一条已 success 的
      // 同人会话回填过 ilinkUserId 的删除场景）
      (mgr as any).sessions.get(s.id).ilinkUserId = "u1@im.wechat";

      const cancelled = mgr.cancelByIlinkUserId("u1@im.wechat");
      expect(cancelled).toBe(1);
      expect(mgr.get(s.id)!.status).toBe("cancelled");
      expect(mgr.get(s.id)!.cancellationReason).toBe("account_deleted");
    });

    it("删号后取消的会话扫码完成：不落盘不复活、onSuccess 不触发（#592 防复活核心）", async () => {
      const store = new WeixinAccountStore({ stateDir: tempStateDir() });
      // 30 轮 wait（300ms）拉开时间线：waitFor 看到 qrcodeUrl 后立即取消，
      // confirmed 在取消之后才到——模拟删号后微信侧授权才完成
      restore = scriptFetch([
        { ret: 0, qrcode: "qr", qrcode_img_content: "https://x" },
        ...Array.from({ length: 30 }, () => () => ({ status: "wait" })),
        { status: "confirmed", bot_token: "tok-del", ilink_user_id: "u1@im.wechat" },
      ]);
      const onSuccess = vi.fn();
      mgr = new WeixinLoginSessionManager({ accountStore: store, logger, onSuccess });
      const { id } = mgr.start();
      await vi.waitFor(() => expect(mgr.get(id)!.qrcodeUrl).toBeDefined());
      // 模拟删除账号时按扫码人取消：confirmed 后 ilinkUserId 回填前的窗口不可测，
      // 这里在 wait 阶段手动回填再取消（等价于删号路径对已 success 会话的 ilinkUserId 匹配）
      (mgr as any).sessions.get(id).ilinkUserId = "u1@im.wechat";
      expect(mgr.cancelByIlinkUserId("u1@im.wechat")).toBe(1);

      await vi.waitFor(() => {
        // 扫码完成后：账号不复活（removeAccount 生效——listAccounts 为空）
        expect(store.listAccounts()).toHaveLength(0);
      });
      expect(mgr.get(id)!.status).toBe("cancelled");
      expect(onSuccess).not.toHaveBeenCalled(); // 不热启动
    });

    it("双路径二次删除幂等：主路径先删 + account_deleted 分支后到二次 removeAccount，无残留无抛错（检视 #682 发现 1）", async () => {
      const store = new WeixinAccountStore({ stateDir: tempStateDir() });
      // 时序：主路径（onWeixinAccountDeleted）先删账号并取消会话，扫码 confirmed
      // 才后到——handleFlowSuccess 走 account_deleted 分支二次调用 removeAccount。
      // 幂等性依赖：delete raw[id]（key 不存在 no-op）+ rmSync({force:true})（路径
      // 不存在不抛）——本用例锁定该假设，防重构时被无检打破
      restore = scriptFetch([
        { ret: 0, qrcode: "qr", qrcode_img_content: "https://x" },
        ...Array.from({ length: 30 }, () => () => ({ status: "wait" })),
        { status: "confirmed", bot_token: "tok-dup", ilink_user_id: "u1@im.wechat" },
      ]);
      const onSuccess = vi.fn();
      mgr = new WeixinLoginSessionManager({ accountStore: store, logger, onSuccess });
      const { id } = mgr.start();
      await vi.waitFor(() => expect(mgr.get(id)!.qrcodeUrl).toBeDefined());
      (mgr as any).sessions.get(id).ilinkUserId = "u1@im.wechat";
      // 主路径先删：account-store removeAccount（id 为 login-flow 确认后回写的 id，
      // 直接用 token 衍生 id 模拟已落盘后被删）
      store.saveAccount({ id: "dup-acc", token: "tok-dup", ilinkUserId: "u1@im.wechat", addedAt: new Date().toISOString() });
      store.removeAccount("dup-acc");
      // 删号路径取消会话（标记 account_deleted）
      expect(mgr.cancelByIlinkUserId("u1@im.wechat")).toBe(1);

      await vi.waitFor(() => {
        // confirmed 后到：account_deleted 分支二次 removeAccount（this 时账号
        // id 由 flow 回传）——幂等成立则不抛、不复活
        expect(mgr.get(id)!.status).toBe("cancelled");
      });
      expect(store.listAccounts()).toHaveLength(0);
      expect(onSuccess).not.toHaveBeenCalled();
    });

    it("普通 cancel 的会话扫码完成：账号保留（既有语义不变，#592 不误伤）", async () => {
      const store = new WeixinAccountStore({ stateDir: tempStateDir() });
      restore = scriptFetch([
        { ret: 0, qrcode: "qr", qrcode_img_content: "https://x" },
        ...Array.from({ length: 30 }, () => () => ({ status: "wait" })),
        { status: "confirmed", bot_token: "tok-keep", ilink_user_id: "u2@im.wechat" },
      ]);
      const onSuccess = vi.fn();
      mgr = new WeixinLoginSessionManager({ accountStore: store, logger, onSuccess });
      const { id } = mgr.start();
      await vi.waitFor(() => expect(mgr.get(id)!.qrcodeUrl).toBeDefined());
      expect(mgr.cancel(id)).toBe(true); // 普通取消（无 account_deleted 标记）

      await vi.waitFor(() => {
        // 账号保留（既有语义：微信侧授权已成不回滚）
        expect(store.listAccounts()).toHaveLength(1);
      });
      expect(mgr.get(id)!.status).toBe("cancelled");
      expect(onSuccess).not.toHaveBeenCalled();
    });
  });
});
