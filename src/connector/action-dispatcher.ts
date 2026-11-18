/**
 * F20261118remex（#1868 阶段 4 C2）：connector 侧动作分发器——action.request →
 * 本地执行 → action.result 回执。
 *
 * 可测性：不持有 ws 对象（发帧经 sender 回调，sid/seq 由会话层闭包负责），
 * 执行经 WorkspaceActionExecutor（与中枢 local 机器同一执行语义与台账记账协议）。
 *
 * 幂等协议（方案 v3 §5）：先查本地台账——actionId 已 succeeded 直接回已记录结果
 * （不重执行）；未见过/其他状态照常执行（executor 内部台账 start 对真冲突行兜底
 * dedupe）。回执五态：succeeded/failed 为执行结论；unknown/interrupted 为收尾裁决
 * （本模块只在崩溃/下线路径产生——正常执行两态即可达）。
 *
 * 轻量铁律：依赖闭包仅 entities/execution + node 内置（构建后闭包断言把守）。
 */

import type { ConnectorFrame } from "@entities/execution/connector-protocol";
import type { ActionRecord } from "@entities/execution/action-record";
import type { AnyExecutionAction } from "@usecases/ports/execution-machine";

/** connector 侧六动作执行面（WorkspaceActionExecutor 的最小依赖切片——测试可 fake） */
export interface ActionExecutorLike {
  run(action: AnyExecutionAction, options?: { actionId?: string }): Promise<unknown>;
}

export interface ConnectorActionDispatcherDeps {
  executor: ActionExecutorLike;
  /** 本地台账只读面（幂等快路径） */
  ledger: { getByActionId(actionId: string): Promise<ActionRecord | null> };
  /** 回执发帧（会话层闭包封装完整帧：v/type/seq/sid——本层不管会话封装字段） */
  send: (data: Extract<ConnectorFrame, { type: "action.result" }>['data']) => void;
  log?: (message: string, meta?: Record<string, unknown>) => void;
}

/** 协议 v1 放行的动作白名单（非白名单 type 回 failed——协议 v1 只放六动作，方案 §9） */
const SUPPORTED_ACTION_TYPES = new Set<string>([
  "workspace.exists",
  "workspace.list",
  "workspace.read",
  "workspace.write",
  "workspace.delete",
  "workspace.path",
]);

export class ConnectorActionDispatcher {
  /** 在途执行计数（C3：SIGTERM 优雅退出窗——有在途时等其入账再退） */
  private inflight = 0;
  get inflightCount(): number { return this.inflight; }

  constructor(private readonly deps: ConnectorActionDispatcherDeps) {}

  /** 处理一帧 action.request（sid 已由会话层校验过——本层只管执行与回执） */
  async handleActionRequest(frame: Extract<ConnectorFrame, { type: "action.request" }>): Promise<void> {
    const { actionId, action } = frame.data;

    if (!SUPPORTED_ACTION_TYPES.has(action.type)) {
      this.sendResult(actionId, { status: "failed", error: `unsupported action type: ${String(action.type)}` });
      return;
    }

    // 幂等快路径：actionId 已 succeeded → 直接回已记录结果，不重执行（方案 §5）
    try {
      const existing = await this.deps.ledger.getByActionId(actionId);
      if (existing?.status === "succeeded") {
        this.deps.log?.("action deduped (already succeeded)", { actionId, type: action.type });
        // m5（检视）：回执以活体语义为准——workspace.write 活体 result 为 null（void 类），
        //  快路径不回 resultSummary（{bytes} 与活体不一致）；delete 的 {deleted} 与活体一致可透传
        this.sendResult(actionId, { status: "succeeded", result: existing.kind === "workspace.write" ? null : this.parseSummary(existing.resultSummary) });
        return;
      }
    } catch (err) {
      // 台账读失败 → 降级走执行（记账降级语义：台账缺席时动作照常执行）
      this.deps.log?.("action ledger lookup failed (degraded to execute)", { actionId, error: String(err) });
    }

    try {
      this.inflight += 1;
      const result = await this.deps.executor.run(
        { type: action.type, input: action.input } as AnyExecutionAction,
        { actionId },
      );
      this.sendResult(actionId, { status: "succeeded", result });
    } catch (err) {
      // executor 内部已 settle failed（台账在场时）；此处只负责回执
      this.sendResult(actionId, { status: "failed", error: err instanceof Error ? err.message : String(err) });
    } finally {
      this.inflight -= 1;
    }
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
