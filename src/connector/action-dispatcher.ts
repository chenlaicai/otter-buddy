/**
 * connector 侧动作分发器——action.request →
 * 本地执行 → action.result 回执；action.cancel（协议 v2）→ 只 abort 指定动作。
 *
 * 可测性：不持有 ws 对象（发帧经 sender 回调，sid/seq 由会话层闭包负责），
 * 六动作经 WorkspaceActionExecutor（与中枢 local 同一执行语义与台账记账协议），
 * shell.exec 经 ShellActionExecutor（独立 env + AbortController；SDK 杀进程组）。
 *
 * 幂等协议：先查本地台账——actionId 已 succeeded 直接回已记录结果
 * （不重执行）；未见过/其他状态照常执行（executor 内部台账 start 对真冲突行兜底
 * dedupe）。回执五态：succeeded/failed 为执行结论；unknown/interrupted 为收尾裁决
 * （本模块只在崩溃/下线路径产生——正常执行两态即可达；shell.exec 的
 *  aborted/timeout 映射 interrupted 属确定性停止，正常路径亦可达）。
 *
 * 轻量铁律：依赖闭包仅 entities/execution + node 内置 + SDK env 轻量面
 * （构建后闭包断言把守）。
 */

import type { ConnectorFrame, ShellExecActionInput } from "@entities/execution/connector-protocol";
import type { ActionRecord } from "@entities/execution/action-record";
import type { AnyExecutionAction } from "@usecases/ports/execution-machine";
import type { ShellExecutorLike, ShellRunOutcome } from "./shell-action-executor";
import type { FileActionOutcome, FileExecutorLike } from "./file-action-executor";

/** connector 侧六动作执行面（WorkspaceActionExecutor 的最小依赖切片——测试可 fake） */
export interface ActionExecutorLike {
  run(action: AnyExecutionAction, options?: { actionId?: string }): Promise<unknown>;
}

export interface ConnectorActionDispatcherDeps {
  executor: ActionExecutorLike;
  /** shell.exec 执行器（协议 v2 面；缺省 = 本构建不带 shell 能力——收到 shell.exec 回
   *  failed/unsupported。v1 会话收到 shell.exec 不应发生：hub 下行版本闸已拦） */
  shell?: ShellExecutorLike;
  /** file.* 族执行器（协议 v2 面；缺省同上回 failed/unsupported） */
  file?: FileExecutorLike;
  /** 本地台账只读面（幂等快路径）+ 收尾面（自杀收尾落 interrupted） */
  ledger: {
    getByActionId(actionId: string): Promise<ActionRecord | null>;
    settle(actionId: string, verdict: { status: "interrupted"; error?: string }): Promise<void>;
  };
  /** 回执发帧（会话层闭包封装完整帧：v/type/seq/sid——本层不管会话封装字段） */
  send: (data: Extract<ConnectorFrame, { type: "action.result" }>['data']) => void;
  log?: (message: string, meta?: Record<string, unknown>) => void;
}

/** 执行能力白名单（非白名单 type 回 failed——协议 v1 六动作 + v2 新增 shell.exec 与 file.* 族）。
 *  注意与版本闸的分层：本集合是「本端会执行什么」；「v1 会话收不到 v2 动作」
 *  由 hub 侧 sendToDevice 版本闸保证（双保险）。 */
const SUPPORTED_ACTION_TYPES = new Set<string>([
  "workspace.exists",
  "workspace.list",
  "workspace.read",
  "workspace.write",
  "workspace.delete",
  "workspace.path",
  "shell.exec",
  "file.read", "file.readLines", "file.readBinary", "file.write", "file.append", "file.truncate",
  "file.rename", "file.remove", "file.mkdir", "file.stat", "file.list", "file.exists",
  "file.canonicalPath", "file.absolutePath", "file.joinPath",
  "file.createTempDir", "file.createTempFile", "file.flush",
  "file.openReader", "file.readerRead", "file.readerScanLines", "file.readerInfo",
  "file.openDirReader", "file.dirReaderNext", "file.openLineReader", "file.lineReaderRead",
  "file.resourceClose",
]);

export class ConnectorActionDispatcher {
  /** 在途执行追踪（SIGTERM 自杀收尾——在途 actionId 立即落 interrupted，
 * 不等完成；第4步「取消本进程 running，台账落 interrupted」语义） */
  private readonly inflight = new Map<string, true>();
  get inflightCount(): number { return this.inflight.size; }

  constructor(private readonly deps: ConnectorActionDispatcherDeps) {}

  /** （检视）：自杀收尾——在途动作立即对台账落 interrupted（不等 fs 完成；
 *  完成后 executor 的 settle succeeded 被幂等拦住——调用方视角动作已取消，
 *  两侧（中枢/端上）一致 interrupted，消除两面裁决冲突） */
  async markInflightInterrupted(): Promise<void> {
    const actionIds = [...this.inflight.keys()];
    await Promise.all(actionIds.map(async actionId => {
      try {
        await this.deps.ledger.settle(actionId, { status: "interrupted", error: "connector shutting down (graceful offline)" });
      } catch { /* 台账缺席/失败：开机清扫兑底 */ }
    }));
  }

