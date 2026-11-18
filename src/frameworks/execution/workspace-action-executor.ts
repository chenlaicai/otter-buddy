import path from "node:path";
import {
  type ActionRunOptions,
  type AnyExecutionAction,
  type ExecutionAction,
  type ExecutionActionResult,
  type ExecutionActionType,
} from "@usecases/ports/execution-machine";
import type { WorkspaceGateway } from "@usecases/ports/workspace-gateway";
import type { ActionLedger } from "@usecases/ports/action-ledger";
import type { ActionKind } from "@entities/execution/action-record";
import { otterInvokeStorage } from "@entities/execution/otter-invoke-context";
import { sha256 } from "./ledger/sqlite-action-ledger";

/**
 * F20261118remex（#1868 阶段 4 C2）：workspace 六动作执行器——自 LocalExecutionMachine
 * 抽出的公共实现（中枢 local 与 connector 远程共用同一执行语义与台账记账协议）。
 * 纯重构平移（B1 已把闭包障碍扫清：本模块依赖仅 node 内置 + usecases 端口 + entities +
 * ledger hash）。ledger=null 时等价裸执行（记账降级关闭）。
 */
export class WorkspaceActionExecutor {
  /** 只读访问器（LocalExecutionMachine 的 Env 工厂/纪元读取用） */
  get ledgerRef(): ActionLedger | null { return this.ledger; }
  get warnRef(): ((message: string, meta?: Record<string, unknown>) => void) | undefined { return this.warn; }
  get machineBootEpoch(): number {
    return (this.ledger as { bootEpoch?: number } | null)?.bootEpoch ?? 0;
  }

  constructor(
    private readonly workspaceGateway: WorkspaceGateway,
    /** F20261116actlg：本机动作台账（null = 记录降级关闭，动作照常执行） */
    private readonly ledger: ActionLedger | null = null,
    private readonly warn?: (message: string, meta?: Record<string, unknown>) => void,
  ) {}

  /** MAJOR-1：自铸 actionId 的 boot 纪元（台账侧读取；无台账时 0 无所谓） */
  private get bootEpoch(): number {
    const ledger = this.ledger as { bootEpoch?: number } | null;
    return ledger?.bootEpoch ?? 0;
  }

  /** 执行单个 workspace 动作（机器无关——target 路由归 Registry/机器层） */
  async run<K extends ExecutionActionType>(
    action: ExecutionAction<K>,
    options?: ActionRunOptions,
  ): Promise<ExecutionActionResult<K>> {
    return this.runWorkspaceAction(action as AnyExecutionAction, options) as Promise<ExecutionActionResult<K>>;
  }

  private async runWorkspaceAction(action: AnyExecutionAction, options?: ActionRunOptions): Promise<unknown> {
    switch (action.type) {
      case "workspace.exists":
        return this.workspaceGateway.exists(action.input.conversationId);
      case "workspace.list":
        return this.workspaceGateway.listDir(action.input.conversationId, action.input.relativePath);
      case "workspace.read":
        return this.workspaceGateway.readFile(action.input.conversationId, action.input.relativePath);
      case "workspace.write":
        return this.recordedWorkspaceWrite(action.input.conversationId, action.input.relativePath, action.input.content, options);
      case "workspace.delete":
        return this.recordedWorkspaceDelete(action.input.conversationId, action.input.relativePath, action.input.recursive, options);
      case "workspace.path":
        return this.workspaceGateway.getWorkspacePath(action.input.conversationId);
      default: {
        const unhandled: never = action;
        throw new Error(`Unsupported local execution action: ${JSON.stringify(unhandled)}`);
      }
    }
  }

  /** F20261116actlg：workspace 动作的绝对 target（MAJOR 修复：清扫 hash 核对需要可解析的
   *  真实路径——相对逻辑路径会让 verifyHashOnDisk 拿它对进程 CWD 做 realpath，全线误判）。
   *  解析失败时回退逻辑展示路径（记账仍完整，hash 核对降级为 interrupted——诚实但可用）。 */
  private async workspaceAbsoluteTarget(conversationId: string, relativePath: string): Promise<string> {
    try {
      const root = await this.workspaceGateway.getWorkspacePath(conversationId);
      return path.join(root, relativePath);
    } catch {
      return `${conversationId}/${relativePath}`;
    }
  }

