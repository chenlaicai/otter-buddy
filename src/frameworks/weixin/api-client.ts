import { randomUUID } from "node:crypto";
import type {
  WeixinBaseInfo,
  WeixinGetConfigResp,
  WeixinGetUpdatesResp,
  WeixinGetUploadUrlReq,
  WeixinGetUploadUrlResp,
  WeixinMessage,
  WeixinMessageItem,
  WeixinQrCodeResp,
  WeixinQrStatusResp,
  WeixinSendMessageResp,
} from "./types";

/**
 * 微信 ilink bot API 客户端（协议直连，无 OpenClaw 宿主依赖）。
 *
 * 协议审计来源：@tencent-weixin/openclaw-weixin@2.4.6（MIT）src/api/api.ts。
 * 请求头契约：AuthorizationType: ilink_bot_token / X-WECHAT-UIN（随机 uint32 →
 * base64）/ iLink-App-Id: bot（包内写死值，无白名单）/ iLink-App-ClientVersion
 * （major<<16|minor<<8|patch 编码）。响应统一 ret=0 成功。
 *
 * 本类只做 HTTP 语义（成功/失败/超时），不承载重试与暂停策略——那些在
 * WeixinPollingChannel（monitor 语义）里。
 */
export class WeixinApiClient {
  /** bot_agent 自我声明（官方观测归因字段，不参与鉴权） */
  static readonly BOT_AGENT = "OtterBuddy/0.1.0";

  private readonly baseUrl: string;
  private readonly token?: string;
  /** F20260904wxeg：出站观测依赖（可选——不影响既有调用方，无 logger 时静默降级） */
  private readonly logger?: { info: (msg: string, ctx?: Record<string, unknown>) => void; error: (msg: string, err?: Error, ctx?: Record<string, unknown>) => void };

  constructor(options: { baseUrl: string; token?: string; logger?: WeixinApiClient["logger"] }) {
    // 去掉尾部斜杠，endpoint 拼接统一 this.baseUrl + "/" + endpoint
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.token = options.token;
    this.logger = options.logger;
  }

  /** 组装每请求自声明信息 */
  private baseInfo(): WeixinBaseInfo {
    return { channel_version: "0.1.0", bot_agent: WeixinApiClient.BOT_AGENT };
  }

  /** X-WECHAT-UIN：随机 uint32 → 十进制串 → base64（协议契约，非用户真实 uin） */
  private randomUin(): string {
    const uint32 = crypto.getRandomValues(new Uint32Array(1))[0];
    return btoa(String(uint32));
  }

