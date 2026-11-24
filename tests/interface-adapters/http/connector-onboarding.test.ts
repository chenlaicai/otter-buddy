import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { serve } from "@hono/node-server";
import { WebSocket } from "ws";
import type { Duplex } from "node:stream";
import type { IncomingMessage } from "node:http";
import type { Hono } from "hono";
import { createRouter, type Controllers } from "@interface-adapters/http/router";
import { ConnectorPairController } from "@interface-adapters/http/controllers/connector-pair-controller";
import { ConnectorOnboardingController, type ConnectorCliArtifact } from "@interface-adapters/http/controllers/connector-onboarding-controller";
import { IssueConnectorPairingCode, CONNECTOR_PAIRING_CODE_TTL_MS } from "@usecases/execution/issue-connector-pairing-code";
import { SqliteConnectorRegistryRepository } from "@frameworks/db/execution/sqlite-connector-registry-repository";
import { ConnectorWsGateway } from "@frameworks/execution/connector-ws-gateway";
import { ExecutionMachineRegistry } from "@usecases/execution/execution-machine-registry";
import { CONNECTOR_PROTOCOL_VERSION, CONNECTOR_WS_SUBPROTOCOL, type ConnectorFrame } from "@entities/execution/connector-protocol";
import type { ExecutionMachine } from "@usecases/ports/execution-machine";
import { createTestDb } from "../../helpers/db";

const ADMIN = { "X-Otter-User-Id": "owner", "X-Otter-User-Role": "admin" };
const USER = { "X-Otter-User-Id": "maintainer", "X-Otter-User-Role": "user" };
const GUEST = { "X-Otter-User-Id": "visitor", "X-Otter-User-Role": "guest" };

function testLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: vi.fn() };
}

