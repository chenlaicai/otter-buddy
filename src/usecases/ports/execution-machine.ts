import type { ExecutionEnv, FileInfo, LineScan, ShellOutputInfo, TextLine } from "@earendil-works/pi-durable/env";
import type {
  FileDirReaderNextInput,
  FileHandleInput,
  FileJoinPathInput,
  FileMkdirInput,
  FileOpenReaderInput,
  FilePathInput,
  FileReadLinesInput,
  FileReaderReadInput,
  FileReaderScanInput,
  FileRemoveInput,
  FileRenameInput,
  FileTempDirInput,
  FileTempFileInput,
  FileTruncateInput,
  FileWriteInput,
  ShellExecActionInput,
  ShellExecActionResult,
} from "@entities/execution/connector-protocol";

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
  // ── 文件动作族（协议 v2；FileError 经 errorCode 透传） ──
  "file.read": { input: FilePathInput; result: string };
  "file.readLines": { input: FileReadLinesInput; result: string[] };
  "file.readBinary": { input: FilePathInput; result: string }; // base64
  "file.write": { input: FileWriteInput; result: void };
  "file.append": { input: FileWriteInput; result: void };
  "file.truncate": { input: FileTruncateInput; result: void };
  "file.rename": { input: FileRenameInput; result: void };
  "file.remove": { input: FileRemoveInput; result: void };
  "file.mkdir": { input: FileMkdirInput; result: void };
  "file.stat": { input: FilePathInput; result: FileInfo };
  "file.list": { input: FilePathInput; result: FileInfo[] };
  "file.exists": { input: FilePathInput; result: boolean };
  "file.canonicalPath": { input: FilePathInput; result: string };
  "file.absolutePath": { input: FilePathInput; result: string };
  "file.joinPath": { input: FileJoinPathInput; result: string };
  "file.createTempDir": { input: FileTempDirInput; result: string };
  "file.createTempFile": { input: FileTempFileInput; result: string };
  "file.flush": { input: FilePathInput; result: void };
  // ── 读器句柄资源协议（协议 v2；句柄是 connector 进程内资源） ──
  "file.openReader": { input: FileOpenReaderInput; result: { handle: string; info: FileInfo } };
  "file.readerRead": { input: FileReaderReadInput; result: string }; // base64
  "file.readerScanLines": { input: FileReaderScanInput; result: LineScan };
  "file.readerInfo": { input: FileHandleInput; result: FileInfo };
  "file.openDirReader": { input: FilePathInput; result: { handle: string } };
  "file.dirReaderNext": { input: FileDirReaderNextInput; result: { entries: FileInfo[]; done: boolean } };
  "file.openLineReader": { input: FilePathInput; result: { handle: string } };
  "file.lineReaderRead": { input: FileHandleInput; result: TextLine | null };
  "file.resourceClose": { input: FileHandleInput; result: void };
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
}

/** Composition-root injection port: action execution plus explicit target resolution. */
export interface ExecutionMachineRouter extends ActionRunner, ExecutionMachineResolver {}

/** 执行机池快照条目（感知层投影——统一注册制：全部条目均为 connector 注册设备，
 *  在线状态由 connectorRegistry 投影；无内置特权机） */
export interface ExecutionMachinePoolEntry {
  id: string;
  name: string;
  online: boolean;
  /** 设备最近在线时间（ISO） */
  lastSeenAt: string | null;
}

/** 执行机资源池快照（/api/execution-machines 与 list_execution_machines 工具共用同一投影） */
export interface ExecutionMachinePoolSnapshot {
  machines: ExecutionMachinePoolEntry[];
}
