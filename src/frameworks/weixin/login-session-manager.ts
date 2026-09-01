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
  /** #592：取消原因标记（account_deleted = 账号删除时取消，防复活路径识别用） */
  cancellationReason?: "account_deleted";
}

/** 登录成功回调（platforms 层注入：热启动 poller + ensure config） */
export type OnWeixinLoginSuccess = (accountId: string, ilinkUserId?: string) => void;

/** 会话被账号删除取消的回调（#592：app.ts 注入——安全路径上补删账号清理，防「删了又复活」） */
export type OnWeixinLoginSessionCancelledByAccountDeletion = (accountId: string, ilinkUserId?: string) => void;

const SESSION_TTL_MS = 10 * 60_000;

export class WeixinLoginSessionManager {
  private readonly sessions = new Map<string, WeixinLoginSession>();

  constructor(
    private readonly deps: {
      baseUrl?: string;
      accountStore: WeixinAccountStore;
      onSuccess?: OnWeixinLoginSuccess;
      /** #592：会话因账号删除被取消时回调（默认仅记日志；app.ts 注入完整清理） */
      onSessionCancelledByAccountDeletion?: OnWeixinLoginSessionCancelledByAccountDeletion;
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
        if (session.status === "cancelled") return; // QR 异步到达时可能已取消——不覆写终态
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
      .then(({ accountId, ilinkUserId }) => this.handleFlowSuccess(session, accountId, ilinkUserId))
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

  /** flow 完成分流（#592）：cancelled+account_deleted → 删号取消，不落盘不热启动；
   *  cancelled（其它原因）→ 账号保留（微信侧授权已成，不回滚）；正常完成 → success */
  private handleFlowSuccess(session: WeixinLoginSession, accountId: string, ilinkUserId?: string): void {
    if (session.status === "cancelled") {
      // 前端已取消但扫码仍完成：账号已落盘（微信侧授权已成，回滚只会让
      // UI 状态与存储不一致）——状态保持 cancelled，不触发 onSuccess 热启动。
      // #592：若取消原因是账号删除（cancellationReason 记录），说明用户
      // 已表态不要这个账号——安全路径同步 removeAccount，彻底阻断「删了
      // 又复活」（onSuccess 不触发，不会重新拉起轮询）
      if (session.cancellationReason === "account_deleted") {
        this.deps.accountStore.removeAccount(accountId);
        this.deps.onSessionCancelledByAccountDeletion?.(accountId, ilinkUserId);
        this.deps.logger.info("Weixin login completed after account deletion; removed persisted account", { accountId });
      } else {
        this.deps.logger.info("Weixin login completed after cancel; keeping account", { accountId });
      }
      return;
    }
    session.accountId = accountId;
    session.ilinkUserId = ilinkUserId;
    session.status = "success";
    this.deps.onSuccess?.(accountId, ilinkUserId);
  }

  cancel(id: string): boolean {
    const s = this.sessions.get(id);
    if (!s) return false;
    if (s.status === "success" || s.status === "error" || s.status === "expired") return false;
    s.status = "cancelled";
    return true;
  }

  /**
   * 按账号 id 取消活跃登录会话（#592，账号删除时调用）。
   *
   * 语义：**仅取消非终态会话**；已 success 的会话是终态（账号已落盘、poller 已拉起），
   * 它的账号清理走 onAccountDeleted 回调链，不经此路径。会话的 accountId 在
   * 确认前不可知（微信侧在 confirmed 才回 token），删除时只能按 ilinkUserId
   * （扫码人）匹配——与 stopStalePollersForUser 同构。
   *
   * 复活防线：非终态会话被取消后，若扫码仍在后台完成，run() 的 then 分支
   * 检测到 cancelled → 不落盘、不热启动（见 start() 内注释）；若账号已落盘
   * （confirmed 先到）则走 onAccountDeleted 同步清理。微信侧授权已成时
   * 账号仍会重新落盘——由 cancellationReason="account_deleted" 标记 + 安全
   * 路径上补 removeAccount（app.ts 注入），构成完整防线。
   */
  cancelByAccountId(accountId: string): number {
    let cancelled = 0;
    for (const s of this.sessions.values()) {
      if (s.accountId === accountId && !["success", "error", "expired", "cancelled"].includes(s.status)) {
        s.status = "cancelled";
        s.cancellationReason = "account_deleted";
        cancelled++;
      }
    }
    return cancelled;
  }

  /**
   * 按扫码人（ilinkUserId）取消活跃登录会话（#592：删除账号时一并取消
   * 同扫码人尚在等待确认的其它会话——它们落盘后就是同一个人的「新账号」，
   * 留着必复活）。
   */
  cancelByIlinkUserId(ilinkUserId: string): number {
    let cancelled = 0;
    for (const s of this.sessions.values()) {
      if (s.ilinkUserId === ilinkUserId && !["success", "error", "expired", "cancelled"].includes(s.status)) {
        s.status = "cancelled";
        s.cancellationReason = "account_deleted";
        cancelled++;
      }
    }
    return cancelled;
  }

  /** 列出指定账号（accountId）关联的全部会话（终态含）。测试与诊断用 */
  listByAccountId(accountId: string): WeixinLoginSession[] {
    return Array.from(this.sessions.values())
      .filter((s) => s.accountId === accountId)
      .map((s) => ({ ...s }));
  }

  /** 列出指定扫码人关联的全部会话（含非终态；accountId 在 confirmed 前未知）。测试与诊断用 */
  listByIlinkUserId(ilinkUserId: string): WeixinLoginSession[] {
    return Array.from(this.sessions.values())
      .filter((s) => s.ilinkUserId === ilinkUserId)
      .map((s) => ({ ...s }));
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
