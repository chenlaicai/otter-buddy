import { randomUUID } from "node:crypto";
import type { Context } from "hono";
import type { Logger } from "@usecases/ports/logger";
import type { ConnectorRegistryRepository } from "@usecases/ports/connector-registry-repository";
import type { Device } from "@entities/execution/device";

/**
 * connector 配对端点。
 * POST /api/connector/pair { code, name } → 核销一次性码 → 建设备身份 → 返 deviceId+pairToken。
 *
 * 鉴权模型：码即秘密（CLI 生成 → 人贴给 connector）——本端点不要求登录态（connector
 * 是无浏览器进程）；核销原子 fail-closed（过期/重放/不存在一律 403，不区分原因防探测）。
 * 撤销走 CLI --unpair（删 devices 行，token 即刻失效）。
 */
export class ConnectorPairController {
  constructor(
    private readonly repo: ConnectorRegistryRepository,
    private readonly logger: Logger,
  ) {}

  async pair(ctx: Context): Promise<Response> {
    const body = await ctx.req.json().catch(() => null) as { code?: unknown; name?: unknown } | null;
    const code = typeof body?.code === "string" ? body.code.trim() : "";
    const name = typeof body?.name === "string" ? body.name.trim() : "";
    if (!code || !name) {
      return ctx.json({ error: "code and name are required" }, 400);
    }

    const now = new Date().toISOString();
    // 原子核销+建设备（事务内一气呵成，码烧空耗窗口消除）；
    // 过期/重放/不存在统一 403（不区分，防探测）
    const device: Device = {
      id: `connector-${randomUUID().slice(0, 8)}`,
      name,
      pairToken: randomUUID(),
      createdAt: now,
      lastSeenAt: now,
    };
    const redeemed = await this.repo.redeemAndCreateDevice(code, device, now).catch(() => false);
    if (!redeemed) {
      this.logger.warn("connector pairing rejected", { codePrefix: code.slice(0, 2) });
      return ctx.json({ error: "pairing code invalid, expired, or already redeemed" }, 403);
    }
    this.logger.info("connector device paired", { deviceId: device.id, name });
    return ctx.json({ deviceId: device.id, pairToken: device.pairToken }, 201);
  }
}
