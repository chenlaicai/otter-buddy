import path from "node:path";
import type { Context } from "@earendil-works/chord/context";
import {
  err,
  ok,
  ExecutionError,
  FileError,
  type BinaryReader,
  type DirReader,
  type ExecutionEnv,
  type ExecutionErrorCode,
  type FileChange,
  type FileInfo,
  type ListFilesOptions,
  type Result,
  type ShellExecOptions,
  type ShellExecResult,
  type TextLineReader,
  type WatchTarget,
} from "@earendil-works/pi-durable/env";
import { otterInvokeStorage } from "@entities/execution/otter-invoke-context";
import type {
  FileJoinPathInput,
  FileMkdirInput,
  FileOpenReaderInput,
  FilePathInput,
  FileReadLinesInput,
  FileRemoveInput,
  FileRenameInput,
  FileTempDirInput,
  FileTempFileInput,
  FileTruncateInput,
  FileWriteInput,
  ShellExecActionInput,
} from "@entities/execution/connector-protocol";
import { RemoteActionError, type RemoteExecutionMachine } from "./remote-execution-machine";
import {
  RemoteBinaryReader,
  RemoteDirReader,
  RemoteLineReader,
  type HandleActionType,
  type RemoteHandleOwner,
} from "./remote-reader-proxies";
import type { AnyExecutionAction } from "@usecases/ports/execution-machine";

