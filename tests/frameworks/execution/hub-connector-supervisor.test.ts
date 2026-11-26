import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ChildProcess } from "node:child_process";
import { HubConnectorSupervisor, type HubConnectorSupervisorOptions } from "@frameworks/execution/hub-connector-supervisor";
import { IssueConnectorPairingCode } from "@usecases/execution/issue-connector-pairing-code";
import type { ConnectorRegistryRepository } from "@usecases/ports/connector-registry-repository";
import type { Device } from "@entities/execution/device";

/**
 * supervisor 单元行为：首启签发码 spawn / 凭据重连 / 凭据撤销自愈 /
 * 秒退退避+连败告警（去重）/ spawn error 与 exit 幂等 / 稳定后退备重置 / stop 级联。
 * 子进程与配对服务均 fake（spawn 断言参数/env；repo 内存实现）。
 */

class FakeChild extends EventEmitter {
  readonly pid: number;
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  kills: Array<string | number> = [];
  private static nextPid = 41000;
  constructor() {
    super();
    this.pid = FakeChild.nextPid++;
  }
  kill(signal?: string | number): boolean {
    if (signal === undefined || signal === "SIGTERM" || signal === 15) signal = "SIGTERM";
    this.kills.push(signal);
    this.exitCode = null;
    this.signalCode = signal as NodeJS.Signals;
    this.emit("exit", null, signal as NodeJS.Signals);
    return true;
  }
  /** 模拟秒退崩溃（SIGKILL 语义） */
  crash(): void {
    this.signalCode = "SIGKILL";
    this.emit("exit", null, "SIGKILL");
  }
  /** 模拟正常退出 */
  exitNormally(): void {
    this.exitCode = 0;
    this.emit("exit", 0, null);
  }
}

function fakeRepo(devices: Device[] = []): ConnectorRegistryRepository {
  return {
    createPairingCode: async () => {},
    redeemPairingCode: async () => true,
    findActivePairingCode: async () => null,
    createDevice: async (d: Device) => { devices.push(d); },
    redeemAndCreateDevice: async () => true,
    findDeviceByToken: async (token: string) => devices.find(d => d.pairToken === token) ?? null,
    listDeviceOnlineStatus: async () => devices.map(d => ({ deviceId: d.id, name: d.name, online: false, lastSeenAt: d.lastSeenAt })),
    deleteDevice: async (id: string) => { const i = devices.findIndex(d => d.id === id); if (i >= 0) devices.splice(i, 1); },
    touchDeviceLastSeen: async () => {},
    openOnlineSession: async () => {},
    getOnlineSession: async () => null,
    touchOnlineSession: async () => {},
    closeOnlineSession: async () => {},
    listOnlineSessionsByDevice: async () => [],
    sweepStaleOnlineSessions: async () => 0,
  } as ConnectorRegistryRepository;
}

interface Harness {
  options: HubConnectorSupervisorOptions;
  children: FakeChild[];
  spawnCalls: Array<{ args: string[]; env: NodeJS.ProcessEnv }>;
  failures: Array<{ description: string; context: Record<string, unknown> }>;
  issueCalls: number;
  homeDir: string;
}

async function makeHarness(devices: Device[] = []): Promise<Harness> {
  const homeDir = await mkdtemp(path.join(tmpdir(), "hub-supervisor-test-"));
  const repo = fakeRepo(devices);
  let issueCalls = 0;
  const issuePairingCode = {
    execute: async () => {
      issueCalls += 1;
      return { code: "TESTCODE1", expiresAt: "2026-11-25T00:10:00Z" };
    },
  } as unknown as IssueConnectorPairingCode;
  const children: FakeChild[] = [];
  const spawnCalls: Array<{ args: string[]; env: NodeJS.ProcessEnv }> = [];
  const failures: Array<{ description: string; context: Record<string, unknown> }> = [];
  const options: HubConnectorSupervisorOptions = {
    repo,
    issuePairingCode,
    hubUrl: "http://127.0.0.1:8787",
    connectorEntry: "/dist/src/connector/main.js",
    homeDir,
    workspaceRoot: "/data",
    deviceName: "hub-test",
    logger: {
      info: () => {},
      warn: () => {},
      error: () => {},
    },
    onSustainedFailure: async (description, context) => { failures.push({ description, context }); },
    spawnFn: (args, env) => {
      spawnCalls.push({ args, env });
      const child = new FakeChild();
      children.push(child);
      return child as unknown as ChildProcess;
    },
    backoffBaseMs: 2,
    backoffMaxMs: 8,
    stableMs: 1000,
    failureThreshold: 3,
  };
  return { options, children, spawnCalls, failures, issueCalls, homeDir };
}

async function writeIdentity(homeDir: string, deviceId: string, pairToken: string): Promise<void> {
  const dir = path.join(homeDir, ".otter", "connector");
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "device.json"), JSON.stringify({ deviceId, pairToken }), "utf8");
}

