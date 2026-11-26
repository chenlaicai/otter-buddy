import { describe, expect, it, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { SqliteConnectorRegistryRepository } from "@frameworks/db/execution/sqlite-connector-registry-repository";
import { ExecutionMachineRegistry, } from "@usecases/execution/execution-machine-registry";
import { createTestDb } from "../../helpers/db";
import type { Device } from "@entities/execution/device";
import type { OnlineSession } from "@entities/execution/online-session";

/** connector 注册仓库 + Registry 顶替语义。
 *  总闸唯一事实源的三态钉死：配对码原子核销 / 顶替上线 / 幂等下线 / 启动清扫。 */

function deviceFixture(overrides: Partial<Device> = {}): Device {
  return { id: "connector-aaa", name: "测试设备", pairToken: "tok-aaa", createdAt: "2026-11-17T00:00:00Z", lastSeenAt: null, ...overrides };
}

function sessionFixture(overrides: Partial<OnlineSession> = {}): OnlineSession {
  return {
    id: "sess-1", deviceId: "connector-aaa", status: "online",
    connectedAt: "2026-11-17T00:01:00Z", disconnectedAt: null, disconnectReason: null,
    lastSeenAt: "2026-11-17T00:01:00Z", protocolVersion: 1, ...overrides,
  };
}

describe("connector 注册仓库（配对码/设备/会话三态）", () => {
  let db: Database.Database;
  let repo: SqliteConnectorRegistryRepository;

  beforeEach(() => {
    db = createTestDb();
    repo = new SqliteConnectorRegistryRepository(db);
  });

  afterEach(() => db.close());

  it("配对码：时效内单次核销成功，重放拒绝", async () => {
    await repo.createPairingCode("ABCD2345", "2026-11-17T00:10:00Z");
    expect(await repo.redeemPairingCode("ABCD2345", "2026-11-17T00:05:00Z")).toBe(true);  // 时效内
    expect(await repo.redeemPairingCode("ABCD2345", "2026-11-17T00:06:00Z")).toBe(false); // 重放拒绝
  });

  it("s6 原子配对：核销失败不建设备（码烧空耗窗口消除）", async () => {
    await repo.createPairingCode("ZZZZ9999", "2026-11-17T00:10:00Z");
    // 过期码 → 原子方法整体 false，devices 零行
    expect(await repo.redeemAndCreateDevice("ZZZZ9999", deviceFixture({ pairToken: "tok-z" }), "2026-11-17T00:11:00Z")).toBe(false);
    expect(await repo.findDeviceByToken("tok-z")).toBeNull();
    // 时效内 → 核销+建设备一次成型；重放再试 false
    expect(await repo.redeemAndCreateDevice("ZZZZ9999", deviceFixture({ pairToken: "tok-z" }), "2026-11-17T00:05:00Z")).toBe(true);
    expect((await repo.findDeviceByToken("tok-z"))?.id).toBe("connector-aaa");
    expect(await repo.redeemAndCreateDevice("ZZZZ9999", deviceFixture({ id: "connector-x", pairToken: "tok-x" }), "2026-11-17T00:06:00Z")).toBe(false);
    expect(await repo.findDeviceByToken("tok-x")).toBeNull(); // 重放不建设备
  });

  it("配对码：过期拒绝（fail-closed）", async () => {
    await repo.createPairingCode("EFGH6789", "2026-11-17T00:10:00Z");
    expect(await repo.redeemPairingCode("EFGH6789", "2026-11-17T00:10:01Z")).toBe(false);
    expect(await repo.redeemPairingCode("NOPE0000", "2026-11-17T00:05:00Z")).toBe(false); // 不存在
  });

  it("设备：token 查询命中；删除即 token 失效（撤销）", async () => {
    await repo.createDevice(deviceFixture());
    expect((await repo.findDeviceByToken("tok-aaa"))?.id).toBe("connector-aaa");
    expect(await repo.findDeviceByToken("tok-wrong")).toBeNull();
    await repo.deleteDevice("connector-aaa");
    expect(await repo.findDeviceByToken("tok-aaa")).toBeNull(); // token 即刻失效
  });

  it("顶替上线：同 device 旧 online 行落 offline/device-offline，新行 online", async () => {
    await repo.createDevice(deviceFixture());
    await repo.openOnlineSession(sessionFixture());
    await repo.openOnlineSession(sessionFixture({ id: "sess-2", connectedAt: "2026-11-17T00:02:00Z", lastSeenAt: "2026-11-17T00:02:00Z" }));
    const old1 = await repo.getOnlineSession("sess-1");
    expect(old1?.status).toBe("offline");
    expect(old1?.disconnectReason).toBe("device-offline");
    const now2 = await repo.getOnlineSession("sess-2");
    expect(now2?.status).toBe("online");
  });

  it("唯一索引兜底：绕过顶替事务直插双 online 行被库层拒绝", async () => {
    await repo.createDevice(deviceFixture());
    await repo.openOnlineSession(sessionFixture());
    expect(() =>
      db.prepare(
        "INSERT INTO online_sessions (id, device_id, status, connected_at, last_seen_at) VALUES ('sess-raw', 'connector-aaa', 'online', '2026-11-17T00:00:00Z', '2026-11-17T00:00:00Z')",
      ).run(),
    ).toThrow(); // partial unique index 命中——总闸库层兜底
  });

  it("幂等下线：先到的 reason 不被后续改写", async () => {
    await repo.createDevice(deviceFixture());
    await repo.openOnlineSession(sessionFixture());
    await repo.closeOnlineSession("sess-1", "device-offline", "2026-11-17T00:03:00Z");
    await repo.closeOnlineSession("sess-1", "hub-restart", "2026-11-17T00:04:00Z"); // 晚到的改写无效
    const row = await repo.getOnlineSession("sess-1");
    expect(row?.status).toBe("offline");
    expect(row?.disconnectReason).toBe("device-offline"); // 真相保持
    expect(row?.disconnectedAt).toBe("2026-11-17T00:03:00Z");
  });

  it("撤销设备：online 行先关（auth-failed）再级联清除（身份+token+会话史同灭）", async () => {
    await repo.createDevice(deviceFixture());
    await repo.openOnlineSession(sessionFixture());
    await repo.deleteDevice("connector-aaa");
    expect(await repo.getOnlineSession("sess-1")).toBeNull(); // 会话行随身份级联清除
    expect(await repo.findDeviceByToken("tok-aaa")).toBeNull(); // token 即刻失效
  });

  it("启动清扫：所有 online 行落 offline/hub-restart（幂等）", async () => {
    await repo.createDevice(deviceFixture());
    await repo.createDevice(deviceFixture({ id: "connector-bbb", pairToken: "tok-bbb" }));
    await repo.openOnlineSession(sessionFixture());
    await repo.openOnlineSession(sessionFixture({ id: "sess-b", deviceId: "connector-bbb" }));
    expect(await repo.sweepStaleOnlineSessions("2026-11-17T09:00:00Z")).toBe(2);
    expect(await repo.sweepStaleOnlineSessions("2026-11-17T09:00:01Z")).toBe(0); // 幂等
    expect((await repo.getOnlineSession("sess-1"))?.disconnectReason).toBe("hub-restart");
  });
});

describe("ExecutionMachineRegistry unregister/replace（C1 顶替语义）", () => {
  it("unregister 幂等：未注册 id 静默；注销后显式 resolve 回 fail-closed（统一注册制：无参 resolve 恒抛 no default machine）", () => {
    const registry = new ExecutionMachineRegistry();
    expect(() => registry.unregister("ghost")).not.toThrow(); // 幂等
    registry.unregister("legacy-local");
    expect(() => registry.resolve("legacy-local")).toThrow(/not registered/);
    expect(() => registry.resolve()).toThrow(/no default machine/i);
  });

  it("replace 顶替：同 id 后到者生效（设备重上线投影刷新）", () => {
    const registry = new ExecutionMachineRegistry();
    const a = { id: "connector-x", name: "旧投影", run: async () => undefined, createExecutionEnvironment: (() => undefined) as never };
    const b = { id: "connector-x", name: "新投影", run: async () => undefined, createExecutionEnvironment: (() => undefined) as never };
    registry.register(a);
    registry.replace(b); // 不抛（register 会抛 already registered）
    expect(registry.resolve("connector-x").name).toBe("新投影");
  });
});
