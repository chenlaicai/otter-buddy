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
    // #571 审视 S2：confirmed 下发的 baseurl 零校验落盘会被 platforms.ts 拿去建
    // 带 bot_token 的正式 client——Authorization 随行长驻，恶意域=长效凭证泄露。
    // 与 switchGateway 同一白名单收口；非白名单拒绝落盘（消费端有默认网关回退，
    // 无新增失败面），不炸登录流程。
    const persistBaseUrl = this.validateRedirectBase(st.baseurl, "confirmed baseurl");
    const accountId = `weixin-${Date.now().toString(36)}`;
    this.deps.accountStore.saveAccount({
      id: accountId,
      token: st.bot_token,
      ilinkBotId: st.ilink_bot_id,
      ilinkUserId: st.ilink_user_id,
      baseUrl: persistBaseUrl,
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
   *
   * 审视 S1 修复：校验对象统一为**最终实际使用的 URL 的 hostname**——原实现
   * 校验 redirect_host 却使用 baseurl，响应同时给合法 host + 恶意 baseurl 即绕过。
   */
  private switchGateway(st: WeixinQrStatusResp): void {
    // URL 选择优先级：baseurl（完整 URL）优先，redirect_host（纯主机名）兜底拼 https
    const candidate = st.baseurl ?? (st.redirect_host ? `https://${st.redirect_host}` : undefined);
    const newBase = this.validateRedirectBase(candidate, "scaned_but_redirect");
    if (!newBase) return; // 无字段/非白名单均已 warn，继续原网关轮询（行为=原实现）
    this.deps.api = this.deps.api.withBaseUrl(newBase);
    this.deps.logger.info("Weixin login gateway switched", { baseUrl: newBase });
  }

  /**
   * 重定向 URL 白名单校验（switchGateway 与 confirm 落盘共用——#571 审视 S1/S2/A1 收口）。
   * 校验对象 = 最终使用的 URL 经 URL 解析后的 hostname（非裸字符串 endsWith）：
   * - `evil.com@weixin.qq.com` 形态 URL 解析后 hostname 是 weixin.qq.com？不——
   *   userinfo 在 @ 前，hostname 是 @ 后的 weixin.qq.com，确实官方；但裸串 endsWith
   *   会把 `evil.com@weixin.qq.com` 也放行，而裸串拼进 https:// 后 undici 解析即炸。
   *   统一走 new URL() 解析，非法 URL fail-closed 拒绝。
   * 返回：合法 URL（原样）；非法/缺失/非白名单 → undefined（调用方继续原网关/不落盘）。
   */
  private validateRedirectBase(raw: string | undefined, scene: string): string | undefined {
    if (!raw) {
      // confirmed 场景常态无 baseurl（默认网关）——不是异常，不 warn；
      // redirect 场景缺跳转目标才是协议缺口（delta 复核：文案与频次错位修正）
      if (scene === "scaned_but_redirect") {
        this.deps.logger.warn(`Weixin ${scene}: no redirect target, keep current gateway`);
      }
      return undefined;
    }
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      this.deps.logger.warn(`Weixin ${scene}: redirect target is not a valid URL, refused`, { raw });
      return undefined;
    }
    // delta A1 残留：URL 带 credentials（user:pass@host）直接拒——undici 对带 credentials
    // 的 Request 会抛错，登录被打挂；且 credentials 出现在跳转目标里本身就可疑
    if (url.username || url.password) {
      this.deps.logger.warn(`Weixin ${scene}: redirect target carries credentials, refused`, { host: url.hostname });
      return undefined;
    }
    if (!WeixinApiClient.isAllowedRedirectHost(url.hostname)) {
      this.deps.logger.warn(`Weixin ${scene}: redirect host not in allowlist, refused`, { host: url.hostname });
      return undefined;
    }
    return raw;
  }
}
