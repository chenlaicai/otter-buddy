import { tmpdir } from "node:os";
import { LocalExecutionMachine } from "@frameworks/execution/local-execution-machine";
import { NodeWorkspaceGateway } from "@frameworks/file-system/node-workspace-gateway";
import { ExecutionMachineRegistry } from "@usecases/execution/execution-machine-registry";

export function createTestExecutionMachineRegistry(dataDir = tmpdir()): ExecutionMachineRegistry {
  const registry = new ExecutionMachineRegistry();
  registry.register(new LocalExecutionMachine(new NodeWorkspaceGateway(dataDir)));
  return registry;
}
