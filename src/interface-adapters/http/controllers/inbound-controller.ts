import type { Context } from 'hono';
import type { Logger } from '@usecases/ports/logger';
import type { ProcessInboundRecruit } from '@usecases/recruiting/process-inbound-recruit';
import type { GetBridgeStatus } from '@usecases/recruiting/get-bridge-status';
import { parseInboundRequest } from '../dto/inbound-dto';

/**
 * F20260805rbrg：通用 inbound 端点。
 *
 * 路由 `/api/inbound/events`（不焊死领域名，按 source 分发到 use case）。
 * 当前只支持 source="boss-zhipin-bridge" → ProcessInboundRecruit。
 *
 * CORS：扩展 background SW 调用，options 页调试时也可能从 chrome-extension:// origin
 * 直接发，所以显式加 Access-Control-Allow-* 头。
 *
 * 共享密钥 X-Inbound-Key 从 config.inbound.recruiting.apiKey 读，boot 时注入。
 */
export class InboundController {
  constructor(
    private readonly apiKey: string,
    private readonly processInboundRecruit: ProcessInboundRecruit,
    private readonly getBridgeStatus: GetBridgeStatus | undefined,
    private readonly logger: Logger,
  ) {}

  /** 处理 CORS 预检 */
  optionsEvents(c: Context): Response {
    this.setCorsHeaders(c);
    c.header('Access-Control-Max-Age', '86400');
    return c.body(null, 204);
  }

  /** 查询桥接状态（GET /api/inbound/status） */
  async getStatus(c: Context): Promise<Response> {
    this.setCorsHeaders(c);

    // 校验共享密钥
    const provided = c.req.header('X-Inbound-Key');
    if (!provided || provided !== this.apiKey) {
      return c.json({ ok: false, error: 'invalid X-Inbound-Key' }, 401);
    }

    if (!this.getBridgeStatus) {
      return c.json({ ok: false, error: 'bridge status not configured' }, 503);
    }

    try {
      const status = await this.getBridgeStatus.execute();
      return c.json({ ok: true, ...status });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error('get bridge status failed', err instanceof Error ? err : new Error(msg));
      return c.json({ ok: false, error: msg }, 500);
    }
  }

  async receiveEvents(c: Context): Promise<Response> {
    this.setCorsHeaders(c);

    // 1. 校验共享密钥
    const provided = c.req.header('X-Inbound-Key');
    if (!provided || provided !== this.apiKey) {
      this.logger.warn('inbound events: auth failed', {
        provided: provided ? '***' : '(missing)',
      });
      return c.json({ ok: false, error: 'invalid X-Inbound-Key' }, 401);
    }

    // 2. 解析 + 校验 body
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch (err) {
      return c.json(
        { ok: false, error: `invalid JSON: ${err instanceof Error ? err.message : String(err)}` },
        400,
      );
    }

    const parsed = parseInboundRequest(raw as Parameters<typeof parseInboundRequest>[0]);
    if (!parsed.ok) {
      return c.json({ ok: false, error: parsed.error }, 400);
    }

    // 3. 当前只支持 boss-zhipin-bridge source
    if (parsed.source !== 'boss-zhipin-bridge') {
      return c.json({ ok: false, error: `unknown source: ${parsed.source}` }, 400);
    }

    // 4. 委派给 use case
    try {
      const result = await this.processInboundRecruit.execute(parsed.payload);
      return c.json({
        ok: true,
        accepted: result.accepted,
        deduplicated: result.deduplicated,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // 专用对话未初始化（boot 链没跑）→ 503，扩展端按"稍后重试"处理
      if (msg.includes('not initialized')) {
        return c.json({ ok: false, error: 'service not ready', detail: msg }, 503);
      }
      this.logger.error(
        'inbound events: process failed',
        err instanceof Error ? err : new Error(msg),
        { source: parsed.source, kind: parsed.payload.kind },
      );
      return c.json({ ok: false, error: msg }, 500);
    }
  }

  private setCorsHeaders(c: Context): void {
    c.header('Access-Control-Allow-Origin', '*');
    c.header('Access-Control-Allow-Headers', 'Content-Type, X-Inbound-Key');
    c.header('Access-Control-Allow-Methods', 'POST, OPTIONS');
  }
}
