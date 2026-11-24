import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { Context } from "hono";
import type { Logger } from "@usecases/ports/logger";
import type { IssueConnectorPairingCode } from "@usecases/execution/issue-connector-pairing-code";

export interface ConnectorCliArtifact {
  filePath: string;
  fileName: string;
  version: string;
}

/** 登录态设备接入口；公开核销仍由 ConnectorPairController 独立承担。 */
export class ConnectorOnboardingController {
  constructor(
    private readonly issuePairingCode: IssueConnectorPairingCode,
    private readonly artifact: ConnectorCliArtifact,
    private readonly logger: Logger,
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

  async download(ctx: Context): Promise<Response> {
    try {
      const bytes = await readFile(this.artifact.filePath);
      const sha256 = createHash("sha256").update(bytes).digest();
      const hex = sha256.toString("hex");
      return ctx.body(new Uint8Array(bytes), 200, {
        "Content-Type": "application/gzip",
        "Content-Length": String(bytes.byteLength),
        "Content-Disposition": `attachment; filename="${this.artifact.fileName}"`,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
        "X-Otter-Connector-Version": this.artifact.version,
        "X-Otter-Connector-SHA256": hex,
        Digest: `sha-256=${sha256.toString("base64")}`,
      });
    } catch (err) {
      this.logger.error("connector CLI package unavailable", undefined, {
        errorType: err instanceof Error ? err.name : "unknown",
      });
      return ctx.json({
        error: "Connector CLI package is unavailable; rebuild the hub before downloading",
        code: "connector_package_missing",
      }, 503);
    }
  }
}