  /** F20261116actlg：workspace 写入入账（content hash 先记后写——崩溃后 hash 核对的基础）。 */
  private async recordedWorkspaceWrite(conversationId: string, relativePath: string, content: string, options?: ActionRunOptions): Promise<void> {
    if (!this.ledger) {
      await this.workspaceGateway.writeFile(conversationId, relativePath, content);
      return;
    }
    const started = await this.startWorkspaceAction({
      kind: "workspace.write",
      conversationId,
      target: await this.workspaceAbsoluteTarget(conversationId, relativePath),
      content,
      actionId: options?.actionId,
    });
    if (started?.deduped) return;
    try {
      await this.workspaceGateway.writeFile(conversationId, relativePath, content);
      await this.settleWorkspaceAction(started, { status: "succeeded", resultSummary: { bytes: Buffer.byteLength(content, "utf-8") } });
    } catch (error) {
      await this.settleWorkspaceAction(started, { status: "failed", error: String(error) });
      throw error;
    }
  }

  /** F20261116actlg：workspace 删除入账（幂等可重做类）。 */
  private async recordedWorkspaceDelete(
    conversationId: string,
    relativePath: string,
    recursive: boolean | undefined,
    options?: ActionRunOptions,
  ): Promise<{ deleted: "file" | "directory" }> {
    if (!this.ledger) {
      return this.workspaceGateway.deletePath(conversationId, relativePath, { recursive });
    }
    const started = await this.startWorkspaceAction({
      kind: "workspace.delete",
      conversationId,
      target: await this.workspaceAbsoluteTarget(conversationId, relativePath),
      actionId: options?.actionId,
    });
    if (started?.deduped) {
      const summary = started.record.resultSummary ? (JSON.parse(started.record.resultSummary) as { deleted?: "file" | "directory" }) : {};
      return { deleted: summary.deleted ?? "file" };
    }
    try {
      const result = await this.workspaceGateway.deletePath(conversationId, relativePath, { recursive });
      await this.settleWorkspaceAction(started, { status: "succeeded", resultSummary: { deleted: result.deleted } });
      return result;
    } catch (error) {
      await this.settleWorkspaceAction(started, { status: "failed", error: String(error) });
      throw error;
    }
  }

  private async startWorkspaceAction(input: {
    kind: ActionKind;
    conversationId: string;
    target: string;
    content?: string;
    actionId?: string;
  }): Promise<{ record: { actionId: string; resultSummary: string | null }; deduped: boolean } | null> {
    try {
      const attribution = this.currentAttribution();
      const seq = this.nextWorkspaceSeq();
      const store = otterInvokeStorage.getStore();
      return await this.ledger!.start({
        actionId: input.actionId ?? `${attribution}:ws:${this.bootEpoch}:${seq}`,
        invokeId: store?.currentInvokeId ?? null,
        conversationId: input.conversationId,
        toolCallId: store?.currentToolCallId ?? null,
        source: "workspace",
        kind: input.kind,
        target: input.target,
        contentHash: input.content !== undefined ? sha256(Buffer.from(input.content, "utf-8")) : null,
        contentBytes: input.content !== undefined ? Buffer.byteLength(input.content, "utf-8") : null,
      });
    } catch (error) {
      this.warn?.("action ledger record failed (non-fatal)", { kind: input.kind, error: String(error) });
      return null;
    }
  }

  private currentAttribution(): string {
    const store = otterInvokeStorage.getStore();
    return store?.currentToolCallId ?? store?.currentInvokeId ?? "internal";
  }

  /** 单调全局序（dspro minor：不再按 attribution 分桶，防长跑无界增长） */
  private wsOpSeq = 0;

  private nextWorkspaceSeq(): number {
    this.wsOpSeq += 1;
    return this.wsOpSeq;
  }

  private async settleWorkspaceAction(
    started: { record: { actionId: string } } | null,
    verdict: Parameters<ActionLedger["settle"]>[1],
  ): Promise<void> {
    if (!started) return;
    try {
      await this.ledger!.settle(started.record.actionId, verdict);
    } catch (error) {
      this.warn?.("action ledger settle failed (non-fatal)", { actionId: started.record.actionId, error: String(error) });
    }
  }
}