  /**
   * GET 请求公共头（#624，对齐参考实现 buildCommonHeaders()）：
   * 鉴权/自声明字段，**无 Content-Type**（GET 无 body）。
   * 注意每次调用生成新 X-WECHAT-UIN（与参考实现同构，非每实例固定）。
   */
  private buildCommonHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      AuthorizationType: "ilink_bot_token",
      "X-WECHAT-UIN": this.randomUin(),
      "iLink-App-Id": "bot",
      // 0.1.0 → (0<<16)|(1<<8)|0 = 256；与插件编码规则一致（major<<16|minor<<8|patch）
      "iLink-App-ClientVersion": String((0 << 16) | (1 << 8) | 0),
    };
    if (this.token?.trim()) {
      headers.Authorization = `Bearer ${this.token.trim()}`;
    }
    return headers;
  }

  /** POST 请求头：公共头 + Content-Type（仅 POST 搞 JSON body，#624） */
  private buildPostHeaders(): Record<string, string> {
    return { "Content-Type": "application/json", ...this.buildCommonHeaders() };
  }

  /** GET 语义：目前仅扫码状态轮询使用（见 pollQrStatus 的协议注释） */
  private async get<T>(endpointWithQuery: string, timeoutMs: number): Promise<T> {
    const res = await fetch(`${this.baseUrl}/${endpointWithQuery}`, {
      method: "GET",
      headers: this.buildCommonHeaders(),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      throw new Error(`weixin api ${endpointWithQuery.split("?")[0]} HTTP ${res.status}`);
    }
    return (await res.json()) as T;
  }

  /** POST 语义：非 2xx 抛错；2xx 但 ret≠0 由调用方按业务分支处理（长轮询有专门语义） */
  private async post<T>(endpoint: string, body: Record<string, unknown>, timeoutMs: number): Promise<T> {
    const res = await fetch(`${this.baseUrl}/${endpoint}`, {
      method: "POST",
      headers: this.buildPostHeaders(),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      throw new Error(`weixin api ${endpoint} HTTP ${res.status}`);
    }
    return (await res.json()) as T;
  }

  /** 申请扫码二维码（无需 token） */
  requestQrCode(timeoutMs = 15000): Promise<WeixinQrCodeResp> {
    return this.post(
      "ilink/bot/get_bot_qrcode?bot_type=3",
      { local_token_list: [], base_info: this.baseInfo() },
      timeoutMs,
    );
  }

  /**
   * 长轮询扫码状态（无需 token）。
   *
   * ⚠️ 本端点是 ilink API 的 GET 例外：qrcode/verify_code 走 query 参数，
   * 不走 POST JSON body——POST 会被网关静默吞掉（HTTP 200 + ret:1，无
   * status 字段），扫码事件永远收不到（2026-08-31 真机验收发现，对照
   * openclaw-weixin@2.4.6 login-qr.ts pollQRStatus 的 GET 实现修正）。
   * 参考实现无 get_qrcode_status_buf 游标（该字段在本插件源码中不存在，
   * 系 PoC 误引），轮询间隔由服务端 hold + 客户端 1s 兜底控制。
   * 客户端超时（35s 无事件）视为 wait 继续轮询，不当错误处理。
   */
  async pollQrStatus(params: { qrcode: string; verify_code?: string }, timeoutMs = 35000): Promise<WeixinQrStatusResp> {
    const qs = new URLSearchParams({ qrcode: params.qrcode });
    if (params.verify_code) qs.set("verify_code", params.verify_code);
    try {
      return await this.get(`ilink/bot/get_qrcode_status?${qs.toString()}`, timeoutMs);
    } catch (err) {
      // 长轮询超时/瞬时网络错误 → wait 语义继续轮询（与参考实现一致），
      // 不让会话直接进 error 终态
      if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) {
        return { status: "wait" };
      }
      throw err;
    }
  }

  /** 长轮询收消息。游标语义：首次空串，服务端返回新游标下轮回传 */
  getUpdates(getUpdatesBuf: string, timeoutMs = 35000): Promise<WeixinGetUpdatesResp> {
    return this.post(
      "ilink/bot/getupdates",
      { get_updates_buf: getUpdatesBuf, base_info: this.baseInfo() },
      timeoutMs,
    );
  }

  /** 发送文本消息。ret≠0 抛错（出站失败要显式暴露，不做静默降级） */
  async sendTextMessage(params: { toUserId: string; contextToken?: string; text: string }): Promise<void> {
    const msg: WeixinMessage = {
      from_user_id: "",
      to_user_id: params.toUserId,
      // client_id：bot 侧生成的事件 id（幂等去重键），UUID 满足唯一性
      client_id: randomUUID(),
      message_type: 2,
      message_state: 2,
      item_list: [{ type: 1, text_item: { text: params.text } }],
      context_token: params.contextToken,
    };
    // F20260904wxeg：出站全量观测——sendmessage 是 iLink「假成功」重灾区（ret=0 但微信侧
    // 不投递），入参/响应逐字段留痕，排查不再依赖「无错误日志」的反推（#213 教训）
    const startedAt = Date.now();
    let resp: WeixinSendMessageResp;
    try {
      resp = await this.post(
        "ilink/bot/sendmessage",
        { msg, base_info: this.baseInfo() },
        15000,
      ) as WeixinSendMessageResp;
    } catch (err) {
      this.logger?.error("weixin sendmessage transport failed", err instanceof Error ? err : undefined, {
        toUserId: params.toUserId, clientId: msg.client_id,
        textLength: params.text.length, hasContextToken: Boolean(params.contextToken),
        elapsedMs: Date.now() - startedAt,
      });
      throw err;
    }
    this.logger?.info("weixin sendmessage response", {
      toUserId: params.toUserId,
      clientId: msg.client_id,
      textLength: params.text.length,
      hasContextToken: Boolean(params.contextToken),
      ret: resp.ret,
      errcode: resp.errcode,
      errmsg: resp.errmsg,
      elapsedMs: Date.now() - startedAt,
    });
    // errcode 通道同步校验（F137 教训：errcode≠0 但 ret 缺失时旧逻辑会静默放行）
    if (resp.errcode !== undefined && resp.errcode !== 0) {
      throw new Error(`weixin sendmessage errcode=${resp.errcode} errmsg=${resp.errmsg ?? "(none)"}`);
    }
    if (resp.ret !== undefined && resp.ret !== 0) {
      throw new Error(`weixin sendmessage ret=${resp.ret} errmsg=${resp.errmsg ?? "(none)"}`);
    }
  }

  /** 拉取账号配置（typing_ticket，用于 sendTyping） */
  getConfig(ilinkUserId: string, contextToken?: string, timeoutMs = 10000): Promise<WeixinGetConfigResp> {
    return this.post(
      "ilink/bot/getconfig",
      { ilink_user_id: ilinkUserId, context_token: contextToken, base_info: this.baseInfo() },
      timeoutMs,
    );
  }

  /** 媒体上传：申请预签名 CDN 上传 URL（issue #567） */
  getUploadUrl(params: WeixinGetUploadUrlReq, timeoutMs = 15000): Promise<WeixinGetUploadUrlResp> {
    return this.post("ilink/bot/getuploadurl", { ...params, base_info: this.baseInfo() }, timeoutMs);
  }

  /** 发送结构化 item 列表（媒体出站用；文本/媒体各一 item，逐 item 独立请求）。ret≠0 抛错 */
  async sendMessageItems(params: { toUserId: string; contextToken?: string; items: WeixinMessageItem[] }): Promise<void> {
    for (const item of params.items) {
      const msg: WeixinMessage = {
        from_user_id: "",
        to_user_id: params.toUserId,
        client_id: randomUUID(),
        message_type: 2,
        message_state: 2,
        item_list: [item],
        context_token: params.contextToken,
      };
      const resp = await this.post(
        "ilink/bot/sendmessage",
        { msg, base_info: this.baseInfo() },
        15000,
      ) as WeixinSendMessageResp;
      if (resp.ret !== undefined && resp.ret !== 0) {
        throw new Error(`weixin sendmessage ret=${resp.ret} errmsg=${resp.errmsg ?? "(none)"}`);
      }
    }
  }

  /** 发送/取消"正在输入"状态（1=typing 2=cancel） */
  sendTyping(params: { ilinkUserId: string; typingTicket: string; status: 1 | 2 }, timeoutMs = 10000): Promise<void> {
    return this.post(
      "ilink/bot/sendtyping",
      {
        ilink_user_id: params.ilinkUserId,
        typing_ticket: params.typingTicket,
        status: params.status,
        base_info: this.baseInfo(),
      },
      timeoutMs,
    ).then(() => undefined);
  }

  /** 通道停止通知（进程关闭时礼貌告知服务端断开长轮询） */
  notifyStop(timeoutMs = 10000): Promise<void> {
    return this.post("ilink/bot/msg/notifystop", { base_info: this.baseInfo() }, timeoutMs).then(() => undefined);
  }
}
