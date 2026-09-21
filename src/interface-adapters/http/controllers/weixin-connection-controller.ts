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
 * GET  /api/weixin/accounts       — 已登录账号列表（token 脱敏；F20260921imux：含 assistantLine 投影）
 * DELETE /api/weixin/accounts/:id — 删除账号（停轮询+释放绑定，回调链处理）
 */
export class WeixinConnectionController {
  constructor(
    private readonly deps: {
      loginSessions: WeixinLoginSessionPort;
      accountStore: WeixinAccountStorePort;
      /** 账号删除后回调（停轮询、释放绑定等清理；调用方注入）。F20260921wxba：
       *  实现含 DB 释放已 async——签名允许 Promise，deleteAccount 端 await 后再回包 */
      onAccountDeleted?: (accountId: string) => void | Promise<void>;
      /** F20260920imax：扫码后按名开助理线（必填名；app.ts 闭包注入，未注入时端点 503） */
      provisionAssistantLine?: (accountId: string, name: string) => Promise<{ conversationId: string; title: string }>;
      /** F20260921imux：连接仓库（listAccounts 投影助理线：账号→活跃对话绑定）。
      *  可选注入——未注入时列表不带 assistantLine 字段（向后兼容） */
      connectionRepo?: {
        getByExternalId(externalId: string): Promise<{ id: string } | null>;
        getActiveSession(connectionId: string): Promise<{ conversationId: string } | null>;
      };
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

  /**
   * F20260920imax：微信扫码后按名开助理线（登录成功即建，名字必填）。
   * POST /api/weixin/accounts/:id/assistant-line  body: { name: string }
   * 幂等：已有 active 绑定则返回当前对话（不重复建）。
   */
  async provisionAssistantLine(c: Context): Promise<Response> {
    try {
      if (!this.deps.provisionAssistantLine) {
        return c.json({ error: "assistant line not available（助理态未启用）" }, 503);
      }
      const accountId = param(c, "id");
      const body = await c.req.json<unknown>().catch(() => ({}));
      const name = (body as { name?: unknown }).name;
      if (typeof name !== "string" || name.trim().length === 0 || name.trim().length > 60) {
        return c.json({ error: "name 必填且为 1-60 字符" }, 400);
      }
      const result = await this.deps.provisionAssistantLine!(accountId, name.trim());
      return c.json(result, 201);
    } catch (err) {
      return handleError(c, err, this.deps.logger);
    }
  }

  async listAccounts(c: Context): Promise<Response> {
    try {
      // F20260921imux：并行投影助理线（externalId=accountId 查 connection，取 active 绑定）——
      // 前端账号↔对话映射的真相源，取代此前前端 title.includes(acc.id) 启发式（增量三后必 miss）
      const accounts = this.deps.accountStore.listAccounts();
      const connectionRepo = this.deps.connectionRepo;
      const withLine = connectionRepo
        ? await Promise.all(
            accounts.map(async (a) => {
              const conn = await connectionRepo.getByExternalId(a.id);
              const session = conn ? await connectionRepo.getActiveSession(conn.id) : null;
              return {
                id: a.id,
                ilinkBotId: a.ilinkBotId,
                ilinkUserId: a.ilinkUserId,
                addedAt: a.addedAt,
                // token 不出网（脱敏——bot_token 是长效凭证）
                hasToken: Boolean(a.token),
                ...(session && { assistantLine: { conversationId: session.conversationId } }),
              };
            }),
          )
        : accounts.map((a) => ({
            id: a.id,
            ilinkBotId: a.ilinkBotId,
            ilinkUserId: a.ilinkUserId,
            addedAt: a.addedAt,
            hasToken: Boolean(a.token),
          }));
      return c.json(withLine);
    } catch (err) {
      return handleError(c, err, this.deps.logger);
    }
  }

  /** F20260921imux：同号识别（扫码前探测）——按 ilinkUserId（微信侧稳定身份）查已有账号。
   *  前端用途：扫码前已知同名号将覆盖；扫码后得知实际冲突账号。
   *  POST body { ilinkUserId } → { account?: { id, assistantLine? } } */
  async lookupExistingAccount(c: Context): Promise<Response> {
    try {
      const body = await c.req.json<unknown>().catch(() => ({}));
      const ilinkUserId = (body as { ilinkUserId?: unknown }).ilinkUserId;
      if (typeof ilinkUserId !== "string" || ilinkUserId.trim().length === 0) {
        return c.json({ error: "ilinkUserId 必填" }, 400);
      }
      // accountId 是时间戳随机 id（login-flow confirm 生成），同一微信号重扫会产生新记录——
      // 唯一稳定身份是 ilinkUserId（扫码人微信侧 id）。此处按它匹配
      const existing = this.deps.accountStore.listAccounts().find(a => a.ilinkUserId === ilinkUserId);
      if (!existing) return c.json({});
      const connectionRepo = this.deps.connectionRepo;
      if (connectionRepo) {
        const conn = await connectionRepo.getByExternalId(existing.id);
        const session = conn ? await connectionRepo.getActiveSession(conn.id) : null;
        return c.json({
          account: {
            id: existing.id,
            addedAt: existing.addedAt,
            ...(session && { assistantLine: { conversationId: session.conversationId } }),
          },
        });
      }
      return c.json({ account: { id: existing.id, addedAt: existing.addedAt } });
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
      await this.deps.onAccountDeleted?.(id);
      return c.json({ status: "deleted" });
    } catch (err) {
      return handleError(c, err, this.deps.logger);
    }
  }
}
