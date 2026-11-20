import path from "node:path";
import type { Context } from "@earendil-works/chord/context";
import {
  err,
  ok,
  ExecutionError,
  FileError,
  type ExecutionEnv,
  type ExecutionErrorCode,
  type ListFilesOptions,
  type Result,
  type ShellExecOptions,
  type ShellExecResult,
  type WatchTarget,
  type FileChange,
} from "@earendil-works/pi-durable/env";
import { otterInvokeStorage } from "@entities/execution/otter-invoke-context";
import type { ShellExecActionInput } from "@entities/execution/connector-protocol";
import { RemoteActionError, type RemoteExecutionMachine } from "./remote-execution-machine";

const DEFAULT_SHELL_WAIT_MS = 10 * 60 * 1000;
const SHELL_COMPLETION_GRACE_MS = 5_000;
const EXECUTION_ERROR_CODES = new Set<ExecutionErrorCode>([
  "aborted", "timeout", "shell_unavailable", "spawn_error", "callback_error", "unknown",
]);

function shellWaitMs(timeout: number | undefined): number {
  if (timeout === undefined) return DEFAULT_SHELL_WAIT_MS;
  return Math.max(30_000, timeout * 1000 + SHELL_COMPLETION_GRACE_MS);
}

function forwardOutput(options: ShellExecOptions, context: Context) {
  const callback = options.onOutput;
  if (!callback) return undefined;
  return (text: string, info: Parameters<NonNullable<ShellExecOptions["onOutput"]>>[2]) => callback(text, context, info);
}

/**
 * 远程 SDK 执行环境的 shell 切片。文件能力显式不支持，绝不静默落 hub。
 * cwd 以对话工作区为跨机锚：hub 工作区内路径映射为设备工作区相对后缀；
 * 设备绝对路径保留给显式设备侧调用。
 */
export class RemoteExecutionEnv implements ExecutionEnv {
  readonly id: string;
  private readonly controllers = new Set<AbortController>();

  constructor(
    private readonly machine: RemoteExecutionMachine,
    public cwd: string,
    private readonly conversationId: string,
  ) {
    this.id = `remote:${machine.id}`;
  }

  async exec(
    command: string | readonly string[],
    options: ShellExecOptions | undefined,
    context: Context,
  ): Promise<Result<ShellExecResult, ExecutionError>> {
    if (context.abortSignal?.aborted) return err(new ExecutionError("aborted", "aborted before remote exec"));
    const opts = options ?? {};
    try {
      const deviceWorkspace = await this.machine.run({
        type: "workspace.path",
        input: { conversationId: this.conversationId },
      });
      const controller = new AbortController();
      const abort = () => controller.abort();
      context.abortSignal?.addEventListener("abort", abort, { once: true });
      this.controllers.add(controller);
      try {
        const value = await this.machine.run({
          type: "shell.exec",
          input: this.shellInput(command, opts, deviceWorkspace),
        }, undefined, {
          timeoutMs: shellWaitMs(opts.timeout),
          abortSignal: controller.signal,
          onOutput: forwardOutput(opts, context),
        });
        return ok(value);
      } finally {
        context.abortSignal?.removeEventListener("abort", abort);
        this.controllers.delete(controller);
      }
    } catch (error) {
      return err(this.toExecutionError(error));
    }
  }

  private shellInput(
    command: string | readonly string[],
    options: ShellExecOptions,
    deviceWorkspace: string,
  ): ShellExecActionInput {
    const optional = Object.fromEntries(Object.entries({
      env: options.env,
      inheritEnv: options.inheritEnv,
      timeout: options.timeout,
      spill: options.spill,
      window: options.window,
    }).filter(([, value]) => value !== undefined));
    return {
      conversationId: this.conversationId,
      command: typeof command === "string" ? command : [...command],
      cwd: this.deviceCwd(options.cwd, deviceWorkspace),
      invokeId: otterInvokeStorage.getStore()?.currentInvokeId,
      ...optional,
    } as ShellExecActionInput;
  }

