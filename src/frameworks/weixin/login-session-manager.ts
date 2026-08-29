import qrcode from "qrcode";
import type { Logger } from "@usecases/ports/logger";
import { WeixinLoginFlow } from "./login-flow";
import { WeixinApiClient } from "./api-client";
import type { WeixinAccountStore } from "./account-store";

/**
 * Web 扫码登录会话管理（issue #566，frameworks 层）。
 *
 * 每次「发起扫码」创建一个会话：后台跑 WeixinLoginFlow（5 分钟窗口），
 * 前端轮询会话状态渲染二维码与进度。与 CLI 共用 login-flow，差异仅在
 * onQrCode 回调：CLI 渲终端 ASCII，这里渲染 PNG dataURL 推给前端。
 *
 * 生命周期：wait/scaned → confirmed（成功，账号落盘）/ expired / error /
 * cancelled。终态会话保留 10 分钟（供前端取终态）后清理。
 */

export type WeixinLoginSessionStatus =
  | "pending" // 二维码申请中
  | "waiting_scan" // 码已出，等扫码
  | "scaned" // 已扫码，等确认
  | "success" // confirmed，账号已落盘
  | "expired"
  | "error"
  | "cancelled";

export interface WeixinLoginSession {
  id: string;
  status: WeixinLoginSessionStatus;
  /** PNG dataURL（pending 期间无） */
  qrcodePng?: string;
  /** 微信扫码链接原文（轮换新码时更新） */
  qrcodeUrl?: string;
  /** 成功后回填 */
  accountId?: string;
  ilinkUserId?: string;
  error?: string;
  createdAt: string;
}

/** 登录成功回调（platforms 层注入：热启动 poller + ensure config） */
export type OnWeixinLoginSuccess = (accountId: string, ilinkUserId?: string) => void;

const SESSION_TTL_MS = 10 * 60_000;

export class WeixinLoginSessionManager {
  private readonly sessions = new Map<string, WeixinLoginSession>();

  constructor(
    private readonly deps: {
      baseUrl?: string;
      accountStore: WeixinAccountStore;
      onSuccess?: OnWeixinLoginSuccess;
      logger: Logger;
    },
  ) {}

  /** 发起一次扫码登录（后台异步执行，立即返回会话 id） */
  start(): WeixinLoginSession {
    const id = `wxlogin-${Date.now().toString(36)}`;
    const session: WeixinLoginSession = {
      id,
      status: "pending",
      createdAt: new Date().toISOString(),
    };
    this.sessions.set(id, session);

    const api = new WeixinApiClient({ baseUrl: this.deps.baseUrl ?? "https://ilinkai.weixin.qq.com" });
    const flow = new WeixinLoginFlow({
      api,
      accountStore: this.deps.accountStore,
      // web 场景不支持交互式配对码输入（风控场景请走 CLI）
      onQrCode: (qrUrl) => {
        session.qrcodeUrl = qrUrl;
        session.status = "waiting_scan";
        qrcode
          .toDataURL(qrUrl, { width: 280, margin: 1 })
          .then((png) => {
            session.qrcodePng = png;
          })
          .catch((err) => {
            this.deps.logger.warn("Weixin login QR PNG render failed", {
              sessionId: id,
              error: err instanceof Error ? err.message : String(err),
            });
          });
      },
      onStatus: (s) => {
        if (session.status === "cancelled") return;
        if (s === "scaned") session.status = "scaned";
        else if (s === "wait" && session.status === "scaned") session.status = "waiting_scan";
      },
      logger: this.deps.logger,
    });

    void flow
      .run()
      .then(({ accountId, ilinkUserId }) => {
        if (session.status === "cancelled") {
          // 前端已取消但扫码仍完成：账号已落盘（微信侧授权已成，回滚只会让
          // UI 状态与存储不一致）——状态保持 cancelled，不触发 onSuccess 热启动
          this.deps.logger.info("Weixin login completed after cancel; keeping account", { accountId });
          return;
        }
        session.accountId = accountId;
        session.ilinkUserId = ilinkUserId;
        session.status = "success";
        this.deps.onSuccess?.(accountId, ilinkUserId);
      })
      .catch((err) => {
        if (session.status === "cancelled") return;
        const msg = err instanceof Error ? err.message : String(err);
        session.error = msg;
        session.status = msg.includes("过期") ? "expired" : "error";
        this.deps.logger.warn("Weixin login session failed", { sessionId: id, error: msg });
      });

    this.scheduleCleanup();
    return { ...session };
  }

  get(id: string): WeixinLoginSession | undefined {
    const s = this.sessions.get(id);
    return s ? { ...s } : undefined;
  }

  cancel(id: string): boolean {
    const s = this.sessions.get(id);
    if (!s) return false;
    if (s.status === "success" || s.status === "error" || s.status === "expired") return false;
    s.status = "cancelled";
    return true;
  }

  /** 停止全部活跃会话（测试/进程关闭用；已终态的不动） */
  dispose(): void {
    for (const s of this.sessions.values()) {
      if (!["success", "error", "expired", "cancelled"].includes(s.status)) {
        s.status = "cancelled";
      }
    }
  }

  /** 终态会话 TTL 清理（挂在 start() 上，避免常驻 timer） */
  private scheduleCleanup(): void {
    setTimeout(() => {
      const now = Date.now();
      for (const [id, s] of this.sessions) {
        const done = ["success", "error", "expired", "cancelled"].includes(s.status);
        if (done && now - new Date(s.createdAt).getTime() > SESSION_TTL_MS) {
          this.sessions.delete(id);
        }
      }
    }, SESSION_TTL_MS).unref?.();
  }
}