  /** 处理一帧 action.request（sid 已由会话层校验过——本层只管执行与回执） */
  async handleActionRequest(frame: Extract<ConnectorFrame, { type: "action.request" }>): Promise<void> {
    const { actionId, action } = frame.data;

    if (!SUPPORTED_ACTION_TYPES.has(action.type)) {
      this.sendResult(actionId, { status: "failed", error: `unsupported action type: ${String(action.type)}` });
      return;
    }

    // 幂等快路径：actionId 已 succeeded → 直接回已记录结果，不重执行
    try {
      const existing = await this.deps.ledger.getByActionId(actionId);
      if (existing?.status === "succeeded") {
        this.deps.log?.("action deduped (already succeeded)", { actionId, type: action.type });
        // （检视）：回执以活体语义为准——活体 result 为 null（void 类）的动作族
        //  快路径不回 resultSummary（write 的 {bytes} 与活体不一致）；delete 的 {deleted} 与活体一致可透传
        this.sendResult(actionId, {
          status: "succeeded",
          result: VOID_RESULT_KINDS.has(existing.kind) ? null : this.parseSummary(existing.resultSummary),
        });
        return;
      }
    } catch (err) {
      // 台账读失败 → 降级走执行（记账降级语义：台账缺席时动作照常执行）
      this.deps.log?.("action ledger lookup failed (degraded to execute)", { actionId, error: String(err) });
    }

    try {
      this.inflight.set(actionId, true);
      // shell.exec / file.* 走专用执行器；六动作走公共 WorkspaceActionExecutor（与中枢 local 同一执行语义）
      if (await this.runShell(actionId, action)) return;
      if (await this.runFile(actionId, action)) return;
      const result = await this.deps.executor.run(
        { type: action.type, input: action.input } as AnyExecutionAction,
        { actionId },
      );
      this.sendResult(actionId, { status: "succeeded", result });
    } catch (err) {
      // executor 内部已 settle failed（台账在场时）；此处只负责回执
      this.sendResult(actionId, { status: "failed", error: err instanceof Error ? err.message : String(err) });
    } finally {
      this.inflight.delete(actionId);
    }
  }

  /** shell.exec 路由（独立 env + AbortController/流式 output/取消）；非 shell.exec 返回 false */
  private async runShell(actionId: string, action: { type: string; input: unknown }): Promise<boolean> {
    if (action.type !== "shell.exec") return false;
    if (!this.deps.shell) {
      this.sendResult(actionId, { status: "failed", error: "unsupported action type: shell.exec (no shell executor)" });
      return true;
    }
    const outcome = await this.deps.shell.run(action.input as unknown as ShellExecActionInput, { actionId });
    this.sendShellOutcome(actionId, outcome);
    return true;
  }

  /** file.* 族路由（FileActionExecutor：设备侧语义 + 台账五态）；非 file.* 返回 false */
  private async runFile(actionId: string, action: { type: string; input: unknown }): Promise<boolean> {
    if (!action.type.startsWith("file.")) return false;
    if (!this.deps.file) {
      this.sendResult(actionId, { status: "failed", error: `unsupported action type: ${action.type} (no file executor)` });
      return true;
    }
    const outcome = await this.deps.file.run(action.type, action.input as Record<string, unknown>, { actionId });
    this.sendFileOutcome(actionId, outcome);
    return true;
  }

  /** action.cancel（协议 v2，S→C）：只 abort 指定动作的在途进程组——
   *  不直接宣称成功，最终状态只信随后到来的 action.result（五态纪律）。
   *  动作未知/已完成 → no-op + 日志（cancel 与 result 竞态是合法时序）。 */
  handleActionCancel(data: { actionId: string }): void {
    if (!this.deps.shell) {
      this.deps.log?.("action.cancel ignored (no shell executor)", { actionId: data.actionId });
      return;
    }
    const cancelled = this.deps.shell.cancel(data.actionId);
    this.deps.log?.("action.cancel handled", { actionId: data.actionId, cancelled });
  }

  /** shell 结局 → action.result 载荷（v2：errorCode + 失败时 result 带 spill 诊断路径） */
  private sendShellOutcome(actionId: string, outcome: ShellRunOutcome): void {
    if (outcome.status === "succeeded") {
      this.deps.send({ actionId, status: "succeeded", result: outcome.result });
      return;
    }
    this.deps.send({
      actionId,
      status: outcome.status,
      error: outcome.error,
      errorCode: outcome.errorCode,
      ...(outcome.spillPath !== undefined ? { result: { spillPath: outcome.spillPath } } : {}),
    });
  }

  /** 文件结局 → action.result 载荷（v2：errorCode 透传 FileError code；errorPath 随 result.path 回传） */
  private sendFileOutcome(actionId: string, outcome: FileActionOutcome): void {
    if (outcome.status === "succeeded") {
      this.deps.send({ actionId, status: "succeeded", result: outcome.result ?? null });
      return;
    }
    this.deps.send({
      actionId,
      status: outcome.status,
      error: outcome.error,
      errorCode: outcome.errorCode,
      ...(outcome.errorPath !== undefined ? { result: { path: outcome.errorPath } } : {}),
    });
  }

  private sendResult(
    actionId: string,
    verdict: { status: "succeeded"; result?: unknown } | { status: "failed"; error: string },
  ): void {
    this.deps.send({
      actionId,
      status: verdict.status,
      ...(verdict.status === "succeeded"
        ? { result: verdict.result === undefined ? null : verdict.result }
        : { error: verdict.error }),
    });
  }

  /** 台账 resultSummary 是 JSON 字符串（write {bytes}/delete {deleted}）；解析失败回 null */
  private parseSummary(summary: string | null): unknown {
    if (!summary) return null;
    try {
      return JSON.parse(summary) as unknown;
    } catch {
      return null;
    }
  }
}

/** 活体 result 为 null（void 类）的动作 kind——快路径幂等回执不回 resultSummary（与活体语义一致） */
const VOID_RESULT_KINDS = new Set<string>([
  "workspace.write",
  "file.write", "file.append", "file.truncate", "file.rename", "file.remove", "file.mkdir",
]);
