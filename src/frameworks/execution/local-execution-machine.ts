import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import {
  LOCAL_EXECUTION_MACHINE_ID,
  type ActionRunOptions,
  type ExecutionAction,
  type ExecutionActionResult,
  type ExecutionActionType,
  type ExecutionMachine,
} from "@usecases/ports/execution-machine";
import type { WorkspaceGateway } from "@usecases/ports/workspace-gateway";
import type { ActionLedger } from "@usecases/ports/action-ledger";
import { otterInvokeStorage } from "@entities/execution/otter-invoke-context";
import { WorkspaceActionExecutor } from "./workspace-action-executor";
import { RecordingNodeExecutionEnv } from "./recording-node-execution-env";

/**
 * Built-in machine: reuse the existing Node implementations, with no second OS path.
 * （阶段 4 C2）：六动作执行语义抽出 WorkspaceActionExecutor（与 connector
 * 远程共用），本类薄壳化为机器身份（id/name/Env 工厂）+ 委托执行。
 */
export class LocalExecutionMachine implements ExecutionMachine {
  readonly id = LOCAL_EXECUTION_MACHINE_ID;
  /** Web 当前执行机投影展示名（阶段 2） */
  readonly name = "本机";

  private readonly executor: WorkspaceActionExecutor;

  constructor(
    workspaceGateway: WorkspaceGateway,
    /** 本机动作台账（null = 记录降级关闭，动作照常执行） */
    ledger: ActionLedger | null = null,
    warn?: (message: string, meta?: Record<string, unknown>) => void,
  ) {
    // 归因注入（C2 闭包收口）：真实 invoke 上下文读取留在中枢 local 侧——
    // WorkspaceActionExecutor 本体零 agent/contract 依赖（connector 可复用）
    this.executor = new WorkspaceActionExecutor(workspaceGateway, ledger, warn, () => {
      const store = otterInvokeStorage.getStore();
      return store ? { invokeId: store.currentInvokeId ?? null, toolCallId: store.currentToolCallId ?? null } : undefined;
    });
  }

  /** MAJOR-1：自铸 actionId 的 boot 纪元（台账侧读取；无台账时 0 无所谓） */
  private get bootEpoch(): number {
    return this.executor.machineBootEpoch;
  }

  createExecutionEnvironment(cwd: string): ExecutionEnv {
    // SDK 文件/bash 面走记录 env（副作用入账 + 原子写）；
    // 只读操作直通。ledger=null 时 RecordingNodeExecutionEnv 等价裸 NodeExecutionEnv。
    // MAJOR-1：bootEpoch 传入 env——自铸 actionId 必含纪元，防跨 boot 同序号碰撞错误去重。
    return new RecordingNodeExecutionEnv({ cwd }, this.executor.ledgerRef, this.executor.warnRef, this.bootEpoch);
  }

  async run<K extends ExecutionActionType>(
    action: ExecutionAction<K>,
    _targetMachineId?: string,
    options?: ActionRunOptions,
  ): Promise<ExecutionActionResult<K>> {
    // targetMachineId 由 Registry 解析后调用，机器自身忽略（接口继承自 ActionRunner）
    return this.executor.run(action, options) as Promise<ExecutionActionResult<K>>;
  }
}
