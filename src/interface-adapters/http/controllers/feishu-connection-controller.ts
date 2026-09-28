import type { Context } from "hono";
import { botKey } from "@frameworks/feishu/bot-key";
import { maskAppId } from "@frameworks/feishu/long-connection-client";
import type { Logger } from "@usecases/ports/logger";
import { handleError, param } from "../http-error";

/**
 * F20260928fsqr：飞书扫码连接管理端点（对齐 weixin-connection-controller 全套语义）。
 *
 * - POST /api/feishu/login                 发起扫码（registerApp 后台跑）
 * - GET  /api/feishu/login/:id             轮询会话状态（前端 2s 拉一次）
 * - POST /api/feishu/login/:id/cancel      取消扫码
 * - GET  /api/feishu/apps                  账号列表（助理线投影，token 不出网）
 * - POST /api/feishu/apps/:id/assistant-line  幂等建助理线（onSuccess 失败的补建/重试入口）
 * - DELETE /api/feishu/apps/:id            删 app（停 WS + unregister 出站 + 释放绑定 + 删 store）
 */

/** 登录会话端口（frameworks 层 manager 的接口投影——测试可 mock） */
export interface FeishuLoginSessionPort {
  start(name?: string): {
    id: string;
    status: string;
    createdAt: string;
    qrcodePng?: string;
    qrcodeUrl?: string;
  };
  get(id: string): {
    id: string;
    status: string;
    createdAt: string;
    qrcodePng?: string;
    qrcodeUrl?: string;
    appId?: string;
    ownerOpenId?: string;
    error?: string;
  } | undefined;
  cancel(id: string): boolean;
}

/** app 存储端口（同上，接口投影） */
export interface FeishuAppStorePort {
  listApps(): Array<{ appId: string; appSecret: string; ownerOpenId?: string; name?: string; addedAt: string }>;
  getApp(appId: string): { appId: string; appSecret: string; ownerOpenId?: string; name?: string; addedAt: string } | undefined;
  removeApp(appId: string): void;
}

export class FeishuConnectionController {
  constructor(
    private readonly deps: {
      loginSessions: FeishuLoginSessionPort;
      appStore: FeishuAppStorePort;
      logger: Logger;
      /** 建助理线（app.ts 闭包注入，botKey 锚定）；签名对齐微信 provisionAssistantLine */
      provisionAssistantLine?: (appId: string, name: string) => Promise<{ conversationId: string; title: string }>;
      /** 删除后回调（停 WS + unregister 出站 + 释放绑定；调用方注入，#592 防复活） */
      onAppDeleted?: (appId: string) => void | Promise<void>;
      /** 连接查询（助理线投影用；不注入时投影省略） */
      connectionRepo?: { getByExternalId(externalId: string): Promise<{ id: string; metadata: Record<string, unknown> | null } | null>; getActiveSession(connectionId: string): Promise<{ conversationId: string } | null> };
    },
  ) {}

  /** 发起扫码建 app。body: { name?: string }（助理线名，appPreset 预填 + 落库） */
  async startLogin(c: Context): Promise<Response> {
    try {
      const body = await c.req.json<unknown>().catch(() => ({}));
      const rawName = (body as { name?: unknown }).name;
      const name = typeof rawName === "string" ? rawName.trim() : "";
      if (name.length > 60) {
        return c.json({ error: "name 若填须 ≤60 字符" }, 400);
      }
      const session = this.deps.loginSessions.start(name || undefined);
      return c.json(session, 201);
    } catch (err) {
      return handleError(c, err, this.deps.logger);
    }
  }

  async getLogin(c: Context): Promise<Response> {
    try {
      const session = this.deps.loginSessions.get(param(c, "id"));
      if (!session) return c.json({ error: "login session not found" }, 404);
      return c.json(session);
    } catch (err) {
      return handleError(c, err, this.deps.logger);
    }
  }

  async cancelLogin(c: Context): Promise<Response> {
    try {
      const ok = this.deps.loginSessions.cancel(param(c, "id"));
      if (!ok) return c.json({ error: "login session not found or already terminal" }, 404);
      return c.json({ ok: true });
    } catch (err) {
      return handleError(c, err, this.deps.logger);
    }
  }

  async listApps(c: Context): Promise<Response> {
    try {
      const apps = this.deps.appStore.listApps();
      const connectionRepo = this.deps.connectionRepo;
      const withLine = connectionRepo
        ? await Promise.all(
            apps.map(async (a) => {
              const conn = await connectionRepo.getByExternalId(botKey(a.appId));
              const session = conn ? await connectionRepo.getActiveSession(conn.id) : null;
              return {
                appId: maskAppId(a.appId), // 完整 appId 不出网（同微信 token 脱敏原则）
                ownerOpenId: a.ownerOpenId,
                name: a.name,
                addedAt: a.addedAt,
                // secret 不出网
                hasSecret: Boolean(a.appSecret),
                ...(session && { assistantLine: { conversationId: session.conversationId } }),
              };
            }),
          )
        : apps.map((a) => ({
            appId: maskAppId(a.appId),
            ownerOpenId: a.ownerOpenId,
            name: a.name,
            addedAt: a.addedAt,
            hasSecret: Boolean(a.appSecret),
          }));
      return c.json(withLine);
    } catch (err) {
      return handleError(c, err, this.deps.logger);
    }
  }

  /** 幂等建助理线（onSuccess 自动触发失败后的补建/重试入口，微信 provisionAssistantLine 同构） */
  async provisionAssistantLine(c: Context): Promise<Response> {
    try {
      if (!this.deps.provisionAssistantLine) {
        return c.json({ error: "assistant line not available（助理态未启用）" }, 503);
      }
      const appId = param(c, "id");
      const app = this.deps.appStore.getApp(appId);
      if (!app) return c.json({ error: "feishu app not found" }, 404);
      const body = await c.req.json<unknown>().catch(() => ({}));
      const rawName = (body as { name?: unknown }).name;
      const name = typeof rawName === "string" && rawName.trim() ? rawName.trim() : (app.name ?? maskAppId(appId));
      const result = await this.deps.provisionAssistantLine!(appId, name);
      return c.json(result, 201);
    } catch (err) {
      return handleError(c, err, this.deps.logger);
    }
  }

  async deleteApp(c: Context): Promise<Response> {
    try {
      const appId = param(c, "id");
      const app = this.deps.appStore.getApp(appId);
      if (!app) return c.json({ error: "feishu app not found" }, 404);
      // #592 防复活序：先回调（停 WS + unregister 出站 + 释放绑定），后删 store——
      // 反序崩溃会留下「store 已删但 WS 还在拉」的复活通道
      await this.deps.onAppDeleted?.(appId);
      this.deps.appStore.removeApp(appId);
      this.deps.logger.info("Feishu scan app deleted", { appId: maskAppId(appId) });
      return c.json({ ok: true });
    } catch (err) {
      return handleError(c, err, this.deps.logger);
    }
  }
}
