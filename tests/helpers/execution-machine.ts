import { tmpdir } from "node:os";
import { LocalExecutionMachine } from "@frameworks/execution/local-execution-machine";
import { NodeWorkspaceGateway } from "@frameworks/file-system/node-workspace-gateway";
import { ExecutionMachineRegistry } from "@usecases/execution/execution-machine-registry";
import type { ActionLedger } from "@usecases/ports/action-ledger";

export function createTestExecutionMachineRegistry(dataDir = tmpdir(), ledger: ActionLedger | null = null): ExecutionMachineRegistry {
  const registry = new ExecutionMachineRegistry();
  registry.register(new LocalExecutionMachine(new NodeWorkspaceGateway(dataDir), ledger));
  return registry;
}
