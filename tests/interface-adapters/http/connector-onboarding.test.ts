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
import { ConnectorOnboardingController, type ConnectorArtifact } from "@interface-adapters/http/controllers/connector-onboarding-controller";
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

/** 装配被测路由（控制器构造参数较长，抽出 beforeEach 降复杂度） */
function buildTestApp(
  repo: SqliteConnectorRegistryRepository,
  artifact: ConnectorArtifact,
  appArtifact: ConnectorArtifact,
  logger: ReturnType<typeof testLogger>,
  now: () => number,
): Hono {
  const controllers = { inbound: {} } as unknown as Controllers;
  return createRouter(controllers, logger as never, {
    connectorPair: new ConnectorPairController(repo, logger as never),
    connectorOnboarding: new ConnectorOnboardingController(
      new IssueConnectorPairingCode(repo, now),
      artifact,
      logger as never,
      repo,
      appArtifact,
    ),
  });
}

const packageBytes = new TextEncoder().encode("connector-cli-package-fixture");
const appPackageBytes = new TextEncoder().encode("connector-app-package-fixture");

/** fixture：CLI tarball 与 app zip 产物文件落临时目录（版本固定 0.1.0） */
async function writeFixtureArtifacts(tempDir: string): Promise<{ artifact: ConnectorArtifact; appArtifact: ConnectorArtifact }> {
  const artifact: ConnectorArtifact = {
    filePath: path.join(tempDir, "otter-buddy-connector-0.1.0.tgz"),
    fileName: "otter-buddy-connector-0.1.0.tgz",
    version: "0.1.0",
  };
  await writeFile(artifact.filePath, packageBytes);
  const appArtifact: ConnectorArtifact = {
    filePath: path.join(tempDir, "otter-connector-macos-universal-0.1.0.zip"),
    fileName: "otter-connector-macos-universal-0.1.0.zip",
    version: "0.1.0",
  };
  await writeFile(appArtifact.filePath, appPackageBytes);
  return { artifact, appArtifact };
}

