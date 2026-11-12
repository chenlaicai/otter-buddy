import {
  LOCAL_EXECUTION_MACHINE_ID,
  type ActionRunner,
  type ExecutionAction,
  type ExecutionActionResult,
  type ExecutionActionType,
  type ExecutionMachine,
  type ExecutionMachineResolver,
} from "@usecases/ports/execution-machine";

/** The single target-resolution entry for OS/workspace actions. */
export class ExecutionMachineRegistry implements ActionRunner, ExecutionMachineResolver {
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

  async run<K extends ExecutionActionType>(
    action: ExecutionAction<K>,
    targetMachineId?: string,
  ): Promise<ExecutionActionResult<K>> {
    return this.resolve(targetMachineId).run(action);
  }
}
