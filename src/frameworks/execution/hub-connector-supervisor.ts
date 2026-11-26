import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { ConnectorRegistryRepository } from "@usecases/ports/connector-registry-repository";
import type { IssueConnectorPairingCode } from "@usecases/execution/issue-connector-pairing-code";

/**
 * 中枢本机 connector 子进程 supervisor（统一注册制的生命周期管理）。
 *
 * 中枢机器不再是内置特权执行机——启动时自动拉起本机 connector 子进程、
 * 首启自动配对（复用既有配对码协议，不经人工）、掉线自动重启（指数退避）、
 * 凭据失效自愈（身份在册但设备被撤销 → 删身份重走配对）、停止级联终止。
 *
 * 隔离选型（spike 结论）：connector 的 HOME 覆写指向中枢数据目录专用子目录——
 * 身份文件 device.json / 实例锁 / 设备台账全随 homedir 走，与用户手装 connector
 * 天然隔离，中枢侧零新增表/文件；workspace root 经 --workspace-root 指回中枢
 * dataDir（workspace.* 落点与原内置执行机同路径，存量对话工作区零迁移）。
 *
 * 孤儿双保险：正常退出走本类 stop()（SIGTERM 优雅链）；supervisor 自身被
 * SIGKILL 的场景由 connector 的 --managed ppid watch 兜底（父死后自退）。
 *
 * 可观测性：连续失败（子进程反复秒退）达阈值 → healing high 告警（一次告警
 * 后去重，成功稳定运行才重置——防 respawn 风暴刷屏台账）。
 */

export interface HubConnectorSupervisorOptions {
  /** connector 注册仓库（签发码走 usecase；凭据自愈检测走 findDeviceByToken） */
  repo: ConnectorRegistryRepository;
  /** 配对码签发（登录态设备接入的唯一签发入口——supervisor 复用同口径：码形/TTL/核销） */
  issuePairingCode: IssueConnectorPairingCode;
  /** connector 可达的中枢地址（同机回环，如 http://127.0.0.1:8787） */
  hubUrl: string;
  /** connector 入口脚本绝对路径（dist 产物） */
  connectorEntry: string;
  /** connector HOME 隔离目录（身份文件/实例锁/设备台账都在其下；建议 <dataDir>/hub-connector-home） */
  homeDir: string;
  /** workspace 根覆写（--workspace-root；指回中枢 dataDir 实现工作区同路径） */
  workspaceRoot: string;
  /** 设备注册名（机器池展示；建议 hostname） */
  deviceName: string;
  logger: {
    info(message: string, meta?: Record<string, unknown>): void;
    warn(message: string, meta?: Record<string, unknown>): void;
    error(message: string, err?: Error, meta?: Record<string, unknown>): void;
  };
  /** 连续失败告警落账（缺省只日志——旧装配/测试零依赖） */
  onSustainedFailure?: (description: string, context: Record<string, unknown>) => Promise<void> | void;
  /** 测试注入假时钟与 spawn */
  now?: () => number;
  spawnFn?: (args: string[], env: NodeJS.ProcessEnv) => ChildProcess;
  /** respawn 退避参数（测试注入小值） */
  backoffBaseMs?: number;
  backoffMaxMs?: number;
  /** 稳定运行判定阈值（存活超过此时长的退出视为正常运行结束，重置退避与连败） */
  stableMs?: number;
  /** 连败告警阈值 */
  failureThreshold?: number;
}

const DEFAULT_BACKOFF_BASE_MS = 1_000;
const DEFAULT_BACKOFF_MAX_MS = 30_000;
/** 子进程稳定运行阈值：超过此刻的 exit 重置退避（与 connector 自身重连退避同量级） */
const DEFAULT_STABLE_MS = 60_000;
const DEFAULT_FAILURE_THRESHOLD = 5;

interface DeviceIdentityFile {
  deviceId: string;
  pairToken: string;
  hubUrl?: string;
}

export class HubConnectorSupervisor {
  private readonly opts: Required<Pick<HubConnectorSupervisorOptions, "backoffBaseMs" | "backoffMaxMs" | "stableMs" | "failureThreshold">>
    & HubConnectorSupervisorOptions;