describe("HubConnectorSupervisor", () => {
  it("首启（无身份）：签发配对码并带码 spawn，环境覆写 HOME，参数含 managed/workspace-root", async () => {
    const h = await makeHarness();
    const logged: unknown[] = [];
    h.options.logger.info = (_message, meta) => { logged.push(meta); };
    const sup = new HubConnectorSupervisor(h.options);
    await sup.start();
    expect(h.spawnCalls).toHaveLength(1);
    const { args, env } = h.spawnCalls[0]!;
    expect(args).toContain("--pair");
    expect(args[args.indexOf("--pair") + 1]).toBe("TESTCODE1");
    expect(args).toContain("--managed");
    expect(args[args.indexOf("--workspace-root") + 1]).toBe("/data");
    expect(args[args.indexOf("--hub") + 1]).toBe("http://127.0.0.1:8787");
    expect(args[args.indexOf("--name") + 1]).toBe("hub-test");
    expect(env.HOME).toBe(h.homeDir);
    expect(env.USERPROFILE).toBe(h.homeDir);
    // 配对码全文与前缀都不得进入日志元数据。
    expect(JSON.stringify(logged)).not.toContain("TESTCODE1");
    expect(JSON.stringify(logged)).not.toContain("codePrefix");
  });

  it("身份在册（token 有效）：无码 spawn（凭据重连）", async () => {
    const h = await makeHarness([{ id: "dev-1", name: "hub", pairToken: "tok-1", createdAt: "2026-11-25T00:00:00Z", lastSeenAt: null }]);
    await writeIdentity(h.homeDir, "dev-1", "tok-1");
    const sup = new HubConnectorSupervisor(h.options);
    await sup.start();
    expect(h.spawnCalls).toHaveLength(1);
    expect(h.spawnCalls[0]!.args).not.toContain("--pair");
  });

  it("凭据撤销自愈：token 查无设备 → 删身份文件 → 重新签发带码 spawn", async () => {
    const h = await makeHarness(); // 设备表空 = 已撤销
    await writeIdentity(h.homeDir, "dev-old", "tok-revoked");
    const sup = new HubConnectorSupervisor(h.options);
    await sup.start();
    expect(h.spawnCalls).toHaveLength(1);
    expect(h.spawnCalls[0]!.args).toContain("--pair");
    // 身份文件已删（重走首启）
    await expect(readFile(path.join(h.homeDir, ".otter", "connector", "device.json"), "utf8")).rejects.toThrow();
  });

  it("秒退循环：退避指数拉开 + 连败达阈值告警一次（去重）", async () => {
    const h = await makeHarness();
    const sup = new HubConnectorSupervisor(h.options);
    await sup.start();
    // 秒退 3 次（阈值 3）——每次 respawn 按 2/4/8ms 退避
    h.children[0]!.crash();
    await vi.waitFor(() => expect(h.spawnCalls.length).toBe(2));
    h.children[1]!.crash();
    await vi.waitFor(() => expect(h.spawnCalls.length).toBe(3));
    h.children[2]!.crash();
    await vi.waitFor(() => expect(h.failures.length).toBe(1));
    expect(h.failures[0]!.description).toContain("连续 3 次启动失败");
    // 继续秒退不再重复告警（去重——防 respawn 风暴刷屏）
    await vi.waitFor(() => expect(h.spawnCalls.length).toBe(4));
    h.children[3]!.crash();
    await vi.waitFor(() => expect(h.spawnCalls.length).toBe(5));
    expect(h.failures).toHaveLength(1);
  });

  it("spawn error：进入相同退避与告警链，紧随的 exit 不会双重 respawn", async () => {
    const h = await makeHarness();
    h.options.failureThreshold = 1;
    const warnings: Array<{ message: string; meta?: Record<string, unknown> }> = [];
    h.options.logger.warn = (message, meta) => { warnings.push({ message, meta }); };
    const sup = new HubConnectorSupervisor(h.options);
    await sup.start();

    h.children[0]!.emit("error", new Error("spawn EMFILE"));
    h.children[0]!.exitNormally();
    await vi.waitFor(() => expect(h.spawnCalls.length).toBe(2));
    expect(h.failures).toHaveLength(1);
    expect(h.failures[0]!.context.lastError).toBe("spawn EMFILE");
    expect(warnings.some(entry => entry.message === "hub connector process error — respawn scheduled")).toBe(true);

    h.children[0]!.crash();
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(h.spawnCalls).toHaveLength(2);
    expect(h.failures).toHaveLength(1);
  });

  it("稳定运行后退出：退避与连败重置，无告警", async () => {
    const harness = await makeHarness();
    // 用稳定阈值极小的 harness 模拟「稳定运行后退出」
    const opts = { ...harness.options, stableMs: 1 };
    const sup = new HubConnectorSupervisor(opts);
    await sup.start();
    await new Promise(r => setTimeout(r, 5));
    harness.children[0]!.exitNormally();
    await vi.waitFor(() => expect(harness.spawnCalls.length).toBe(2));
    expect(harness.failures).toHaveLength(0);
  }, 10_000);

  it("stop：SIGTERM 优雅退出，exit 后不再 respawn", async () => {
    const h = await makeHarness();
    const sup = new HubConnectorSupervisor(h.options);
    await sup.start();
    await sup.stop();
    expect(h.children[0]!.kills).toContain("SIGTERM");
    h.children[0]!.crash(); // stopping 后 exit 不再触发 respawn
    await new Promise(r => setTimeout(r, 20));
    expect(h.spawnCalls).toHaveLength(1);
  });

  it("幂等：重复 start 不重复 spawn", async () => {
    const h = await makeHarness();
    const sup = new HubConnectorSupervisor(h.options);
    await sup.start();
    await sup.start();
    expect(h.spawnCalls).toHaveLength(1);
  });
});
