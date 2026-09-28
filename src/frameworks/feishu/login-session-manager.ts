import qrcode from "qrcode";
import { registerApp } from "@larksuiteoapi/node-sdk";
import type { Logger } from "@usecases/ports/logger";


/**
 * F20260928fsqr：飞书扫码建应用会话管理（frameworks 层）。
 *
 * 每次「发起扫码」创建一个会话：后台跑 SDK registerApp（RFC 8628 设备授权流，
 * accounts.feishu.cn），前端轮询会话状态渲染二维码与进度。结构对齐微信
 * login-session-manager（issue #566 先例），差异：
 *  - SDK 无 scanned 态（onStatusChange 仅 polling/slow_down/domain_switched）
 *    ——状态机不含「已扫码等确认」，waiting_scan 直达 success
 *  - 凭据由 SDK 返回（registerApp 自动建 app），onSuccess 回调注入落库+起线
 *
 * 生命周期：pending → waiting_scan → success（app 已落盘）/ error / expired /
 * cancelled。终态会话保留 10 分钟（供前端取终态）后清理。
 */

export type FeishuLoginSessionStatus =
  | "pending" // 二维码申请中
  | "waiting_scan" // 码已出，等扫码+确认（无中间态，直达终态）
  | "success" // app 已创建落盘
  | "expired"
  | "error"
  | "cancelled";

export interface FeishuLoginSession {
  id: string;
  status: FeishuLoginSessionStatus;
  /** PNG dataURL（pending 期间无） */
  qrcodePng?: string;
  /** 飞书扫码链接原文 */
  qrcodeUrl?: string;
  /** 成功后回填 */
  appId?: string;
  ownerOpenId?: string;
  error?: string;
  createdAt: string;
  /** 取消原因标记——app_deleted 值保留为未来删除联动预留（当前 createOnly 流无同 id
   *  复活面，微信式「取消时同步删号」不适用；检视 N2 口径修正） */
  cancellationReason?: "app_deleted";
}

/** 注册成功回调（app.ts 注入：落库 + resolver 锚 + 起 WS + provision 助理线） */
export type OnFeishuLoginSuccess = (credentials: {
  appId: string;
  appSecret: string;
  ownerOpenId?: string;
  /** 助理线名（扫码页起名；appPreset 预填同源） */
  name?: string;
}) => void | Promise<void>;

/**
 * 扫码注册失败的用户可见文案（EchoAgent 同款映射）。SDK 1.73.x 的 registerApp
 * 拒绝值是 { code, description } 纯对象（非 Error），description 是第三方原文，
 * 可能夹带请求或凭据信息——只做已知 code 的确定映射，其余一律未知兜底，
 * 不透传任何原始字段。
 */
const KNOWN_QR_FAILURE_TEXT: Record<string, string> = {
  expired_token: "二维码已过期，请重新生成二维码后再扫码。",
  access_denied: "本次授权未完成或已被拒绝，请重新扫码并在手机上确认授权。",
};

export const FEISHU_QR_UNKNOWN_FAILURE_TEXT =
  "飞书扫码接入失败，暂时无法确定具体原因，请重新生成二维码后重试。";

export function describeFeishuQrFailure(error: unknown): string {
  if (typeof error === "object" && error !== null) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && Object.prototype.hasOwnProperty.call(KNOWN_QR_FAILURE_TEXT, code)) {
      return KNOWN_QR_FAILURE_TEXT[code];
    }
  }
  return FEISHU_QR_UNKNOWN_FAILURE_TEXT;
}

const SESSION_TTL_MS = 10 * 60_000;

export class FeishuLoginSessionManager {
  private readonly sessions = new Map<string, FeishuLoginSession>();
  /** 会话 id → 取消句柄（registerApp 的 AbortController） */
  private readonly aborts = new Map<string, () => void>();
  /** 助理线名（扫码页起名）——appPreset 预填 + 落库 */
  private readonly sessionNames = new Map<string, string>();

  constructor(
    private readonly deps: {
      onSuccess?: OnFeishuLoginSuccess;
      /** appPreset 应用名模板（缺省不带名字预填） */
      appPresetName?: (userName: string) => string;
      logger: Logger;
    },
  ) {}

  /** 发起一次扫码建应用（后台异步执行，立即返回会话 id）。name：助理线名（预填应用名） */
  start(name?: string): FeishuLoginSession {
    const id = `fslogin-${Date.now().toString(36)}`;
    const session: FeishuLoginSession = {
      id,
      status: "pending",
      createdAt: new Date().toISOString(),
    };
    this.sessions.set(id, session);
    if (name && name.trim()) this.sessionNames.set(id, name.trim());

    // EchoAgent 同构：AbortController 支持取消（防孤儿后台流程）
    const abortController = new AbortController();
    this.aborts.set(id, () => abortController.abort());

    void registerApp(this.buildRegisterOptions(session, abortController.signal, name)).then(
      (result) => this.handleRegisterSuccess(session, result, name),
      (error) => this.handleRegisterFailure(session, error),
    );

    this.scheduleCleanup();
    return { ...session };
  }