describe("connector Web 接入：签发、核销与 CLI 下载", () => {
  let db: Database.Database;
  let repo: SqliteConnectorRegistryRepository;
  let app: Hono;
  let logger: ReturnType<typeof testLogger>;
  let tempDir: string;
  let artifact: ConnectorCliArtifact;
  let issuedAtMs: number;
  const packageBytes = new TextEncoder().encode("connector-cli-package-fixture");

  beforeEach(async () => {
    db = createTestDb();
    repo = new SqliteConnectorRegistryRepository(db);
    logger = testLogger();
    tempDir = await mkdtemp(path.join(tmpdir(), "connector-onboarding-"));
    artifact = {
      filePath: path.join(tempDir, "otter-buddy-connector-0.1.0.tgz"),
      fileName: "otter-buddy-connector-0.1.0.tgz",
      version: "0.1.0",
    };
    await writeFile(artifact.filePath, packageBytes);
    issuedAtMs = Date.now();
    const controllers = { inbound: {} } as unknown as Controllers;
    app = createRouter(controllers, logger as never, {
      connectorPair: new ConnectorPairController(repo, logger as never),
      connectorOnboarding: new ConnectorOnboardingController(
        new IssueConnectorPairingCode(repo, () => issuedAtMs),
        artifact,
        logger as never,
      ),
    });
  });

  afterEach(async () => {
    db.close();
    await rm(tempDir, { recursive: true, force: true });
  });

  async function issueCode(): Promise<{ code: string; expiresAt: string }> {
    const res = await app.request("/api/connector/pairing-codes", { method: "POST", headers: ADMIN });
    expect(res.status).toBe(201);
    return await res.json() as { code: string; expiresAt: string };
  }

  it("签发收 admin：匿名 401、user/guest 403；码沿用 8 位字母表与 10 分钟 TTL", async () => {
    expect((await app.request("/api/connector/pairing-codes", { method: "POST" })).status).toBe(401);
    expect((await app.request("/api/connector/pairing-codes", { method: "POST", headers: USER })).status).toBe(403);
    expect((await app.request("/api/connector/pairing-codes", { method: "POST", headers: GUEST })).status).toBe(403);

    const issued = await issueCode();
    expect(issued.code).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/);
    expect(new Date(issued.expiresAt).getTime() - issuedAtMs).toBe(CONNECTOR_PAIRING_CODE_TTL_MS);
    expect(JSON.stringify(logger.info.mock.calls)).not.toContain(issued.code);
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain(issued.code);
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain(issued.code);
  });

  it("公开核销语义不变：首次 201 建设备，重放/过期 403 且不得再建设备", async () => {
    const issued = await issueCode();
    const pair = () => app.request("/api/connector/pair", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: issued.code, name: "浏览器接入机" }),
    });
    const first = await pair();
    expect(first.status).toBe(201);
    const identity = await first.json() as { deviceId: string; pairToken: string };
    expect((await repo.findDeviceByToken(identity.pairToken))?.id).toBe(identity.deviceId);
    expect((await pair()).status).toBe(403);
    expect(db.prepare("SELECT COUNT(*) AS count FROM devices").get()).toEqual({ count: 1 });

    issuedAtMs = Date.now() - CONNECTOR_PAIRING_CODE_TTL_MS - 1000;
    const expired = await issueCode();
    const expiredRes = await app.request("/api/connector/pair", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: expired.code, name: "过期设备" }),
    });
    expect(expiredRes.status).toBe(403);
    expect(db.prepare("SELECT COUNT(*) AS count FROM devices").get()).toEqual({ count: 1 });
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain(issued.code.slice(0, 2));
  });

  it("下载收登录 user：匿名/guest 拒绝，字节、版本、文件名和 SHA-256 可核", async () => {
    expect((await app.request("/api/connector/download")).status).toBe(401);
    expect((await app.request("/api/connector/download", { headers: GUEST })).status).toBe(403);

    const res = await app.request("/api/connector/download", { headers: USER });
    expect(res.status).toBe(200);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(packageBytes);
    expect(res.headers.get("X-Otter-Connector-Version")).toBe("0.1.0");
    expect(res.headers.get("Content-Disposition")).toContain(artifact.fileName);
    const digest = createHash("sha256").update(packageBytes).digest();
    expect(res.headers.get("X-Otter-Connector-SHA256")).toBe(digest.toString("hex"));
    expect(res.headers.get("Digest")).toBe(`sha-256=${digest.toString("base64")}`);
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
  });

  it("包缺失 fail-closed：登录用户也得 503，不返回空包或伪成功", async () => {
    artifact.filePath = path.join(tempDir, "missing.tgz");
    const res = await app.request("/api/connector/download", { headers: USER });
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ code: "connector_package_missing" });
  });

  it("Web 签发码可换 token 并经真 WSS 上线", async () => {
    const machines = new ExecutionMachineRegistry();
    const gateway = new ConnectorWsGateway(repo, machines, logger as never, {
      makeMachineProjection: (id, name): ExecutionMachine => ({
        id,
        name,
        run: async () => undefined,
        createExecutionEnvironment: () => { throw new Error("not used"); },
      }),
    });
    let server!: ReturnType<typeof serve>;
    const port = await new Promise<number>(resolve => {
      server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, info => resolve(info.port));
    });
    server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
      void gateway.handleUpgrade(req, socket, head, (code, reason) => {
        socket.write(`HTTP/1.1 ${code} ${reason}\r\nConnection: close\r\n\r\n`);
        socket.destroy();
      }).catch(() => socket.destroy());
    });

    try {
      const issuedRes = await fetch(`http://127.0.0.1:${port}/api/connector/pairing-codes`, { method: "POST", headers: ADMIN });
      const issued = await issuedRes.json() as { code: string };
      const pairRes = await fetch(`http://127.0.0.1:${port}/api/connector/pair`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: issued.code, name: "WSS 验收机" }),
      });
      expect(pairRes.status).toBe(201);
      const paired = await pairRes.json() as { deviceId: string; pairToken: string };
      const ws = new WebSocket(`ws://127.0.0.1:${port}/connector-ws`, [CONNECTOR_WS_SUBPROTOCOL], {
        headers: { authorization: `Bearer ${paired.pairToken}` },
      });
      const ack = await new Promise<ConnectorFrame>((resolve, reject) => {
        ws.once("open", () => ws.send(JSON.stringify({
          v: CONNECTOR_PROTOCOL_VERSION,
          type: "hello",
          seq: 1,
          data: { supportedVersions: [CONNECTOR_PROTOCOL_VERSION] },
        })));
        ws.once("message", raw => resolve(JSON.parse(String(raw)) as ConnectorFrame));
        ws.once("error", reject);
      });
      expect(ack.type).toBe("hello.ack");
      expect((await repo.getOnlineSession(ack.sid!))?.status).toBe("online");
      expect(machines.list().map(machine => machine.id)).toContain(paired.deviceId);
      ws.close();
    } finally {
      gateway.dispose();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
});