const DEFAULT_SHELL_WAIT_MS = 10 * 60 * 1000;
const SHELL_COMPLETION_GRACE_MS = 5_000;
const EXECUTION_ERROR_CODES = new Set<ExecutionErrorCode>([
  "aborted", "timeout", "shell_unavailable", "spawn_error", "callback_error", "unknown",
]);
const FILE_ERROR_CODES = new Set([
  "aborted", "not_found", "permission_denied", "not_directory", "is_directory", "invalid", "not_supported", "unknown",
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
 * 远程 SDK 执行环境：shell + 文件面经 RemoteExecutionMachine.run
 * 落到 connector 设备执行（协议 v2），绝不静默落 hub。
 *
 * 设计决策：
 * - 路径跨机映射：模型看到 hub 侧对话工作区路径（env.cwd）。相对路径/工作区内
 *   绝对路径映射为设备工作区路径（保持后缀）；工作区外绝对路径原样透传（设备
 *   绝对路径语义）；~/file:// 特殊形态留原样由设备侧 NodeExecutionEnv 展开。
 * - 二进制上线：readBinaryFile/reader.read 走 base64 帧载荷。
 * - 读器句柄资源协议：openBinaryReader/openDirReader/openTextLineReader 返回
 *   句柄代理，info/read/scanLines/next/readLine 逐次过通道；close 幂等
 *   （本地已关不再发帧；connector 侧 close 同样幂等）；cleanup() 关本实例全部开柄。
 * - 错误面：远端 action.result 的 errorCode（FileError code 直通）还原为 SDK
 *   FileError；传输/掉线（非 RemoteActionError）→ unknown。
 * - 显式禁用面：watch（文件监视事件流无可靠远程协议，SDK env.watch 无生产调用方）
 *   与 listFiles（SDK 契约即声明 not_supported 为合法降级信号、调用方回退自有
 *   遍历）保持 not_supported。杜绝半残仿真。
 */
export class RemoteExecutionEnv implements ExecutionEnv, RemoteHandleOwner {
  readonly id: string;
  private readonly controllers = new Set<AbortController>();
  /** 本实例打开的读器句柄（cleanup 时全量关闭） */
  private readonly openHandles = new Set<string>();
  /** 设备工作区根（首个文件/shell 调用时解析并缓存——同会话内稳定） */
  private deviceWorkspaceDir?: Promise<string>;

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
    this.machine.assertShellSupported();
    const opts = options ?? {};
    try {
      const deviceWorkspace = await this.deviceWorkspace();
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
      ...this.attribution(),
      ...optional,
    } as ShellExecActionInput;
  }

  // ── 文件读 ──

  async readTextFile(target: string, context: Context): Promise<Result<string, FileError>> {
    return this.fileCall(target, context, async deviceTarget => {
      const input: FilePathInput = { conversationId: this.conversationId, path: deviceTarget, ...this.attribution() };
      return this.machine.run({ type: "file.read", input });
    });
  }

  async readTextLines(
    target: string,
    options: { maxLines?: number } | undefined,
    context: Context,
  ): Promise<Result<string[], FileError>> {
    return this.fileCall(target, context, async deviceTarget => {
      const input: FileReadLinesInput = {
        conversationId: this.conversationId,
        path: deviceTarget,
        ...(options?.maxLines !== undefined ? { maxLines: options.maxLines } : {}),
        ...this.attribution(),
      };
      return this.machine.run({ type: "file.readLines", input });
    });
  }

  async readBinaryFile(target: string, context: Context): Promise<Result<Uint8Array, FileError>> {
    return this.fileCall(target, context, async deviceTarget => {
      const input: FilePathInput = { conversationId: this.conversationId, path: deviceTarget, ...this.attribution() };
      const base64 = await this.machine.run({ type: "file.readBinary", input });
      return new Uint8Array(Buffer.from(base64, "base64"));
    });
  }

  // ── 文件写（台账幂等/原子写/五态恢复在 connector 侧执行器内） ──

  async writeFile(target: string, content: string | Uint8Array, context: Context): Promise<Result<void, FileError>> {
    return this.fileCall(target, context, async deviceTarget => {
      await this.machine.run({ type: "file.write", input: this.writeInputFor(deviceTarget, content) });
    });
  }

  async appendFile(target: string, content: string | Uint8Array, context: Context): Promise<Result<void, FileError>> {
    return this.fileCall(target, context, async deviceTarget => {
      await this.machine.run({ type: "file.append", input: this.writeInputFor(deviceTarget, content) });
    });
  }

  async truncateFile(target: string, size: number, context: Context): Promise<Result<void, FileError>> {
    return this.fileCall(target, context, async deviceTarget => {
      const input: FileTruncateInput = { conversationId: this.conversationId, path: deviceTarget, size, ...this.attribution() };
      await this.machine.run({ type: "file.truncate", input });
    });
  }

  async flushFile(target: string, context: Context): Promise<Result<void, FileError>> {
    return this.fileCall(target, context, async deviceTarget => {
      const input: FilePathInput = { conversationId: this.conversationId, path: deviceTarget, ...this.attribution() };
      await this.machine.run({ type: "file.flush", input });
    });
  }

  async renameFile(sourcePath: string, destinationPath: string, context: Context): Promise<Result<void, FileError>> {
    return this.fileCall(sourcePath, context, async () => {
      const root = await this.deviceWorkspace();
      const input: FileRenameInput = {
        conversationId: this.conversationId,
        source: this.devicePath(sourcePath, root),
        destination: this.devicePath(destinationPath, root),
        ...this.attribution(),
      };
      await this.machine.run({ type: "file.rename", input });
    });
  }

  async createDir(
    target: string,
    options: { recursive?: boolean } | undefined,
    context: Context,
  ): Promise<Result<void, FileError>> {
    return this.fileCall(target, context, async deviceTarget => {
      const input: FileMkdirInput = {
        conversationId: this.conversationId,
        path: deviceTarget,
        ...(options?.recursive !== undefined ? { recursive: options.recursive } : {}),
        ...this.attribution(),
      };
      await this.machine.run({ type: "file.mkdir", input });
    });
  }

  async remove(
    target: string,
    options: { recursive?: boolean; force?: boolean } | undefined,
    context: Context,
  ): Promise<Result<void, FileError>> {
    return this.fileCall(target, context, async deviceTarget => {
      const input: FileRemoveInput = {
        conversationId: this.conversationId,
        path: deviceTarget,
        ...(options?.recursive !== undefined ? { recursive: options.recursive } : {}),
        ...(options?.force !== undefined ? { force: options.force } : {}),
        ...this.attribution(),
      };
      await this.machine.run({ type: "file.remove", input });
    });
  }

  // ── 元信息 / 路径解析（设备侧语义——符号链接/分隔符不做 hub 侧模拟） ──

  async fileInfo(target: string, context: Context): Promise<Result<FileInfo, FileError>> {
    return this.pathQuery(target, context, "file.stat");
  }

  async listDir(target: string, context: Context): Promise<Result<FileInfo[], FileError>> {
    return this.pathQuery(target, context, "file.list");
  }

  async exists(target: string, context: Context): Promise<Result<boolean, FileError>> {
    return this.pathQuery(target, context, "file.exists");
  }

  async canonicalPath(target: string, context: Context): Promise<Result<string, FileError>> {
    return this.pathQuery(target, context, "file.canonicalPath");
  }

  async absolutePath(target: string, context: Context): Promise<Result<string, FileError>> {
    return this.pathQuery(target, context, "file.absolutePath");
  }

  async joinPath(parts: string[], context: Context): Promise<Result<string, FileError>> {
    if (context.abortSignal?.aborted) return err(new FileError("aborted", "remote file.joinPath aborted"));
    try {
      const input: FileJoinPathInput = { conversationId: this.conversationId, parts, ...this.attribution() };
      return ok(await this.machine.run({ type: "file.joinPath", input }));
    } catch (error) {
      return err(this.toFileError(error, parts[0] ?? ""));
    }
  }

  async createTempDir(prefix: string | undefined, context: Context): Promise<Result<string, FileError>> {
    return this.fileCall("tmp", context, async () => {
      const input: FileTempDirInput = {
        conversationId: this.conversationId,
        ...(prefix !== undefined ? { prefix } : {}),
        ...this.attribution(),
      };
      return this.machine.run({ type: "file.createTempDir", input });
    });
  }

  async createTempFile(
    options: { prefix?: string; suffix?: string } | undefined,
    context: Context,
  ): Promise<Result<string, FileError>> {
    return this.fileCall("tmp", context, async () => {
      const input: FileTempFileInput = { conversationId: this.conversationId, ...(options ?? {}), ...this.attribution() };
      return this.machine.run({ type: "file.createTempFile", input });
    });
  }

  // ── 读器句柄资源协议 ──

  async openBinaryReader(
    target: string,
    options: { noFollow?: boolean } | undefined,
    context: Context,
  ): Promise<Result<BinaryReader, FileError>> {
    return this.fileCall(target, context, async deviceTarget => {
      const input: FileOpenReaderInput = {
        conversationId: this.conversationId,
        path: deviceTarget,
        ...(options?.noFollow !== undefined ? { noFollow: options.noFollow } : {}),
        ...this.attribution(),
      };
      const opened = await this.machine.run({ type: "file.openReader", input });
      return this.trackHandle(new RemoteBinaryReader(this, opened.handle));
    });
  }

  async openDirReader(target: string, context: Context): Promise<Result<DirReader, FileError>> {
    return this.fileCall(target, context, async deviceTarget => {
      const input: FilePathInput = { conversationId: this.conversationId, path: deviceTarget, ...this.attribution() };
      const opened = await this.machine.run({ type: "file.openDirReader", input });
      return this.trackHandle(new RemoteDirReader(this, opened.handle));
    });
  }

  async openTextLineReader(target: string, context: Context): Promise<Result<TextLineReader, FileError>> {
    return this.fileCall(target, context, async deviceTarget => {
      const input: FilePathInput = { conversationId: this.conversationId, path: deviceTarget, ...this.attribution() };
      const opened = await this.machine.run({ type: "file.openLineReader", input });
      return this.trackHandle(new RemoteLineReader(this, opened.handle));
    });
  }

  /** 句柄代理回调面：读器代理经此过通道（conversationId 由本类补全） */
  async runHandleAction(type: HandleActionType, input: Record<string, unknown>): Promise<unknown> {
    return this.machine.run(
      { type, input: { conversationId: this.conversationId, ...input, ...this.attribution() } } as unknown as AnyExecutionAction,
    );
  }

  forgetHandle(handle: string): void {
    this.openHandles.delete(handle);
  }

  // ── 显式禁用面（杜绝半残仿真；SDK 侧均有契约化降级） ──

  /** watch：文件监视事件流无可靠远程协议（SDK env.watch 无生产调用方）→ 显式禁用 */
  watch(_targets: readonly WatchTarget[], _onChange: (change: FileChange) => void, _context: Context) {
    return this.unsupported<never>();
  }

  /** listFiles：SDK 契约即声明 not_supported 为合法降级信号（调用方回退自有遍历）→ 显式禁用 */
  listFiles(_target: string, _options: ListFilesOptions | undefined, _context: Context) {
    return this.unsupported<never>(_target);
  }

  async cleanup(_context: Context): Promise<void> {
    for (const controller of this.controllers) controller.abort();
    this.controllers.clear();
    // 关闭本实例全部开柄（best-effort：掉线时 connector 侧会话更替亦会全量关闭）
    const handles = [...this.openHandles];
    this.openHandles.clear();
    await Promise.all(handles.map(handle =>
      this.runHandleAction("file.resourceClose", { handle }).catch(() => undefined)));
  }

  // ── 内部：设备路径映射 / 错误还原 / 设备工作区缓存 ──

  private deviceWorkspace(): Promise<string> {
    this.deviceWorkspaceDir ??= this.machine.run({
      type: "workspace.path",
      input: { conversationId: this.conversationId },
    });
    return this.deviceWorkspaceDir;
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

  /** hub 侧目标路径 → 设备侧路径（~/file:// 特殊形态留原样由设备 NodeExecutionEnv 展开） */
  private devicePath(target: string, deviceWorkspace: string): string {
    if (target === "~" || target.startsWith(`~${path.sep}`) || target.startsWith("file://")) return target;
    return this.deviceCwd(target, deviceWorkspace);
  }

  /** 文件调用公共链：abort 预检 → 设备路径映射 → 远端执行 → RemoteActionError 还原 FileError */
  private async fileCall<T>(
    target: string,
    context: Context,
    fn: (deviceTarget: string) => Promise<T>,
  ): Promise<Result<T, FileError>> {
    if (context.abortSignal?.aborted) {
      return err(new FileError("aborted", `remote file operation aborted: ${target}`, target));
    }
    try {
      return ok(await fn(this.devicePath(target, await this.deviceWorkspace())));
    } catch (error) {
      return err(this.toFileError(error, target));
    }
  }

  /** 单路径查询类动作公共形（stat/list/exists/canonicalPath/absolutePath） */
  private async pathQuery<T>(
    target: string,
    context: Context,
    type: "file.stat" | "file.list" | "file.exists" | "file.canonicalPath" | "file.absolutePath",
  ): Promise<Result<T, FileError>> {
    return this.fileCall(target, context, async deviceTarget => {
      const input: FilePathInput = { conversationId: this.conversationId, path: deviceTarget, ...this.attribution() };
      return this.machine.run({ type, input }) as Promise<T>;
    });
  }

  private writeInputFor(deviceTarget: string, content: string | Uint8Array): FileWriteInput {
    return {
      conversationId: this.conversationId,
      path: deviceTarget,
      ...(typeof content === "string"
        ? { content, encoding: "utf8" as const }
        : { content: Buffer.from(content).toString("base64"), encoding: "base64" as const }),
      ...this.attribution(),
    };
  }

  private attribution(): { invokeId?: string; toolCallId?: string } {
    const store = otterInvokeStorage.getStore();
    return {
      ...(store?.currentInvokeId !== undefined ? { invokeId: store.currentInvokeId } : {}),
      ...(store?.currentToolCallId !== undefined ? { toolCallId: store.currentToolCallId } : {}),
    };
  }

  private trackHandle<T extends { readonly handle: string }>(reader: T): T {
    this.openHandles.add(reader.handle);
    return reader;
  }

  /** RemoteActionError.errorCode（FileError code 直通）→ SDK FileError；传输/掉线 → unknown */
  private toFileError(error: unknown, target: string): FileError {
    if (error instanceof RemoteActionError) {
      const code = typeof error.errorCode === "string" && FILE_ERROR_CODES.has(error.errorCode) ? error.errorCode : "unknown";
      const errorPath = extractWirePath(error.result) ?? target;
      return new FileError(code as FileError["code"], error.message, errorPath);
    }
    return new FileError("unknown", error instanceof Error ? error.message : String(error), target);
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
    return Promise.resolve(err(new FileError("not_supported", "remote capability is explicitly disabled in this slice", target)));
  }
}

/** action.result 失败载荷里 connector 回传的 FileError.path（result.path 线形） */
function extractWirePath(result: unknown): string | undefined {
  if (result && typeof result === "object" && typeof (result as { path?: unknown }).path === "string") {
    return (result as { path: string }).path;
  }
  return undefined;
}
