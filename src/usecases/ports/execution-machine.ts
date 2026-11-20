import type { ExecutionEnv, ShellOutputInfo } from "@earendil-works/pi-durable/env";
import type { ShellExecActionInput, ShellExecActionResult } from "@entities/execution/connector-protocol";

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
  "shell.exec": {
    input: ShellExecActionInput;
    result: ShellExecActionResult;
  };
}

export type ExecutionActionType = keyof ExecutionActionMap;
export type ExecutionActionResult<K extends ExecutionActionType> = ExecutionActionMap[K]["result"];

export interface ExecutionAction<K extends ExecutionActionType> {
  type: K;
  input: ExecutionActionMap[K]["input"];
}

/** 动作去重协议位——调用方显式携带 actionId 时，同 id 已 succeeded
 * 的动作直接返回已记录结果不重复执行；connector 重投递时获得幂等语义。 */
export interface ActionRunOptions {
  actionId?: string;
  /** 长动作等待上限；缺省由执行机按动作类型决定。 */
  timeoutMs?: number;
  /** 调用方取消信号；远程动作转换为取消帧，最终状态仍由执行机回执决定。 */
  abortSignal?: AbortSignal;
  /** 流式输出回调（仅支持流式输出的动作使用）。 */
  onOutput?: (text: string, info: ShellOutputInfo) => void;
}

export type AnyExecutionAction = {
  [T in ExecutionActionType]: ExecutionAction<T>;
}[ExecutionActionType];

/** A typed OS/workspace action. Central-domain tools never enter this boundary. */
export interface ActionRunner {
  run<K extends ExecutionActionType>(
    action: ExecutionAction<K>,
    targetMachineId?: string,
    options?: ActionRunOptions,
  ): Promise<ExecutionActionResult<K>>;
}

export interface ExecutionMachine extends ActionRunner {
  readonly id: string;
  /** 人类可读展示名（Web 当前执行机投影用；缺省回退 id） */
  readonly name?: string;
  createExecutionEnvironment(cwd: string, conversationId?: string): ExecutionEnv;
}

export interface ExecutionMachineResolver {
  resolve(targetMachineId?: string): ExecutionMachine;
  /** 业务对话级异步解析；未实现的旧装配保持默认本机行为。 */
  resolveForConversation?(conversationId?: string): Promise<ExecutionMachine>;
}

/** Composition-root injection port: action execution plus explicit target resolution. */
export interface ExecutionMachineRouter extends ActionRunner, ExecutionMachineResolver {}