  /** registerApp 选项拼装（拆出控 start 复杂度）：QR 回调 + appPreset 预填 + 取消信号。
   *  F20260928fsqr（检视严重 6）：createOnly: true——D3 钉死（SDK 注释明示：不传时若
   *  用户扫过同 source 的码会走「绑定既有 app 更新」流，覆盖其 webhook 配置） */
  private buildRegisterOptions(session: FeishuLoginSession, signal: AbortSignal, name?: string) {
    const id = session.id;
    return {
      source: "otter-buddy",
      signal,
      createOnly: true,
      onQRCodeReady: ({ url }: { url: string; expireIn?: number }) => {
        if (session.status === "cancelled") return; // QR 异步到达时可能已取消——不覆写终态
        session.qrcodeUrl = url;
        session.status = "waiting_scan";
        qrcode
          .toDataURL(url, { width: 280, margin: 1 })
          .then((png) => {
            session.qrcodePng = png;
          })
          .catch((err) => {
            this.deps.logger.warn("Feishu login QR PNG render failed", {
              sessionId: id,
              error: err instanceof Error ? err.message : String(err),
            });
          });
      },
      // 起名流入 appPreset（EchoAgent feishu-login.ts:50-51 同构——扫码确认页应用名有语义）
      ...(name?.trim() && this.deps.appPresetName && {
        appPreset: {
          name: this.deps.appPresetName(name.trim()),
          desc: "Otter Buddy IM assistant line.",
        },
      }),
    };
  }

  /** 注册成功：终态 success + onSuccess 回调（失败不阻终态——app 已建成，provision 可补建） */
  private handleRegisterSuccess(
    session: FeishuLoginSession,
    result: { client_id: string; client_secret: string; user_info?: { open_id?: string } },
    name?: string,
  ): void {
    if (session.status === "cancelled") return;
    const credentials = {
      appId: result.client_id,
      appSecret: result.client_secret,
      ...(result.user_info?.open_id ? { ownerOpenId: result.user_info.open_id } : {}),
    };
    session.appId = credentials.appId;
    session.ownerOpenId = credentials.ownerOpenId;
    session.status = "success";
    // onSuccess 的失败是第一方的（落库/起线等），注册本身已成功——
    // 状态保持 success（app 已建成），失败细节走 error 日志（不覆盖终态，
    // 前端从账号列表看到 app 存在，可走「补建线」入口）
    Promise.resolve(this.deps.onSuccess?.({ ...credentials, name: name?.trim() }))
      .catch((err) => {
        this.deps.logger.error("Feishu login onSuccess handler failed", err instanceof Error ? err : undefined, { sessionId: session.id, appId: credentials.appId });
      });
  }

  /** 注册失败：确定文案映射 + expired/error 分流 */
  private handleRegisterFailure(session: FeishuLoginSession, error: unknown): void {
    if (session.status === "cancelled") return;
    const text = describeFeishuQrFailure(error);
    session.error = text;
    session.status = text === KNOWN_QR_FAILURE_TEXT.expired_token ? "expired" : "error";
    this.deps.logger.warn("Feishu login session failed", { sessionId: session.id, text });
  }

  get(id: string): FeishuLoginSession | undefined {
    const s = this.sessions.get(id);
    return s ? { ...s } : undefined;
  }

  cancel(id: string): boolean {
    const s = this.sessions.get(id);
    if (!s) return false;
    if (s.status === "success" || s.status === "error" || s.status === "expired") return false;
    s.status = "cancelled";
    this.aborts.get(id)?.();
    return true;
  }

  /** 会话名（扫码页起名，appPreset 预填用）；无则 undefined */
  sessionName(id: string): string | undefined {
    return this.sessionNames.get(id);
  }

  /** 终态会话 TTL 清理（微信同款） */
  private scheduleCleanup(): void {
    setTimeout(() => {
      const now = Date.now();
      for (const [id, s] of this.sessions) {
        const age = now - new Date(s.createdAt).getTime();
        const isTerminal = s.status === "success" || s.status === "error" || s.status === "expired" || s.status === "cancelled";
        if (isTerminal && age > SESSION_TTL_MS) {
          this.sessions.delete(id);
          this.aborts.delete(id);
          this.sessionNames.delete(id);
        }
      }
    }, SESSION_TTL_MS).unref?.();
  }
}
