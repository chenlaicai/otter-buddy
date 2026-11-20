/**
 * 远程读器句柄代理（RemoteExecutionEnv 的句柄族拆分）。
 *
 * 每个代理对应 connector 侧一个真读器（进程内资源）：info/read/scanLines/
 * next/readLine 逐次过通道；close 幂等（本地已关不再发帧；connector 侧 close
 * 同样幂等——双保险）；关后操作本地拒 invalid（不发帧）。RemoteActionError 的
 * errorCode（FileError code 直通）还原为 SDK FileError；传输/掉线 → unknown。
 */

import type { Context } from "@earendil-works/chord/context";
import {
  err,
  ok,
  FileError,
  type BinaryReader,
  type DirReader,
  type FileInfo,
  type LineScan,
  type Result,
  type TextLine,
  type TextLineReader,
} from "@earendil-works/pi-durable/env";
import { RemoteActionError } from "./remote-execution-machine";

/** 句柄动作类型（过通道白名单） */
export type HandleActionType =
  | "file.readerRead" | "file.readerScanLines" | "file.readerInfo"
  | "file.dirReaderNext" | "file.lineReaderRead" | "file.resourceClose";

/** 代理回调面（由 RemoteExecutionEnv 实现：conversationId 补全 + machine.run） */
export interface RemoteHandleOwner {
  runHandleAction(type: HandleActionType, input: Record<string, unknown>): Promise<unknown>;
  forgetHandle(handle: string): void;
}

const FILE_ERROR_CODES = new Set([
  "aborted", "not_found", "permission_denied", "not_directory", "is_directory", "invalid", "not_supported", "unknown",
]);

abstract class RemoteHandleBase {
  protected closed = false;

  constructor(
    protected readonly owner: RemoteHandleOwner,
    readonly handle: string,
  ) {}

  protected guard(context: Context, op: string): FileError | null {
    if (this.closed) return new FileError("invalid", `remote reader is closed (${op})`);
    if (context.abortSignal?.aborted) return new FileError("aborted", `remote reader ${op} aborted`);
    return null;
  }

  protected async wire<T>(type: HandleActionType, input: Record<string, unknown>): Promise<Result<T, FileError>> {
    try {
      return ok(await this.owner.runHandleAction(type, { handle: this.handle, ...input }) as T);
    } catch (error) {
      return err(toHandleError(error));
    }
  }

  /** close 幂等：本地已关不再发帧 */
  async close(_context: Context): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.owner.forgetHandle(this.handle);
    await this.owner.runHandleAction("file.resourceClose", { handle: this.handle }).catch(() => undefined);
  }
}

export class RemoteBinaryReader extends RemoteHandleBase implements BinaryReader {
  async info(context: Context): Promise<Result<FileInfo, FileError>> {
    const guard = this.guard(context, "info");
    if (guard) return err(guard);
    return this.wire<FileInfo>("file.readerInfo", {});
  }

  async read(offset: number, length: number, context: Context): Promise<Result<Uint8Array, FileError>> {
    const guard = this.guard(context, "read");
    if (guard) return err(guard);
    const result = await this.wire<string>("file.readerRead", { position: offset, length });
    return result.ok ? ok(new Uint8Array(Buffer.from(result.value, "base64"))) : result;
  }

  async scanLines(
    args: { startLine: number; endLine?: number },
    context: Context,
  ): Promise<Result<LineScan, FileError>> {
    const guard = this.guard(context, "scanLines");
    if (guard) return err(guard);
    return this.wire<LineScan>("file.readerScanLines", {
      startLine: args.startLine,
      ...(args.endLine !== undefined ? { endLine: args.endLine } : {}),
    });
  }
}

export class RemoteDirReader extends RemoteHandleBase implements DirReader {
  async next(maxEntries: number, context: Context): Promise<Result<{ entries: FileInfo[]; done: boolean }, FileError>> {
    const guard = this.guard(context, "next");
    if (guard) return err(guard);
    return this.wire("file.dirReaderNext", { maxEntries });
  }
}

export class RemoteLineReader extends RemoteHandleBase implements TextLineReader {
  async readLine(context: Context): Promise<Result<TextLine | undefined, FileError>> {
    const guard = this.guard(context, "readLine");
    if (guard) return err(guard);
    const result = await this.wire<TextLine | null>("file.lineReaderRead", {});
    return result.ok ? ok(result.value ?? undefined) : result;
  }
}

function toHandleError(error: unknown): FileError {
  if (error instanceof RemoteActionError) {
    const code = typeof error.errorCode === "string" && FILE_ERROR_CODES.has(error.errorCode) ? error.errorCode : "unknown";
    return new FileError(code as FileError["code"], error.message);
  }
  return new FileError("unknown", error instanceof Error ? error.message : String(error));
}
