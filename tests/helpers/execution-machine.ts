import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { ExecutionMachineRegistry } from "@usecases/execution/execution-machine-registry";
import { WorkspaceActionExecutor } from "@frameworks/execution/workspace-action-executor";
import { NodeWorkspaceGateway } from "@frameworks/file-system/node-workspace-gateway";
import type { ActionRunOptions, ExecutionAction, ExecutionActionResult, ExecutionActionType, ExecutionMachine } from "@usecases/ports/execution-machine";

/**
 * 内联 node 测试机器（统一注册制后替代已删除的内置 local 的测试角色）：
 * 真跑文件/bash 面（NodeExecutionEnv），不经 connector 通道——SDK 工具链与
 * 执行机壳的集成测试用。
 */
export function inlineNodeMachine(id = "test-node"): ExecutionMachine {
  return {
    id,
    name: id,
    createExecutionEnvironment: (cwd: string) => new NodeExecutionEnv({ cwd }),
    run: async () => { throw new Error("inline test machine is env-only (tools drive env directly)"); },
  };
}

/** executor 测试机器：run 委托 WorkspaceActionExecutor（与 connector 设备侧
 *  执行栈同构）——workspace 六动作工具走 ActionRunner 的测试用。 */
export function executorNodeMachine(id: string, workspaceRoot: string): ExecutionMachine {
  const executor = new WorkspaceActionExecutor(new NodeWorkspaceGateway(workspaceRoot));
  return {
    id,
    name: id,
    createExecutionEnvironment: () => { throw new Error("env face not under test here"); },
    async run<K extends ExecutionActionType>(
      action: ExecutionAction<K>,
      _target?: string,
      options?: ActionRunOptions,
    ): Promise<ExecutionActionResult<K>> {
      return executor.run(action, options) as Promise<ExecutionActionResult<K>>;
    },
  };
}

/** 测试 Registry：显式传机器注册（统一注册制——Registry 无默认机）。 */
export function createTestExecutionMachineRegistry(...machines: ExecutionMachine[]): ExecutionMachineRegistry {
  const registry = new ExecutionMachineRegistry();
  for (const machine of machines) registry.register(machine);
  return registry;
}
