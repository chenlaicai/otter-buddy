import type { Context } from "hono";
import type { Logger } from "@usecases/ports/logger";
import { handleError, param } from "../http-error";

/** 登录会话管理端口（issue #566）：实现往 frameworks/weixin/login-session-manager，
 * controller 依赖接口而非实现，避免 interface-adapters → frameworks 分层违规 */
export interface WeixinLoginSessionPort {
  start(): {
    id: string;
    status: string;
    qrcodePng?: string;
    qrcodeUrl?: string;
    accountId?: string;
    ilinkUserId?: string;
    error?: string;
    createdAt: string;
  };
  get(id: string):
    | {
        id: string;
        status: string;
        qrcodePng?: string;
        qrcodeUrl?: string;
        accountId?: string;
        ilinkUserId?: string;
        error?: string;
        createdAt: string;
      }
    | undefined;
  cancel(id: string): boolean;
}

/** 账号列表只读端口（token 脱敏在 controller 完成） */
export interface WeixinAccountStorePort {
  listAccounts(): Array<{
    id: string;
    ilinkBotId?: string;
    ilinkUserId?: string;
    addedAt: string;
    token: string;
  }>;
  getAccount(id: string): { id: string; token: string } | undefined;
  removeAccount(id: string): void;
}

/**
 * 微信连接管理 HTTP 端点（issue #566）。
 *
 * POST /api/weixin/login          — 发起扫码登录会话
 * GET  /api/weixin/login/:id      — 轮询登录状态（前端 2s 间隔）
 * POST /api/weixin/login/:id/cancel — 取消登录会话
 * GET  /api/weixin/accounts       — 已登录账号列表（token 脱敏）
 * DELETE /api/weixin/accounts/:id — 删除账号（停止轮询由调用方处理）
 */
export class WeixinConnectionController {
  constructor(
    private readonly deps: {
      loginSessions: WeixinLoginSessionPort;
      accountStore: WeixinAccountStorePort;
      /** 账号删除后回调（停轮询等清理；调用方注入） */
      onAccountDeleted?: (accountId: string) => void;
      logger: Logger;
    },
  ) {}

  async startLogin(c: Context): Promise<Response> {
    try {
      const session = this.deps.loginSessions.start();
      return c.json(session, 201);
    } catch (err) {
      return handleError(c, err, this.deps.logger);
    }
  }

  async getLogin(c: Context): Promise<Response> {
    try {
      const session = this.deps.loginSessions.get(param(c, "id"));
      if (!session) return c.json({ error: "Login session not found" }, 404);
      return c.json(session);
    } catch (err) {
      return handleError(c, err, this.deps.logger);
    }
  }

  async cancelLogin(c: Context): Promise<Response> {
    try {
      const ok = this.deps.loginSessions.cancel(param(c, "id"));
      if (!ok) return c.json({ error: "Login session not found or already finished" }, 404);
      return c.json({ status: "cancelled" });
    } catch (err) {
      return handleError(c, err, this.deps.logger);
    }
  }

  async listAccounts(c: Context): Promise<Response> {
    try {
      const accounts = this.deps.accountStore.listAccounts().map((a) => ({
        id: a.id,
        ilinkBotId: a.ilinkBotId,
        ilinkUserId: a.ilinkUserId,
        addedAt: a.addedAt,
        // token 不出网（脱敏——bot_token 是长效凭证）
        hasToken: Boolean(a.token),
      }));
      return c.json(accounts);
    } catch (err) {
      return handleError(c, err, this.deps.logger);
    }
  }

  async deleteAccount(c: Context): Promise<Response> {
    try {
      const id = param(c, "id");
      const account = this.deps.accountStore.getAccount(id);
      if (!account) return c.json({ error: "Account not found" }, 404);
      this.deps.accountStore.removeAccount(id);
      this.deps.onAccountDeleted?.(id);
      return c.json({ status: "deleted" });
    } catch (err) {
      return handleError(c, err, this.deps.logger);
    }
  }
}
