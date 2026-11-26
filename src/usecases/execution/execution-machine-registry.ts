import type {
  ActionRunOptions,
  ExecutionAction,
  ExecutionActionResult,
  ExecutionActionType,
  ExecutionMachine,
  ExecutionMachineRouter,
} from "@usecases/ports/execution-machine";

/** The single target-resolution entry for OS/workspace actions. */
export class ExecutionMachineRegistry implements ExecutionMachineRouter {
  private readonly machines = new Map<string, ExecutionMachine>();

  register(machine: ExecutionMachine): void {
    if (this.machines.has(machine.id)) {
      throw new Error(`Execution machine already registered: ${machine.id}`);
    }
    this.machines.set(machine.id, machine);
  }

  /** 注销机器（总闸撤栅栏的内存投影侧）。
   *  幂等——未注册的 id 静默（下线幂等语义；库表才是唯一事实源，本表只是缓存）。 */
  unregister(machineId: string): void {
    this.machines.delete(machineId);
  }

  /** 重复注册顶替语义——同 id 后到者顶替前者（设备重新上线场景：
   *  旧投影先注销再注册新投影）。等价 unregister + register，原子化避免窗口。 */
  replace(machine: ExecutionMachine): void {
    this.machines.set(machine.id, machine);
  }

  /** 目标解析：机器未注册即抛错（fail-closed——统一注册制下无内置默认机，
   *  未显式指定目标的调用方属漏网路径，吵着失败而非猜一个落点）。 */
  resolve(targetMachineId?: string): ExecutionMachine {
    if (!targetMachineId) {
      throw new Error("execution machine not specified: pool has no default machine (uniform registration; callers must name the target explicitly)");
    }
    const machine = this.machines.get(targetMachineId);
    if (!machine) {
      throw new Error(`Execution machine not registered: ${targetMachineId}`);
    }
    return machine;
  }

  /** 注册中心投影：当前有哪些机器（Web 与 LLM 感知的只读数据源，唯一事实源仍在本表）。 */
  list(): Array<{ id: string; name: string }> {
    return [...this.machines.values()].map((m) => ({ id: m.id, name: m.name ?? m.id }));
  }

  async run<K extends ExecutionActionType>(
    action: ExecutionAction<K>,
    targetMachineId?: string,
    options?: ActionRunOptions,
  ): Promise<ExecutionActionResult<K>> {
    return this.resolve(targetMachineId).run(action, undefined, options);
  }
}
