import type { ExecutionEnv } from "@earendil-works/pi-durable/env";

export const LOCAL_EXECUTION_MACHINE_ID = "local";

export interface ExecutionActionMap {
  "workspace.exists": {
    input: { conversationId: string };
    result: boolean;
  };
  "workspace.list": {
    input: { conversationId: string; relativePath?: string };
    result: Array<{ name: string; isDirectory: boolean; isFile: boolean }>;
  };
  "workspace.read": {
    input: { conversationId: string; relativePath: string };
    result: string;
  };
  "workspace.write": {
    input: { conversationId: string; relativePath: string; content: string };
    result: void;
  };
  "workspace.delete": {
    input: { conversationId: string; relativePath: string; recursive?: boolean };
    result: { deleted: "file" | "directory" };
  };
  "workspace.path": {
    input: { conversationId: string };
    result: string;
  };
}

export type ExecutionActionType = keyof ExecutionActionMap;
export type ExecutionActionResult<K extends ExecutionActionType> = ExecutionActionMap[K]["result"];

export interface ExecutionAction<K extends ExecutionActionType> {
  type: K;
  input: ExecutionActionMap[K]["input"];
}

export type AnyExecutionAction = {
  [T in ExecutionActionType]: ExecutionAction<T>;
}[ExecutionActionType];

/** A typed OS/workspace action. Central-domain tools never enter this boundary. */
export interface ActionRunner {
  run<K extends ExecutionActionType>(
    action: ExecutionAction<K>,
    targetMachineId?: string,
  ): Promise<ExecutionActionResult<K>>;
}

export interface ExecutionMachine extends ActionRunner {
  readonly id: string;
  createExecutionEnvironment(cwd: string): ExecutionEnv;
}

export interface ExecutionMachineResolver {
  resolve(targetMachineId?: string): ExecutionMachine;
}
