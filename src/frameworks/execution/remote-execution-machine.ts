import type { ExecutionEnv, ShellOutputInfo } from "@earendil-works/pi-durable/env";
import { randomUUID } from "node:crypto";
import {
  type ActionRunOptions,
  type ExecutionAction,
  type ExecutionActionResult,
  type ExecutionActionType,
  type ExecutionMachine,
} from "@usecases/ports/execution-machine";
import { CONNECTOR_ACTION_TIMEOUT_MS, CONNECTOR_PROTOCOL_VERSION, type ConnectorFrame, type ShellExecActionInput } from "@entities/execution/connector-protocol";
import { otterInvokeStorage } from "@entities/execution/otter-invoke-context";
import type { ConnectorActionChannel } from "./connector-ws-gateway";
import type { RemoteActionRegistry } from "@usecases/ports/remote-action-registry";
import type { ConnectorRegistryRepository } from "@usecases/ports/connector-registry-repository";
import { RemoteExecutionEnv } from "./remote-execution-env";

/** 远程动作失败保留机器可读分类与部分结果，供 ExecutionEnv 还原 SDK 错误面。 */
export class RemoteActionError extends Error {
  constructor(message: string, readonly errorCode?: string, readonly result?: unknown) {
    super(message);
    this.name = "RemoteActionError";
  }
}

interface PendingWaiter {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  onOutput?: (text: string, info: ShellOutputInfo) => void;
  abortSignal?: AbortSignal;
  abortHandler?: () => void;
}

/**
 * 远程执行机——动作经 WSS 通道下发 connector 执行。
 *
 * 总闸三道：在线会话事实源、Registry 投影、活体通道。每次下发先登记
 * remote_action_requests，再等 action.result；超时/会话下线落 unknown 或
 * interrupted，不盲重试。流式输出只转发，不改变动作终态。
 */
export class RemoteExecutionMachine implements ExecutionMachine {
  readonly name: string;

  private readonly pending = new Map<string, PendingWaiter>();
  private wired = false;

  constructor(
    readonly id: string,
    name: string | undefined,
    private readonly deps: {
      channel: ConnectorActionChannel;
      remoteActions: RemoteActionRegistry;
      connectorRegistry: ConnectorRegistryRepository;
      hubBootEpoch: number;
      actionTimeoutMs?: number;
      now?: () => number;
      warn?: (message: string, meta?: Record<string, unknown>) => void;
    },
  ) {
    this.name = name ?? id;
  }

  wireChannel(): void {
    if (this.wired) return;
    this.wired = true;
    this.deps.channel.onActionResult(frame => {
      const waiter = this.pending.get(frame.data.actionId);
      if (!waiter) return;
      this.clearPending(frame.data.actionId, waiter);
      void this.deps.remoteActions.settleRequest(frame.data.actionId, frame.data.status, this.isoNow(), frame.data.result, frame.data.error);
      if (frame.data.status === "succeeded") {
        waiter.resolve(frame.data.result);
      } else {
        waiter.reject(new RemoteActionError(
          frame.data.error ?? `remote action ${frame.data.status}: ${frame.data.actionId}`,
          frame.data.errorCode,
          frame.data.result,
        ));
      }
    });
    this.deps.channel.onActionOutput?.(frame => {
      const waiter = this.pending.get(frame.data.actionId);
      if (!waiter?.onOutput) return;
      try {
        waiter.onOutput(frame.data.text, {
          stream: frame.data.stream,
          ...(frame.data.skipped ? { skipped: frame.data.skipped } : {}),
        });
      } catch (error) {
        this.deps.warn?.("remote action output callback failed", { actionId: frame.data.actionId, error: String(error) });
      }
    });
    this.deps.channel.onSessionDown((sessionId, deviceId, reason) => {
      if (deviceId !== this.id) return;
      const verdict = reason === "device-offline" ? "interrupted" : "unknown";
      const batchError = verdict === "interrupted" ? "device offline before result (graceful: interrupted)" : "device offline before result";
      void this.deps.remoteActions.markSessionRequests(sessionId, verdict, this.isoNow(), batchError).catch(err => {
        this.deps.warn?.("remote action session-down settle failed (rows stay requested)", { sessionId, verdict, error: String(err) });
      });
      for (const [actionId, waiter] of [...this.pending.entries()]) {
        this.clearPending(actionId, waiter);
        waiter.reject(new Error(`device session down before result (${verdict}): ${sessionId}`));
      }
    });
  }

  createExecutionEnvironment(cwd: string, conversationId?: string): ExecutionEnv {
    if (!conversationId) throw new Error(`remote execution environment requires conversationId (device: ${this.id})`);
    return new RemoteExecutionEnv(this, cwd, conversationId);
  }

  /** 远程 bash 能力预检，避免旧协议会话先发工作区查询再失败。 */
  assertShellSupported(): void {
    if (this.deps.channel.negotiatedVersion?.(this.id) === 1) {
      throw new Error("shell.exec requires connector protocol v2");
    }
  }

  private frameSeq = 0;

  async run<K extends ExecutionActionType>(
    action: ExecutionAction<K>,
    _targetMachineId?: string,
    options?: ActionRunOptions,
  ): Promise<ExecutionActionResult<K>> {
    this.wireChannel();
    const session = await this.requireOnlineSession(action, options?.abortSignal);
    const actionId = options?.actionId ?? `${String(this.deps.hubBootEpoch)}-${randomUUID()}`;
    await this.recordAction(action, actionId, session.id);
    return this.dispatch(action, actionId, session.id, options);
  }

