import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { randomUUID } from "node:crypto";
import {
  type ActionRunOptions,
  type ExecutionAction,
  type ExecutionActionResult,
  type ExecutionActionType,
  type ExecutionMachine,
} from "@usecases/ports/execution-machine";
import { CONNECTOR_ACTION_TIMEOUT_MS, CONNECTOR_PROTOCOL_VERSION, type ConnectorFrame } from "@entities/execution/connector-protocol";
import { otterInvokeStorage } from "@entities/execution/otter-invoke-context";
import type { ConnectorActionChannel } from "./connector-ws-gateway";
import type { RemoteActionRegistry } from "@usecases/ports/remote-action-registry";
import type { ConnectorRegistryRepository } from "@usecases/ports/connector-registry-repository";

/**
 * F20261118remex（#1868 阶段 4 C2）：远程执行机——动作经 WSS 通道下发 connector 执行。
 *
 * 总闸三道（方案 v3 §5/S1）：① online_sessions 表 status=online（唯一事实源直查）
 * + ② Registry 投影可达（本机实例注册即达） + ③ 通道已连接（sendToDevice）。
 * 每次下发：actionId（调用方透传或 `<中枢bootEpoch>-<uuid>` 自铸）先登记
 * remote_action_requests（requested）→ action.request → 等 action.result；
 * 超时/会话下线 → 落 unknown（不盲重试，五态纪律）——R1 落点。
 * createExecutionEnvironment 不支持（SDK 文件/bash 面只在 local 机器；远程工具面
 * 走动作协议——阶段 5/7 语义）。
 */
export class RemoteExecutionMachine implements ExecutionMachine {
  readonly name: string;

  /** actionId 等待表：actionId → resolver（result 帧到达/超时/下线时兑现） */
  private readonly pending = new Map<string, { resolve: (r: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private wired = false;

  constructor(
    readonly id: string,
    name: string | undefined,
    private readonly deps: {
      channel: ConnectorActionChannel;
      remoteActions: RemoteActionRegistry;
      connectorRegistry: ConnectorRegistryRepository;
      /** 中枢 boot 纪元（actionId 前缀——跨重启防碰撞） */
      hubBootEpoch: number;
      actionTimeoutMs?: number;
      now?: () => number;
    },
  ) {
    this.name = name ?? id;
  }

  /** 通道回调接线（装配处调用一次；幂等）——result 分发 + 会话下线收尾 */
  wireChannel(): void {
    if (this.wired) return;
    this.wired = true;
    this.deps.channel.onActionResult(frame => {
      const waiter = this.pending.get(frame.data.actionId);
      if (!waiter) return;
      clearTimeout(waiter.timer);
      this.pending.delete(frame.data.actionId);
      void this.deps.remoteActions.settleRequest(frame.data.actionId, frame.data.status, this.isoNow(), frame.data.result, frame.data.error);
      if (frame.data.status === "succeeded") waiter.resolve(frame.data.result);
      else waiter.reject(new Error(frame.data.error ?? `remote action ${frame.data.status}: ${frame.data.actionId}`));
    });
    this.deps.channel.onSessionDown((sessionId, _deviceId) => {
      // 会话下线：该会话在途等待全部收尾 unknown（registry 批量落；等待者 reject）
      void this.deps.remoteActions.markSessionRequestsUnknown(sessionId, this.isoNow()).catch(() => {});
      for (const [actionId, waiter] of [...this.pending.entries()]) {
        clearTimeout(waiter.timer);
        this.pending.delete(actionId);
        waiter.reject(new Error(`device session down before result: ${sessionId}`));
      }
    });
  }

  createExecutionEnvironment(_cwd: string): ExecutionEnv {
    throw new Error(`remote machine does not host SDK execution environments (device: ${this.id})`);
  }

  async run<K extends ExecutionActionType>(
    action: ExecutionAction<K>,
    _targetMachineId?: string,
    options?: ActionRunOptions,
  ): Promise<ExecutionActionResult<K>> {
    this.wireChannel();
    // 总闸①：唯一事实源直查（session online）
    const session = await this.findOnlineSession();
    if (!session || session.status !== "online") {
      throw new Error(`connector device offline or unpaired: ${this.id}`);
    }

    const actionId = options?.actionId ?? `${String(this.deps.hubBootEpoch)}-${randomUUID()}`;
    const recorded = await this.deps.remoteActions.recordRequest({
      actionId,
      onlineSessionId: session.id,
      deviceId: this.id,
      actionType: action.type,
      status: "requested",
      error: null,
      result: null,
      createdAt: this.isoNow(),
      settledAt: null,
      // R2 关联维度：六动作 input 均携带 conversationId；invoke 归因取 hub 进程内上下文
      conversationId: this.conversationIdOf(action.input),
      invokeId: otterInvokeStorage.getStore()?.currentInvokeId ?? null,
    });
    if (!recorded) throw new Error(`duplicate remote actionId: ${actionId}`);

    const sent = this.deps.channel.sendToDevice(this.id, {
      v: CONNECTOR_PROTOCOL_VERSION,
      type: "action.request",
      seq: 0,
      sid: session.id,
      data: { actionId, action: { type: action.type, input: action.input as Record<string, unknown> } },
    } satisfies ConnectorFrame);
    if (!sent) {
      // 总闸③未过（通道刚断）：登记行落 unknown（会话下线钩子也会批量收——这里精确收）
      await this.deps.remoteActions.settleRequest(actionId, "unknown", this.isoNow(), undefined, "channel closed before send");
      throw new Error(`connector channel unavailable: ${this.id}`);
    }

    return await new Promise<ExecutionActionResult<K>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(actionId);
        void this.deps.remoteActions.settleRequest(actionId, "unknown", this.isoNow(), undefined, `timeout after ${String(this.timeout)}ms`);
        reject(new Error(`remote action timeout: ${actionId}`));
      }, this.timeout);
      this.pending.set(actionId, {
        resolve: r => resolve(r as ExecutionActionResult<K>),
        reject,
        timer,
      });
    });
  }

  private get timeout(): number {
    return this.deps.actionTimeoutMs ?? CONNECTOR_ACTION_TIMEOUT_MS;
  }

  /** 六动作 input 均携带 conversationId（workspace.path 除外——返回路径无副作用，
   *  无会话维度时 null，不影响登记） */
  private conversationIdOf(input: unknown): string | null {
    const candidate = (input as { conversationId?: unknown } | undefined)?.conversationId;
    return typeof candidate === "string" ? candidate : null;
  }

  private async findOnlineSession(): Promise<{ id: string; status: string } | null> {
    // 通过 repo 的既有接口找当前 online 会话（listOnlineByDevice 语义：deviceIndex 在 gateway，
    // 这里走库表查询——ConnectorRegistryRepository 需暴露按 device 查 online 行）
    const sessions = await this.deps.connectorRegistry.listOnlineSessionsByDevice(this.id);
    return sessions.length > 0 ? sessions[0]! : null;
  }

  private isoNow(): string {
    return new Date(this.deps.now?.() ?? Date.now()).toISOString();
  }
}