  async cleanup(_context: Context): Promise<void> {
    for (const controller of this.controllers) controller.abort();
  }

  private deviceCwd(requested: string | undefined, deviceWorkspace: string): string {
    if (requested === undefined || requested === this.cwd) return deviceWorkspace;
    if (!path.isAbsolute(requested)) return path.resolve(deviceWorkspace, requested);
    const relative = path.relative(this.cwd, requested);
    if (relative === "") return deviceWorkspace;
    if (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative)) {
      return path.resolve(deviceWorkspace, relative);
    }
    return requested;
  }

  private toExecutionError(error: unknown): ExecutionError {
    if (error instanceof RemoteActionError) {
      const code = EXECUTION_ERROR_CODES.has(error.errorCode as ExecutionErrorCode)
        ? error.errorCode as ExecutionErrorCode
        : "unknown";
      const executionError = new ExecutionError(code, error.message);
      const spillPath = (error.result as { spillPath?: unknown } | undefined)?.spillPath;
      if (typeof spillPath === "string") executionError.spillPath = spillPath;
      return executionError;
    }
    const message = error instanceof Error ? error.message : String(error);
    return new ExecutionError(message.includes("aborted before send") ? "aborted" : "unknown", message);
  }

  private unsupported<T>(target?: string): Promise<Result<T, FileError>> {
    return Promise.resolve(err(new FileError("not_supported", "remote file capability is not implemented in this slice", target)));
  }

  absolutePath(target: string, _context: Context) { return this.unsupported<string>(target); }
  joinPath(_parts: string[], _context: Context) { return this.unsupported<string>(); }
  readTextFile(target: string, _context: Context) { return this.unsupported<string>(target); }
  openTextLineReader(target: string, _context: Context) { return this.unsupported<never>(target); }
  readTextLines(target: string, _options: { maxLines?: number } | undefined, _context: Context) { return this.unsupported<string[]>(target); }
  readBinaryFile(target: string, _context: Context) { return this.unsupported<Uint8Array>(target); }
  openBinaryReader(target: string, _options: { noFollow?: boolean } | undefined, _context: Context) { return this.unsupported<never>(target); }
  writeFile(target: string, _content: string | Uint8Array, _context: Context) { return this.unsupported<void>(target); }
  appendFile(target: string, _content: string | Uint8Array, _context: Context) { return this.unsupported<void>(target); }
  truncateFile(target: string, _size: number, _context: Context) { return this.unsupported<void>(target); }
  flushFile(target: string, _context: Context) { return this.unsupported<void>(target); }
  renameFile(source: string, _destination: string, _context: Context) { return this.unsupported<void>(source); }
  fileInfo(target: string, _context: Context) { return this.unsupported<never>(target); }
  listDir(target: string, _context: Context) { return this.unsupported<never>(target); }
  listFiles(target: string, _options: ListFilesOptions | undefined, _context: Context) { return this.unsupported<never>(target); }
  openDirReader(target: string, _context: Context) { return this.unsupported<never>(target); }
  watch(_targets: readonly WatchTarget[], _onChange: (change: FileChange) => void, _context: Context) { return this.unsupported<never>(); }
  canonicalPath(target: string, _context: Context) { return this.unsupported<string>(target); }
  exists(target: string, _context: Context) { return this.unsupported<boolean>(target); }
  createDir(target: string, _options: { recursive?: boolean } | undefined, _context: Context) { return this.unsupported<void>(target); }
  remove(target: string, _options: { recursive?: boolean; force?: boolean } | undefined, _context: Context) { return this.unsupported<void>(target); }
  createTempDir(_prefix: string | undefined, _context: Context) { return this.unsupported<string>(); }
  createTempFile(_options: { prefix?: string; suffix?: string } | undefined, _context: Context) { return this.unsupported<string>(); }
}