describe("connector Web 接入：签发、核销与 CLI 下载", () => {
  let db: Database.Database;
  let repo: SqliteConnectorRegistryRepository;
  let app: Hono;
  let logger: ReturnType<typeof testLogger>;
  let tempDir: string;
  let artifact: ConnectorArtifact;
  let appArtifact: ConnectorArtifact;
  let issuedAtMs: number;

  beforeEach(async () => {
    db = createTestDb();
    repo = new SqliteConnectorRegistryRepository(db);
    logger = testLogger();
    tempDir = await mkdtemp(path.join(tmpdir(), "connector-onboarding-"));
    ({ artifact, appArtifact } = await writeFixtureArtifacts(tempDir));
    issuedAtMs = Date.now();
    app = buildTestApp(repo, artifact, appArtifact, logger, () => issuedAtMs);
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

  it("app 安装包收登录 user：匿名/guest 拒绝，字节、版本、hash 可核；缺包 503", async () => {
    expect((await app.request("/api/connector/download/app")).status).toBe(401);
    expect((await app.request("/api/connector/download/app", { headers: GUEST })).status).toBe(403);

    const res = await app.request("/api/connector/download/app", { headers: USER });
    expect(res.status).toBe(200);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(appPackageBytes);
    expect(res.headers.get("X-Otter-Connector-Version")).toBe("0.1.0");
    expect(res.headers.get("Content-Type")).toBe("application/zip");
    expect(res.headers.get("Content-Disposition")).toContain("otter-connector-macos-universal-0.1.0.zip");
    const digest = createHash("sha256").update(appPackageBytes).digest();
    expect(res.headers.get("X-Otter-Connector-SHA256")).toBe(digest.toString("hex"));
    expect(res.headers.get("Digest")).toBe(`sha-256=${digest.toString("base64")}`);

    appArtifact.filePath = path.join(tempDir, "missing.zip");
    const missing = await app.request("/api/connector/download/app", { headers: USER });
    expect(missing.status).toBe(503);
    expect(await missing.json()).toMatchObject({ code: "connector_app_package_missing" });
  });

  it("引导文件收 admin：匿名/guest/user 拒绝；admin 得内嵌活跃码与请求 origin 的 hub", async () => {
    const issued = await issueCode();
    const post = (payload: unknown, headers: Record<string, string> = ADMIN) => app.request("/api/connector/download/bootstrap", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: typeof payload === "string" ? payload : JSON.stringify(payload),
    });

    expect((await post({ code: issued.code }, {})).status).toBe(401);
    expect((await post({ code: issued.code }, GUEST)).status).toBe(403);
    expect((await post({ code: issued.code }, USER)).status).toBe(403);

    const res = await app.request(new Request("http://hub.example.com/api/connector/download/bootstrap", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...ADMIN },
      body: JSON.stringify({ code: issued.code }),
    }));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Disposition")).toContain("otter-connector-bootstrap.json");
    const body = await res.json() as { hub: string; code: string; expiresAt: string };
    expect(body.hub).toBe("http://hub.example.com");
    expect(body.code).toBe(issued.code);
    expect(body.expiresAt).toBe(issued.expiresAt);
    // 码即秘密：不进结构化日志
    expect(JSON.stringify(logger.info.mock.calls)).not.toContain(issued.code);
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain(issued.code);
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain(issued.code);
  });

  it("引导文件 fail-closed：形态非法 400；未知/已核销/过期一律 404 不区分原因；重放后不可再取", async () => {
    const issued = await issueCode();
    const post = (payload: unknown, headers: Record<string, string> = ADMIN) => app.request("/api/connector/download/bootstrap", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: typeof payload === "string" ? payload : JSON.stringify(payload),
    });

    expect((await post("not-json")).status).toBe(400);
    expect((await post({ code: "AB2" })).status).toBe(400);
    expect((await post({ code: "ABCD0123" })).status).toBe(400); // 字母表不含 0/1
    expect((await post({ code: "AB2CD3EI" })).status).toBe(400); // 字母表不含 I
    expect((await post({ code: "AB2CD3EO" })).status).toBe(400); // 字母表不含 O
    expect((await post({ code: "aaaaaaaa" })).status).toBe(404); // 小写规范化后合法形态、未知码
    expect((await post({ code: "ZZZZZZZZ" })).status).toBe(404);

    // 核销后即不可取（一次性语义贯穿引导文件）
    await app.request("/api/connector/pair", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: issued.code, name: "引导核销机" }),
    });
    expect((await post({ code: issued.code })).status).toBe(404);

    // 过期码同样 404（不区分原因）
    issuedAtMs = Date.now() - CONNECTOR_PAIRING_CODE_TTL_MS - 1000;
    const expired = await issueCode();
    expect((await post({ code: expired.code })).status).toBe(404);
    // 调用方指定的 hub 不可信：body 带 hub 也不被采纳（服务端只认请求 origin）
    issuedAtMs = Date.now();
    const fresh = await issueCode();
    const res = await app.request("/api/connector/download/bootstrap", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...ADMIN },
      body: JSON.stringify({ code: fresh.code, hub: "https://evil.example.com" }),
    });
    expect((await res.json() as { hub: string }).hub).not.toBe("https://evil.example.com");
  });

  it("repo.findActivePairingCode：未核销未过期才命中，只读不改变核销状态", async () => {
    const issued = await issueCode();
    expect(await repo.findActivePairingCode(issued.code, new Date().toISOString())).toMatchObject({ code: issued.code });
    expect(await repo.findActivePairingCode("ZZZZZZZZ", new Date().toISOString())).toBeNull();
    await repo.redeemPairingCode(issued.code, new Date().toISOString());
    expect(await repo.findActivePairingCode(issued.code, new Date().toISOString())).toBeNull();
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