  private child: ChildProcess | null = null;
  private backoffMs: number;
  private consecutiveFailures = 0;
  private failureAlerted = false;
  private startedAt = 0;
  private stopping = false;
  private startRequested = false;
  private exitWaiters: Array<() => void> = [];
  /** 测试注入的假时钟句柄（退避计时器；真时钟走 setTimeout） */
  private pendingRespawnTimer: NodeJS.Timeout | null = null;

  constructor(options: HubConnectorSupervisorOptions) {
    this.opts = {
      backoffBaseMs: options.backoffBaseMs ?? DEFAULT_BACKOFF_BASE_MS,
      backoffMaxMs: options.backoffMaxMs ?? DEFAULT_BACKOFF_MAX_MS,
      stableMs: options.stableMs ?? DEFAULT_STABLE_MS,
      failureThreshold: options.failureThreshold ?? DEFAULT_FAILURE_THRESHOLD,
      ...options,
    };
    this.backoffMs = this.opts.backoffBaseMs;
  }

  /** 启动 supervisor（幂等；异步自驱循环，不 await 子进程生命周期） */
  async start(): Promise<void> {
    if (this.startRequested) return;
    this.startRequested = true;
    this.stopping = false;
    await mkdir(this.opts.homeDir, { recursive: true });
    await this.ensureConnector();
  }

  /** 停止级联：SIGTERM 优雅退出 → 超时 SIGKILL；幂等。 */
  async stop(): Promise<void> {
    if (!this.startRequested) return;
    this.stopping = true;
    if (this.pendingRespawnTimer) {
      clearTimeout(this.pendingRespawnTimer);
      this.pendingRespawnTimer = null;
    }
    const child = this.child;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    await new Promise<void>((resolve) => {
      const killTimer = setTimeout(() => {
        child.kill("SIGKILL");
      }, 5_000);
      this.exitWaiters.push(() => {
        clearTimeout(killTimer);
        resolve();
      });
      child.kill("SIGTERM");
    });
  }

  /** 当前子进程 pid（诊断面；未运行返回 null） */
  get pid(): number | null {
    return this.child?.pid ?? null;
  }

  private async identityFile(): Promise<DeviceIdentityFile | null> {
    try {
      return JSON.parse(
        await readFile(path.join(this.opts.homeDir, ".otter", "connector", "device.json"), "utf8"),
      ) as DeviceIdentityFile;
    } catch {
      return null;
    }
  }

  /**
   * 凭据自愈检测（spawn 前每次跑，一次 DB 查询的代价）：
   * 身份文件在册但设备已撤销（findDeviceByToken 返回 null）→ 删身份文件重走配对。
   * 撤销后的重新配对产生新 deviceId——旧设备行保留 offline 状态，不互踢（spike 场景 3 语义）。
   */
  private async healRevokedCredential(): Promise<boolean> {
    const identity = await this.identityFile();
    if (!identity?.pairToken) return false;
    const device = await this.opts.repo.findDeviceByToken(identity.pairToken);
    if (device) return false;
    this.opts.logger.warn("hub connector credential revoked — re-pairing (new device id will register)", {
      oldDeviceId: identity.deviceId,
    });
    await rm(path.join(this.opts.homeDir, ".otter", "connector", "device.json"), { force: true });
    return true;
  }

  /** 确保 connector 在跑：凭据检测 → 首启签发码 → spawn → 挂终态重启链。 */
  private async ensureConnector(): Promise<void> {
    if (this.stopping) return;
    await this.healRevokedCredential();
    const identity = await this.identityFile();
    let pairArgs: string[] = [];
    if (!identity) {
      const issued = await this.opts.issuePairingCode.execute();
      this.opts.logger.info("hub connector first boot — pairing code issued", {
        expiresAt: issued.expiresAt,
        // 一次性秘密不以任何形式落日志（含前缀）；只记录过期时间供启动排障。
      });
      pairArgs = ["--pair", issued.code];
    }
    this.spawnConnector(pairArgs);
  }

