import {
  LOCAL_EXECUTION_MACHINE_ID,
  type ExecutionAction,
  type ExecutionActionResult,
  type ExecutionActionType,
  type ExecutionMachine,
  type ExecutionMachineRouter,
} from "@usecases/ports/execution-machine";

/** The single target-resolution entry for OS/workspace actions. */
export class ExecutionMachineRegistry implements ExecutionMachineRouter {
  private readonly machines = new Map<string, ExecutionMachine>();

  constructor(private readonly defaultMachineId = LOCAL_EXECUTION_MACHINE_ID) {}

  register(machine: ExecutionMachine): void {
    if (this.machines.has(machine.id)) {
      throw new Error(`Execution machine already registered: ${machine.id}`);
    }
    this.machines.set(machine.id, machine);
  }

  resolve(targetMachineId?: string): ExecutionMachine {
    const id = targetMachineId ?? this.defaultMachineId;
    const machine = this.machines.get(id);
    if (!machine) {
      throw new Error(`Execution machine not registered: ${id}`);
    }
    return machine;
  }

  /** 注册中心投影：当前有哪些机器（Web「当前执行机」与 LLM 感知的只读数据源，唯一事实源仍在本表）。 */
  list(): Array<{ id: string; name: string }> {
    return [...this.machines.values()].map((m) => ({ id: m.id, name: m.name ?? m.id }));
  }

  /** 当前默认执行机 id（未显式指定目标时的落点；阶段 2 恒为 local）。 */
  currentMachineId(): string {
    return this.defaultMachineId;
  }

  async run<K extends ExecutionActionType>(
    action: ExecutionAction<K>,
    targetMachineId?: string,
  ): Promise<ExecutionActionResult<K>> {
    return this.resolve(targetMachineId).run(action);
  }
}
