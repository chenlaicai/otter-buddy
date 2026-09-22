import type { Logger } from "@usecases/ports/logger";
import type { WeixinAccountStore } from "./account-store";
import { WeixinApiClient } from "./api-client";
import type { WeixinQrStatus, WeixinQrStatusResp } from "./types";

/**
 * 微信扫码登录流程（frameworks 层）。
 *
 * get_bot_qrcode → 终端渲染二维码 → 长轮询 get_qrcode_status → confirmed
 * 落 bot_token + ilink_user_id 到账号存储。CLI（npm run weixin:login）与
 * PR② 的 web UI 共用本流程。
 *
 * need_verifycode / verify_code_blocked：微信对新设备/风控场景要求的配对码
 * 流程（openclaw 插件走 stdin 输入）。CLI 场景通过 verifyCodeInput 回调注入。
 */
export class WeixinLoginFlow {
  private static readonly MAX_WAIT_MS = 5 * 60_000;

  constructor(
    private readonly deps: {
      api: WeixinApiClient;
      accountStore: WeixinAccountStore;
      /** 二维码渲染回调（CLI 渲终端二维码；PR② web UI 换成推给前端） */
      onQrCode: (qrUrl: string) => void;
      /** 状态播报（可选，进度显示用） */
      onStatus?: (status: WeixinQrStatus | string) => void;
      /** 配对码输入回调（风控场景；不提供则直接失败并提示） */
      verifyCodeInput?: () => Promise<string>;
      logger: Logger;
    },
  ) {}

  /**
   * 执行完整登录。返回账号 id（已落盘）。
   */
  async run(): Promise<{ accountId: string; ilinkUserId?: string }> {
    const qr = await this.deps.api.requestQrCode();
    if (!qr.qrcode) {
      throw new Error(`申请二维码失败: ret=${qr.ret} errmsg=${qr.errmsg ?? "(none)"}`);
    }
    if (qr.qrcode_img_content) this.deps.onQrCode(qr.qrcode_img_content);

    const deadline = Date.now() + WeixinLoginFlow.MAX_WAIT_MS;
    while (Date.now() < deadline) {
      const next = await this.pollRound(qr.qrcode);
      if (next) return { accountId: next.accountId, ilinkUserId: next.ilinkUserId };
    }
    throw new Error("等待扫码超时（5 分钟）");
  }

  /** 一轮状态轮询：返回确认结果（null = 继续轮询） */
  private async pollRound(qrcode: string): Promise<{ accountId: string; ilinkUserId?: string } | null> {
    const st = await this.pollOnce(qrcode);
    this.deps.onStatus?.(st.status ?? "unknown");

    if (st.status === "confirmed") {
      return this.confirm(st);
    }

    const outcome = await this.handleNonConfirmed(st, qrcode);
    if (outcome === "abort-loop") {
      return null; // wait/scaned 等继续轮询
    }
    // verify_code 分支已消费一次带码轮询，可能直接 confirmed
    this.deps.onStatus?.(outcome.status ?? "unknown");
    if (outcome.status === "confirmed") {
      return this.confirm(outcome);
    }
    return null;
  }

  private pollOnce(qrcode: string, verifyCode?: string): Promise<WeixinQrStatusResp> {
    return this.deps.api.pollQrStatus({ qrcode, ...(verifyCode ? { verify_code: verifyCode } : {}) });
  }


  /** confirmed 落盘并返回账号信息 */
  private confirm(st: WeixinQrStatusResp): { accountId: string; ilinkUserId?: string } {
    if (!st.bot_token) throw new Error("扫码 confirmed 但未返回 bot_token");
    const accountId = `weixin-${Date.now().toString(36)}`;
    this.deps.accountStore.saveAccount({
      id: accountId,
      token: st.bot_token,
      ilinkBotId: st.ilink_bot_id,
      ilinkUserId: st.ilink_user_id,
      baseUrl: st.baseurl,
      addedAt: new Date().toISOString(),
    });
    this.deps.logger.info("Weixin login confirmed", { accountId, ilinkUserId: st.ilink_user_id });
    return { accountId, ilinkUserId: st.ilink_user_id };
  }

  /**
   * 非 confirmed 状态处理。
   * 返回："abort-loop"（继续外层轮询）或带码轮询后的新状态（可能 confirmed）。
   */
  private async handleNonConfirmed(st: WeixinQrStatusResp, qrcode: string): Promise<"abort-loop" | WeixinQrStatusResp> {
    switch (st.status) {
      case "expired":
        throw new Error("二维码已过期，请重新发起登录");
      case "verify_code_blocked":
        throw new Error("配对码验证被限流，请稍后重试");
      case "need_verifycode": {
        if (!this.deps.verifyCodeInput) {
          throw new Error("微信要求输入配对码验证，当前环境不支持交互输入——请在终端 CLI 执行 npm run weixin:login");
        }
        const code = await this.deps.verifyCodeInput();
        // 配对码随下一轮状态轮询回传（GET query 参数，协议：pendingVerifyCode 模式）
        return this.pollOnce(qrcode, code);
      }
      case "scaned_but_redirect":
        // #571：协议语义要求切换到 redirect_host 指向的新网关重试（IDC 分片），
        // 原实现在原网关轮询到 5 分钟超时永远等不到 confirmed。
        this.switchGateway(st);
        return "abort-loop";
      default:
        // wait / scaned：透传状态给上层继续轮询
        return "abort-loop";
    }
  }

  /**
   * #571：扫码重定向网关切换。redirect_host（纯主机名）或 baseurl（完整 URL）
   * 指示新轮询网关；切后本实例后续轮询全部走新网关。
   * 安全：非微信官方域拒绝切换（白名单校验），防服务端下发任意域名时扫码
   * 轮询（含 qrcode/verify_code 参数）被导流到第三方主机。
   */
  private switchGateway(st: WeixinQrStatusResp): void {
    const host = st.redirect_host ?? this.extractHost(st.baseurl);
    if (!host) {
      this.deps.logger.warn("Weixin scaned_but_redirect without redirect_host/baseurl, keep polling on current gateway");
      return;
    }
    if (!WeixinApiClient.isAllowedRedirectHost(host)) {
      this.deps.logger.warn("Weixin redirect host not in allowlist, refused gateway switch", { host });
      return;
    }
    const newBase = st.baseurl ?? `https://${host}`;
    this.deps.api = this.deps.api.withBaseUrl(newBase);
    this.deps.logger.info("Weixin login gateway switched", { host, baseUrl: newBase });
  }

  private extractHost(url?: string): string | undefined {
    if (!url) return undefined;
    try {
      return new URL(url).hostname;
    } catch {
      return undefined;
    }
  }
}
