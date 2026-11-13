import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import {
  LOCAL_EXECUTION_MACHINE_ID,
  type ExecutionAction,
  type AnyExecutionAction,
  type ExecutionActionResult,
  type ExecutionActionType,
  type ExecutionMachine,
} from "@usecases/ports/execution-machine";
import type { WorkspaceGateway } from "@usecases/ports/workspace-gateway";

/** Built-in machine: reuse the existing Node implementations, with no second OS path. */
export class LocalExecutionMachine implements ExecutionMachine {
  readonly id = LOCAL_EXECUTION_MACHINE_ID;
  /** Web 当前执行机投影展示名（阶段 2） */
  readonly name = "本机";

  constructor(private readonly workspaceGateway: WorkspaceGateway) {}

  createExecutionEnvironment(cwd: string): ExecutionEnv {
    return new NodeExecutionEnv({ cwd });
  }

  run<K extends ExecutionActionType>(action: ExecutionAction<K>): Promise<ExecutionActionResult<K>> {
    return this.runWorkspaceAction(action as AnyExecutionAction) as Promise<ExecutionActionResult<K>>;
  }

  private async runWorkspaceAction(action: AnyExecutionAction): Promise<unknown> {
    switch (action.type) {
      case "workspace.exists":
        return this.workspaceGateway.exists(action.input.conversationId);
      case "workspace.list":
        return this.workspaceGateway.listDir(action.input.conversationId, action.input.relativePath);
      case "workspace.read":
        return this.workspaceGateway.readFile(action.input.conversationId, action.input.relativePath);
      case "workspace.write":
        return this.workspaceGateway.writeFile(action.input.conversationId, action.input.relativePath, action.input.content);
      case "workspace.delete":
        return this.workspaceGateway.deletePath(action.input.conversationId, action.input.relativePath, {
          recursive: action.input.recursive,
        });
      case "workspace.path":
        return this.workspaceGateway.getWorkspacePath(action.input.conversationId);
      default: {
        const unhandled: never = action;
        throw new Error(`Unsupported local execution action: ${JSON.stringify(unhandled)}`);
      }
    }
  }
}
