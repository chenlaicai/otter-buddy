import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { Context } from "hono";
import type { Logger } from "@usecases/ports/logger";
import type { IssueConnectorPairingCode } from "@usecases/execution/issue-connector-pairing-code";
import type { ConnectorRegistryRepository } from "@usecases/ports/connector-registry-repository";

export interface ConnectorArtifact {
  filePath: string;
  fileName: string;
  version: string;
}

/** 配对码形态校验（与签发字母表同规；服务端形态不过的直接 400，不进 repo 查询） */
const PAIRING_CODE_SHAPE = /^[A-Z2-9]{8}$/;

/**
 * 登录态设备接入口：签发 + CLI tarball（PR-A）+ 可执行安装包/引导文件（PR-B）。
 * 公开核销仍由 ConnectorPairController 独立承担。
 */
export class ConnectorOnboardingController {
  constructor(
    private readonly issuePairingCode: IssueConnectorPairingCode,
    private readonly artifact: ConnectorArtifact,
    private readonly logger: Logger,
    private readonly connectorRepo?: ConnectorRegistryRepository,
    private readonly appArtifact?: ConnectorArtifact,
  ) {}

  async issueCode(ctx: Context): Promise<Response> {
    try {
      const issued = await this.issuePairingCode.execute();
      return ctx.json(issued, 201);
    } catch (err) {
      // Why: 配对码不得进入日志——只保留错误类型，不记录可能带 SQL 参数的错误正文。
      this.logger.error("connector pairing code issuance failed", undefined, {
        errorType: err instanceof Error ? err.name : "unknown",
      });
      return ctx.json({ error: "Failed to issue connector pairing code" }, 500);
    }
  }

  /** 共享的静态产物下载读盘逻辑（tarball 与 app zip 同规）：读盘 → hash 头 → 失败 503 */
  private async serveArtifact(ctx: Context, artifact: ConnectorArtifact, contentType: string, missingErrorCode: string, missingMessage: string): Promise<Response> {
    try {
      const bytes = await readFile(artifact.filePath);
      const sha256 = createHash("sha256").update(bytes).digest();
      return ctx.body(new Uint8Array(bytes), 200, {
        "Content-Type": contentType,
        "Content-Length": String(bytes.byteLength),
        "Content-Disposition": `attachment; filename="${artifact.fileName}"`,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
        "X-Otter-Connector-Version": artifact.version,
        "X-Otter-Connector-SHA256": sha256.toString("hex"),
        Digest: `sha-256=${sha256.toString("base64")}`,
      });
    } catch (err) {
      this.logger.error("connector artifact unavailable", undefined, {
        errorType: err instanceof Error ? err.name : "unknown",
        artifact: artifact.fileName,
      });
      return ctx.json({ error: missingMessage, code: missingErrorCode }, 503);
    }
  }

  async download(ctx: Context): Promise<Response> {
    return this.serveArtifact(
      ctx,
      this.artifact,
      "application/gzip",
      "connector_package_missing",
      "Connector CLI package is unavailable; rebuild the hub before downloading",
    );
  }

  /** 可执行安装包（PR-B）：双击启动器 + 内嵌 Node 运行时 + connector 产物。
   *  不含设备秘密（配对码走独立 bootstrap 端点）；构建机=hub 机，产物平台随部署机。 */
  async downloadApp(ctx: Context): Promise<Response> {
    if (this.appArtifact === undefined) {
      return ctx.json({ error: "Connector app package is not assembled on this hub", code: "connector_app_package_missing" }, 503);
    }
    return this.serveArtifact(
      ctx,
      this.appArtifact,
      "application/zip",
      "connector_app_package_missing",
      "Connector app package is unavailable; rebuild the hub before downloading",
    );
  }

  /** 引导文件（PR-B）：把签发的活跃码与当前中枢地址打包成向导可自动带入的 JSON。
   *  admin 档（码=注册设备的秘密，与签发同轨）；码不存在/已核销/已过期一律 404
   *  不区分原因（与核销口防探测同口径）；hub 取请求自身 origin——不接受调用方指定。 */
  async downloadBootstrap(ctx: Context): Promise<Response> {
    const body = await ctx.req.json().catch(() => null) as { code?: unknown } | null;
    const code = typeof body?.code === "string" ? body.code.trim().toUpperCase() : "";
    if (!PAIRING_CODE_SHAPE.test(code)) {
      return ctx.json({ error: "Invalid pairing code format", code: "invalid_pairing_code" }, 400);
    }
    if (this.connectorRepo === undefined) {
      return ctx.json({ error: "Connector registry is not wired on this hub", code: "connector_registry_missing" }, 503);
    }
    const active = await this.connectorRepo.findActivePairingCode(code, new Date().toISOString());
    if (active === null) {
      return ctx.json({ error: "Pairing code is not available (unknown, redeemed, or expired)", code: "pairing_code_unavailable" }, 404);
    }
    const hub = new URL(ctx.req.url).origin;
    return ctx.json({ hub, code, expiresAt: active.expiresAt }, 200, {
      "Content-Disposition": "attachment; filename=\"otter-connector-bootstrap.json\"",
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    });
  }
}