  private spawnConnector(extraArgs: string[]): void {
    const args = [
      this.opts.connectorEntry,
      "--hub", this.opts.hubUrl,
      "--name", this.opts.deviceName,
      "--workspace-root", this.opts.workspaceRoot,
      "--managed",
      ...extraArgs,
    ];
    // HOME 覆写隔离身份/锁/台账（Windows 上 USERPROFILE 同覆——尽力兼容）
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: this.opts.homeDir,
      USERPROFILE: this.opts.homeDir,
    };
    const child = this.opts.spawnFn
      ? this.opts.spawnFn(args, env)
      : spawn(process.execPath, args, { env, stdio: ["ignore", "pipe", "pipe"], detached: false });
    this.child = child;
    this.startedAt = this.opts.now?.() ?? Date.now();
    this.opts.logger.info("hub connector spawned", { pid: child.pid, paired: extraArgs.length > 0 });
    // error/exit 可能先后到达；每个 child 只许一个终态进入清理与重连链。
    let terminalHandled = false;
    const onTerminal = (code: number | null, signal: NodeJS.Signals | null, error?: Error): void => {
      if (terminalHandled) return;
      terminalHandled = true;
      if (this.child !== child) return;
      this.child = null;
      if (this.stopping) {
        this.exitWaiters.forEach((wake) => wake());
        this.exitWaiters = [];
        return;
      }
      void this.onChildTermination(code, signal, error);
    };
    child.on("error", (error) => onTerminal(null, null, error));
    child.on("exit", (code, signal) => onTerminal(code, signal));
    // 子进程输出透传（supervisor 日志面；不吞 connector 侧排障线索）
    child.stdout?.on("data", (d: Buffer) => {
      this.opts.logger.info("hub-connector", { stdout: String(d).trim().slice(0, 2000) });
    });
    child.stderr?.on("data", (d: Buffer) => {
      this.opts.logger.warn("hub-connector stderr", { text: String(d).trim().slice(0, 2000) });
    });
  }

  private async onChildTermination(code: number | null, signal: NodeJS.Signals | null, error?: Error): Promise<void> {
    const now = this.opts.now?.() ?? Date.now();
    const ranMs = now - this.startedAt;
    if (ranMs < this.opts.stableMs) {
      this.consecutiveFailures += 1;
      if (this.consecutiveFailures >= this.opts.failureThreshold && !this.failureAlerted) {
        this.failureAlerted = true;
        this.opts.logger.error(`hub connector failed ${String(this.consecutiveFailures)} times in a row — machine pool degraded`, undefined, {
          consecutiveFailures: this.consecutiveFailures,
        });
        const alert = this.opts.onSustainedFailure?.(
          `中枢本机 connector 连续 ${String(this.consecutiveFailures)} 次启动失败（秒退循环）——中枢机器执行能力不可用，机器池降级`,
          {
            consecutiveFailures: this.consecutiveFailures,
            lastExitCode: code,
            lastSignal: signal,
            lastError: error?.message,
            backoffMs: this.backoffMs,
          },
        );
        await Promise.resolve(alert).catch(() => { /* 告警落账失败不阻断自愈循环 */ });
      }
    } else {
      // 稳定运行后的退出（正常更新/宿主信号）：重置退避与连败
      this.consecutiveFailures = 0;
      this.failureAlerted = false;
      this.backoffMs = this.opts.backoffBaseMs;
    }
    this.opts.logger.warn(error
      ? "hub connector process error — respawn scheduled"
      : "hub connector exited — respawn scheduled", {
      code, signal, error: error?.message, ranMs, respawnInMs: this.backoffMs, consecutiveFailures: this.consecutiveFailures,
    });
    this.pendingRespawnTimer = setTimeout(() => {
      this.pendingRespawnTimer = null;
      void this.ensureConnector().catch((err) => {
        this.opts.logger.error("hub connector respawn failed", err instanceof Error ? err : new Error(String(err)));
      });
    }, this.backoffMs);
    this.backoffMs = Math.min(this.backoffMs * 2, this.opts.backoffMaxMs);
  }

  /** 生成 healing high 事件载荷（装配层用——保持 supervisor 与 healing 实体解耦） */
  static sustainedFailureEventId(): string {
    return randomUUID();
  }
}
