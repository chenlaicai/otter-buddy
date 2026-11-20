/**
 * 读器句柄表（FileActionExecutor 的句柄族拆分——句柄是 connector 进程内资源）。
 *
 * openReader/openDirReader/openLineReader 开柄入表；readerRead/readerScanLines/
 * readerInfo/dirReaderNext/lineReaderRead 按柄调用；resourceClose 幂等关柄；
 * 会话更替/进程下线经 closeAll 全量关闭（hub 侧代际已死则句柄无属主）。
 */

import { randomUUID } from "node:crypto";
import type { Context } from "@earendil-works/chord/context";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { FileError, type BinaryReader, type DirReader, type Result, type TextLineReader } from "@earendil-works/pi-durable/env";
import type { FileActionOutcome } from "./file-action-executor";

type ReaderHandle =
  | { kind: "binary"; reader: BinaryReader }
  | { kind: "dir"; reader: DirReader }
  | { kind: "line"; reader: TextLineReader };

export class ReaderHandleTable {
  private readonly handles = new Map<string, ReaderHandle>();
  get size(): number { return this.handles.size; }

  /** 开柄入表（打开失败/取首 info 失败由调用方先判——本类只管登记） */
  register<K extends ReaderHandle["kind"]>(kind: K, reader: Extract<ReaderHandle, { kind: K }>["reader"]): string {
    const handle = randomUUID();
    this.handles.set(handle, { kind, reader } as ReaderHandle);
    return handle;
  }

  unregister(handle: string): void {
    this.handles.delete(handle);
  }

  async binaryRead(input: Record<string, unknown>, ctx: Context): Promise<FileActionOutcome> {
    const handle = this.lookup(input, "binary");
    if (handle instanceof FileError) return outcomeFromFileError(handle);
    const { position, length } = input;
    if (typeof position !== "number" || typeof length !== "number") return invalidOutcome("file.readerRead requires numeric position/length");
    const result = await handle.reader.read(position, length, ctx);
    return result.ok ? { status: "succeeded", result: Buffer.from(result.value).toString("base64") } : outcomeFromFileError(result.error);
  }

  async binaryScanLines(input: Record<string, unknown>, ctx: Context): Promise<FileActionOutcome> {
    const handle = this.lookup(input, "binary");
    if (handle instanceof FileError) return outcomeFromFileError(handle);
    const { startLine, endLine } = input;
    if (typeof startLine !== "number") return invalidOutcome("file.readerScanLines requires numeric startLine");
    if (endLine !== undefined && typeof endLine !== "number") return invalidOutcome("file.readerScanLines endLine must be a number");
    return outcomeOf(await handle.reader.scanLines({ startLine, ...(endLine === undefined ? {} : { endLine }) }, ctx));
  }

  async binaryInfo(input: Record<string, unknown>, ctx: Context): Promise<FileActionOutcome> {
    const handle = this.lookup(input, "binary");
    if (handle instanceof FileError) return outcomeFromFileError(handle);
    return outcomeOf(await handle.reader.info(ctx));
  }

  async dirNext(input: Record<string, unknown>, ctx: Context): Promise<FileActionOutcome> {
    const handle = this.lookup(input, "dir");
    if (handle instanceof FileError) return outcomeFromFileError(handle);
    if (typeof input.maxEntries !== "number") return invalidOutcome("file.dirReaderNext requires numeric maxEntries");
    return outcomeOf(await handle.reader.next(input.maxEntries, ctx));
  }

  async lineRead(input: Record<string, unknown>, ctx: Context): Promise<FileActionOutcome> {
    const handle = this.lookup(input, "line");
    if (handle instanceof FileError) return outcomeFromFileError(handle);
    const result = await handle.reader.readLine(ctx);
    // EOF（undefined）线形化为 null（JSON 无 undefined）
    return result.ok ? { status: "succeeded", result: result.value ?? null } : outcomeFromFileError(result.error);
  }

  /** 关柄幂等：未知/已关句柄按成功处理（close 语义幂等——重复 close 不是错误） */
  close(input: Record<string, unknown>): FileActionOutcome {
    const handleId = requiredString(input.handle);
    if (handleId === null) return invalidOutcome("file.resourceClose requires handle");
    const handle = this.handles.get(handleId);
    if (!handle) return { status: "succeeded", result: null };
    this.handles.delete(handleId);
    void handle.reader.close(BACKGROUND_CONTEXT).catch(() => undefined);
    return { status: "succeeded", result: null };
  }

  /** 会话更替/进程下线：全量关柄（幂等，best-effort） */
  async closeAll(): Promise<void> {
    const entries = [...this.handles.values()];
    this.handles.clear();
    await Promise.all(entries.map(entry => entry.reader.close(BACKGROUND_CONTEXT).catch(() => undefined)));
  }

  private lookup<K extends ReaderHandle["kind"]>(input: Record<string, unknown>, kind: K): Extract<ReaderHandle, { kind: K }> | FileError {
    const handleId = requiredString(input.handle);
    if (handleId === null) return new FileError("invalid", "reader action requires handle");
    const handle = this.handles.get(handleId);
    if (!handle || handle.kind !== kind) {
      return new FileError("invalid", `reader handle closed or unknown: ${handleId}`);
    }
    return handle as Extract<ReaderHandle, { kind: K }>;
  }
}

function requiredString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function invalidOutcome(message: string): FileActionOutcome {
  return { status: "failed", errorCode: "invalid", error: message };
}

function outcomeOf(result: Result<unknown, FileError>): FileActionOutcome {
  return result.ok ? { status: "succeeded", result: result.value ?? null } : outcomeFromFileError(result.error);
}

function outcomeFromFileError(error: FileError): FileActionOutcome {
  const base = { errorCode: error.code, error: error.message, ...(error.path !== undefined ? { errorPath: error.path } : {}) };
  return error.code === "aborted" ? { status: "interrupted", ...base } : { status: "failed", ...base };
}