  private async requireOnlineSession(
    action: ExecutionAction<ExecutionActionType>,
    abortSignal?: AbortSignal,
  ): Promise<{ id: string; status: string }> {
    if (abortSignal?.aborted) throw new Error("remote action aborted before send");
    const session = await this.findOnlineSession();
    if (!session || session.status !== "online") {
      throw new Error(`connector device offline or unpaired: ${this.id}`);
    }
    if (action.type === "shell.exec") this.assertShellSupported();
    return session;
  }

  private async recordAction(
    action: ExecutionAction<ExecutionActionType>,
    actionId: string,
    onlineSessionId: string,
  ): Promise<void> {
    const recorded = await this.deps.remoteActions.recordRequest({
      actionId, onlineSessionId, deviceId: this.id, actionType: action.type,
      status: "requested", error: null, result: null, createdAt: this.isoNow(), settledAt: null,
      conversationId: this.conversationIdOf(action.input),
      invokeId: otterInvokeStorage.getStore()?.currentInvokeId ?? null,
    });
    if (!recorded) throw new Error(`duplicate remote actionId: ${actionId}`);
  }

  private async dispatch<K extends ExecutionActionType>(
    action: ExecutionAction<K>,
    actionId: string,
    sessionId: string,
    options?: ActionRunOptions,
  ): Promise<ExecutionActionResult<K>> {
    const wait = this.createWaiter(actionId, sessionId, action.type, options);
    const input = action.type === "shell.exec"
      ? { ...action.input, invokeId: (action.input as ShellExecActionInput).invokeId ?? otterInvokeStorage.getStore()?.currentInvokeId }
      : action.input;
    const sent = this.deps.channel.sendToDevice(this.id, {
      v: CONNECTOR_PROTOCOL_VERSION,
      type: "action.request",
      seq: (this.frameSeq += 1),
      sid: sessionId,
      data: { actionId, action: { type: action.type, input: input as Record<string, unknown> } },
    } satisfies ConnectorFrame);
    if (!sent) await this.failSend(actionId);
    if (options?.abortSignal?.aborted) this.pending.get(actionId)?.abortHandler?.();
    return wait;
  }

  private createWaiter<K extends ExecutionActionType>(
    actionId: string,
    sessionId: string,
    actionType: ExecutionActionType,
    options?: ActionRunOptions,
  ): Promise<ExecutionActionResult<K>> {
    return new Promise<ExecutionActionResult<K>>((resolve, reject) => {
      const waiter: PendingWaiter = {
        resolve: result => resolve(result as ExecutionActionResult<K>), reject,
        onOutput: options?.onOutput, abortSignal: options?.abortSignal,
        timer: setTimeout(() => this.timeoutWaiter(actionId, sessionId, actionType, options?.timeoutMs ?? this.timeout, reject), options?.timeoutMs ?? this.timeout),
      };
      waiter.abortHandler = () => this.deps.channel.sendToDevice(this.id, {
        v: CONNECTOR_PROTOCOL_VERSION, type: "action.cancel", seq: (this.frameSeq += 1), sid: sessionId, data: { actionId },
      });
      this.pending.set(actionId, waiter);
      options?.abortSignal?.addEventListener("abort", waiter.abortHandler, { once: true });
    });
  }

  private timeoutWaiter(
    actionId: string,
    sessionId: string,
    actionType: ExecutionActionType,
    timeoutMs: number,
    reject: (error: Error) => void,
  ): void {
    if (actionType === "shell.exec") {
      this.deps.channel.sendToDevice(this.id, {
        v: CONNECTOR_PROTOCOL_VERSION, type: "action.cancel", seq: (this.frameSeq += 1), sid: sessionId, data: { actionId },
      });
    }
    const current = this.pending.get(actionId);
    if (current) this.clearPending(actionId, current);
    void this.deps.remoteActions.settleRequest(actionId, "unknown", this.isoNow(), undefined, `timeout after ${String(timeoutMs)}ms`);
    reject(new Error(`remote action timeout: ${actionId}`));
  }

  private async failSend(actionId: string): Promise<never> {
    const waiter = this.pending.get(actionId);
    if (waiter) this.clearPending(actionId, waiter);
    await this.deps.remoteActions.settleRequest(actionId, "unknown", this.isoNow(), undefined, "channel closed before send");
    throw new Error(`connector channel unavailable: ${this.id}`);
  }

  private clearPending(actionId: string, waiter: PendingWaiter): void {
    clearTimeout(waiter.timer);
    if (waiter.abortSignal && waiter.abortHandler) {
      waiter.abortSignal.removeEventListener("abort", waiter.abortHandler);
    }
    this.pending.delete(actionId);
  }

  private get timeout(): number {
    return this.deps.actionTimeoutMs ?? CONNECTOR_ACTION_TIMEOUT_MS;
  }

  private conversationIdOf(input: unknown): string | null {
    const candidate = (input as { conversationId?: unknown } | undefined)?.conversationId;
    return typeof candidate === "string" ? candidate : null;
  }

  private async findOnlineSession(): Promise<{ id: string; status: string } | null> {
    const sessions = await this.deps.connectorRegistry.listOnlineSessionsByDevice(this.id);
    return sessions.length > 0 ? sessions[0]! : null;
  }

  private isoNow(): string {
    return new Date(this.deps.now?.() ?? Date.now()).toISOString();
  }
}
