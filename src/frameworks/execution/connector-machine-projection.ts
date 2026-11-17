import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import type {
  ActionRunOptions,
  ExecutionAction,
  ExecutionActionResult,
  ExecutionActionType,
  ExecutionMachine,
} from "@usecases/ports/execution-machine";

/**
 * F20261117cnnct（#1868 阶段 4 C1）：connector 设备的 Registry 占位投影。
 * C1 只承载通道与会话——设备上线时注册本投影（Registry list 可见），执行通道
 * （action.request 下发/回执/台账）随 C2 换成真 RemoteExecutionMachine。
 * run/createExecutionEnvironment 一律抛「C2 落地」——当前无调用方可达（工具路由
 * 尚未开放远程目标），防误用显式报错优于静默假实现。
 */
export class ConnectorMachineProjection implements ExecutionMachine {
  constructor(
    readonly id: string,
    readonly name?: string,
  ) {}

  createExecutionEnvironment(): ExecutionEnv {
    throw new Error(`connector execution channel lands in stage-4 C2 (device: ${this.id})`);
  }

  async run<K extends ExecutionActionType>(
    _action: ExecutionAction<K>,
    _targetMachineId?: string,
    _options?: ActionRunOptions,
  ): Promise<ExecutionActionResult<K>> {
    throw new Error(`connector execution channel lands in stage-4 C2 (device: ${this.id})`);
  }
}
