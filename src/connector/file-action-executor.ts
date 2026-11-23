/**
 * connector 侧 file.* 动作执行器（协议 v2）。
 *
 * 执行底座：每动作以设备工作区根为 cwd 构造 NodeExecutionEnv（SDK 原生
 * ~/file:// 展开、相对解析、符号链接与 FileError 分类全部设备侧语义），
 * 路径不做 hub 侧模拟。写类动作（write/append/truncate/rename/remove/mkdir）
 * 落本地台账（actionId 用 hub 下发值，五态与 hash 核对复用开机清扫）；
 * 读类动作不入账（与中枢 local 一致：只读幂等不写台账）。
 *
 * 写保持原子写（同目录临时文件 rename、symlink 跟随、mode 保留、broken link
 * 逐级解析）——与中枢 RecordingNodeExecutionEnv 同语义（闭包铁律不引用该模块：
 * 其 ALS 依赖拖 api-contract；本文件自含同规实现）。
 *
 * 读器句柄族委派 ReaderHandleTable（file-reader-handles.ts）。
 */

import { lstat, mkdir, readlink, realpath, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { err, FileError, ok, type Result } from "@earendil-works/pi-durable/env";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ActionKind } from "@entities/execution/action-record";
import type { ActionLedger } from "@usecases/ports/action-ledger";
import { sha256 } from "@frameworks/execution/ledger/sqlite-action-ledger";
import { ReaderHandleTable } from "./file-reader-handles";

/** file.* 动作结局（dispatcher 映射为 action.result 载荷；errorCode=FileError code 直通） */
export type FileActionOutcome =
  | { status: "succeeded"; result: unknown }
  | { status: "interrupted"; errorCode: string; error: string; errorPath?: string }
  | { status: "failed"; errorCode: string; error: string; errorPath?: string };

/** dispatcher 依赖的文件执行面（测试可 fake） */
export interface FileExecutorLike {
  run(type: string, input: Record<string, unknown>, options: { actionId: string }): Promise<FileActionOutcome>;
  closeAllResources(reason?: string): Promise<void>;
}

export interface FileActionExecutorDeps {
  ledger: ActionLedger | null;
  /** conversationId → 设备工作区根（NodeWorkspaceGateway.getWorkspacePath 语义） */
  resolveWorkspaceRoot: (conversationId: string) => string;
  log?: (message: string, meta?: Record<string, unknown>) => void;
}

type Handler = (env: NodeExecutionEnv, input: Record<string, unknown>, options: { actionId: string }) => Promise<FileActionOutcome>;

/** node:fs 错误码 → SDK FileError code（与 SDK env/node.js 的 toFileError 映射对齐） */
const NODE_ERROR_TO_FILE_ERROR: Record<string, FileError["code"]> = {
  ABORT_ERR: "aborted",
  ENOENT: "not_found",
  EACCES: "permission_denied",
  EPERM: "permission_denied",
  ENOTDIR: "not_directory",
  EISDIR: "is_directory",
  EINVAL: "invalid",
};

/** 链式断链解析深度上限（对齐 OS realpath/ELOOP 常见配额 40） */
const SYMLINK_CHAIN_DEPTH_LIMIT = 40;

export class FileActionExecutor implements FileExecutorLike {
  private readonly readers = new ReaderHandleTable();
  get openHandleCount(): number { return this.readers.size; }

  constructor(private readonly deps: FileActionExecutorDeps) {}

  /** 动作分发表（每方法一动作——白名单/台账/类型逐点对齐既有六动作风格） */
  private readonly handlers: Record<string, Handler> = {
    // ── 读类（不入账） ──
    "file.read": (env, i) => this.plain("file.read", i, p => env.readTextFile(p, BACKGROUND_CONTEXT)),
    "file.readLines": (env, i) => this.readLines(env, i),
    "file.readBinary": (env, i) => this.plain("file.readBinary", i, async p => {
      const result = await env.readBinaryFile(p, BACKGROUND_CONTEXT);
      return result.ok ? ok(Buffer.from(result.value).toString("base64")) : result;
    }),
    "file.stat": (env, i) => this.plain("file.stat", i, p => env.fileInfo(p, BACKGROUND_CONTEXT)),
    "file.list": (env, i) => this.plain("file.list", i, p => env.listDir(p, BACKGROUND_CONTEXT)),
    "file.exists": (env, i) => this.plain("file.exists", i, p => env.exists(p, BACKGROUND_CONTEXT)),
    "file.canonicalPath": (env, i) => this.plain("file.canonicalPath", i, p => env.canonicalPath(p, BACKGROUND_CONTEXT)),
    "file.absolutePath": (env, i) => this.plain("file.absolutePath", i, p => env.absolutePath(p, BACKGROUND_CONTEXT)),
    "file.flush": (env, i) => this.plain("file.flush", i, p => env.flushFile(p, BACKGROUND_CONTEXT)),
    "file.joinPath": (env, i) => this.joinPath(env, i),
    "file.createTempDir": (env, i) => this.tempDir(env, i),
    "file.createTempFile": (env, i) => this.tempFile(env, i),
    // ── 写类（台账 + 五态） ──
    "file.write": (env, i, o) => this.write(env, i, o),
    "file.append": (env, i, o) => this.append(env, i, o),
    "file.truncate": (env, i, o) => this.truncate(env, i, o),
    "file.rename": (env, i, o) => this.rename(env, i, o),
    "file.remove": (env, i, o) => this.removePath(env, i, o),
    "file.mkdir": (env, i, o) => this.mkdirPath(env, i, o),
    // ── 读器句柄族 ──
    "file.openReader": (env, i) => this.openReader(env, i),
    "file.readerRead": (_env, i) => this.readers.binaryRead(i, BACKGROUND_CONTEXT),
    "file.readerScanLines": (_env, i) => this.readers.binaryScanLines(i, BACKGROUND_CONTEXT),
    "file.readerInfo": (_env, i) => this.readers.binaryInfo(i, BACKGROUND_CONTEXT),
    "file.openDirReader": (env, i) => this.openDirReader(env, i),
    "file.dirReaderNext": (_env, i) => this.readers.dirNext(i, BACKGROUND_CONTEXT),
    "file.openLineReader": (env, i) => this.openLineReader(env, i),
    "file.lineReaderRead": (_env, i) => this.readers.lineRead(i, BACKGROUND_CONTEXT),
    "file.resourceClose": (_env, i) => Promise.resolve(this.readers.close(i)),
  };

  async run(type: string, input: Record<string, unknown>, options: { actionId: string }): Promise<FileActionOutcome> {
    if (typeof input?.conversationId !== "string" || input.conversationId.length === 0) {
      return invalidOutcome("file action requires non-empty conversationId");
    }
    const handler = this.handlers[type];
    if (!handler) return invalidOutcome(`unsupported file action: ${type}`);
    const root = this.deps.resolveWorkspaceRoot(input.conversationId);
    return handler(new NodeExecutionEnv({ cwd: root }), input, options);
  }

  /** 会话更替/进程下线：读器句柄全量关闭（进程内资源随代际释放） */
  async closeAllResources(_reason?: string): Promise<void> {
    await this.readers.closeAll();
  }

  // ── 读类小工具 ──

  private async plain(
    label: string,
    input: Record<string, unknown>,
    fn: (target: string) => Promise<Result<unknown, FileError>>,
  ): Promise<FileActionOutcome> {
    const target = requiredPath(input);
    if (target === null) return invalidOutcome(`${label} requires non-empty path`);
    return outcomeOf(await fn(target));
  }

  private async readLines(env: NodeExecutionEnv, input: Record<string, unknown>): Promise<FileActionOutcome> {
    const target = requiredPath(input);
    if (target === null) return invalidOutcome("file.readLines requires non-empty path");
    const maxLines = input.maxLines;
    if (maxLines !== undefined && typeof maxLines !== "number") return invalidOutcome("file.readLines maxLines must be a number");
    return outcomeOf(await env.readTextLines(target, { ...(maxLines === undefined ? {} : { maxLines }) }, BACKGROUND_CONTEXT));
  }

  private async joinPath(env: NodeExecutionEnv, input: Record<string, unknown>): Promise<FileActionOutcome> {
    const parts = input.parts;
    if (!Array.isArray(parts) || parts.length === 0 || !parts.every(part => typeof part === "string")) {
      return invalidOutcome("file.joinPath requires non-empty string parts");
    }
    return outcomeOf(await env.joinPath(parts, BACKGROUND_CONTEXT));
  }

  private async tempDir(env: NodeExecutionEnv, input: Record<string, unknown>): Promise<FileActionOutcome> {
    const prefix = optionalString(input.prefix);
    if (prefix === null) return invalidOutcome("file.createTempDir prefix must be a string");
    return outcomeOf(await env.createTempDir(prefix, BACKGROUND_CONTEXT));
  }

  private async tempFile(env: NodeExecutionEnv, input: Record<string, unknown>): Promise<FileActionOutcome> {
    const prefix = optionalString(input.prefix);
    const suffix = optionalString(input.suffix);
    if (prefix === null || suffix === null) return invalidOutcome("file.createTempFile prefix/suffix must be strings");
    return outcomeOf(await env.createTempFile({ ...(prefix ? { prefix } : {}), ...(suffix ? { suffix } : {}) }, BACKGROUND_CONTEXT));
  }

  // ── 写类（台账五态） ──

  private async write(env: NodeExecutionEnv, input: Record<string, unknown>, options: { actionId: string }): Promise<FileActionOutcome> {
    const decoded = decodeContent(input);
    if (decoded === null) return invalidOutcome("file.write requires content (string) with encoding utf8|base64");
    const target = requiredPath(input);
    if (target === null) return invalidOutcome("file.write requires non-empty path");
    const resolved = await env.absolutePath(target, BACKGROUND_CONTEXT);
    const ledgerTarget = resolved.ok ? resolved.value : target;
    return this.recorded(input, options, {
      kind: "file.write", target: ledgerTarget,
      contentHash: sha256(decoded), contentBytes: decoded.byteLength,
      resultSummary: { bytes: decoded.byteLength },
    }, () => this.atomicWriteResult(env, target, decoded));
  }

  private async append(env: NodeExecutionEnv, input: Record<string, unknown>, options: { actionId: string }): Promise<FileActionOutcome> {
    const decoded = decodeContent(input);
    if (decoded === null) return invalidOutcome("file.append requires content (string) with encoding utf8|base64");
    const target = requiredPath(input);
    if (target === null) return invalidOutcome("file.append requires non-empty path");
    const resolved = await env.absolutePath(target, BACKGROUND_CONTEXT);
    return this.recorded(input, options, {
      kind: "file.append", target: resolved.ok ? resolved.value : target,
      contentHash: sha256(decoded), contentBytes: decoded.byteLength,
      resultSummary: { bytes: decoded.byteLength },
    }, () => env.appendFile(target, decoded, BACKGROUND_CONTEXT));
  }

  private async truncate(env: NodeExecutionEnv, input: Record<string, unknown>, options: { actionId: string }): Promise<FileActionOutcome> {
    const target = requiredPath(input);
    const size = input.size;
    if (target === null) return invalidOutcome("file.truncate requires non-empty path");
    if (typeof size !== "number" || !Number.isInteger(size) || size < 0) return invalidOutcome("file.truncate requires non-negative integer size");
    const resolved = await env.absolutePath(target, BACKGROUND_CONTEXT);
    return this.recorded(input, options, {
      kind: "file.truncate", target: resolved.ok ? resolved.value : target,
      contentBytes: size, resultSummary: { bytes: size },
    }, () => env.truncateFile(target, size, BACKGROUND_CONTEXT));
  }

  private async rename(env: NodeExecutionEnv, input: Record<string, unknown>, options: { actionId: string }): Promise<FileActionOutcome> {
    const source = requiredString(input.source);
    const destination = requiredString(input.destination);
    if (source === null || destination === null) return invalidOutcome("file.rename requires source and destination");
    const resolved = await env.absolutePath(destination, BACKGROUND_CONTEXT);
    return this.recorded(input, options, {
      kind: "file.rename", target: resolved.ok ? resolved.value : destination,
      resultSummary: { source },
    }, () => env.renameFile(source, destination, BACKGROUND_CONTEXT));
  }

  private async removePath(env: NodeExecutionEnv, input: Record<string, unknown>, options: { actionId: string }): Promise<FileActionOutcome> {
    const target = requiredPath(input);
    if (target === null) return invalidOutcome("file.remove requires non-empty path");
    const resolved = await env.absolutePath(target, BACKGROUND_CONTEXT);
    return this.recorded(input, options, {
      kind: "file.remove", target: resolved.ok ? resolved.value : target,
    }, () => env.remove(target, {
      ...(input.recursive !== undefined ? { recursive: input.recursive === true } : {}),
      ...(input.force !== undefined ? { force: input.force === true } : {}),
    }, BACKGROUND_CONTEXT));
  }

  private async mkdirPath(env: NodeExecutionEnv, input: Record<string, unknown>, options: { actionId: string }): Promise<FileActionOutcome> {
    const target = requiredPath(input);
    if (target === null) return invalidOutcome("file.mkdir requires non-empty path");
    const resolved = await env.absolutePath(target, BACKGROUND_CONTEXT);
    return this.recorded(input, options, {
      kind: "file.mkdir", target: resolved.ok ? resolved.value : target,
    }, () => env.createDir(target, { ...(input.recursive !== undefined ? { recursive: input.recursive === true } : {}) }, BACKGROUND_CONTEXT));
  }

  /** 写类公共链：台账 start（deduped=已成功 → 不重执行）→ 执行 → 五态 settle → 结局 */
  private async recorded(
    input: Record<string, unknown>,
    options: { actionId: string },
    meta: {
      kind: ActionKind;
      target: string;
      contentHash?: string | null;
      contentBytes?: number | null;
      resultSummary?: Record<string, unknown>;
    },
    fn: () => Promise<Result<unknown, FileError>>,
  ): Promise<FileActionOutcome> {
    const started = await this.recordStart(input, options.actionId, meta);
    if (started?.deduped) return { status: "succeeded", result: null }; // 写类活体结果为空（void）
    const result = await fn();
    if (result.ok) {
      await this.settleQuietly(started, options.actionId, {
        status: "succeeded",
        ...(meta.resultSummary ? { resultSummary: meta.resultSummary } : {}),
      });
      return { status: "succeeded", result: null };
    }
    const verdict = verdictFromFileError(result.error);
    await this.settleQuietly(started, options.actionId, verdict);
    return outcomeFromFileError(result.error);
  }

  // ── 读器打开（句柄登记；打开后取 info 失败即关柄不留孤儿） ──

  private async openReader(env: NodeExecutionEnv, input: Record<string, unknown>): Promise<FileActionOutcome> {
    const target = requiredPath(input);
    if (target === null) return invalidOutcome("file.openReader requires non-empty path");
    const result = await env.openBinaryReader(target, {
      ...(input.noFollow !== undefined ? { noFollow: input.noFollow === true } : {}),
    }, BACKGROUND_CONTEXT);
    if (!result.ok) return outcomeFromFileError(result.error);
    const info = await result.value.info(BACKGROUND_CONTEXT);
    if (!info.ok) {
      await result.value.close(BACKGROUND_CONTEXT).catch(() => undefined);
      return outcomeFromFileError(info.error);
    }
    const handle = this.readers.register("binary", result.value);
    return { status: "succeeded", result: { handle, info: info.value } };
  }

  private async openDirReader(env: NodeExecutionEnv, input: Record<string, unknown>): Promise<FileActionOutcome> {
    const target = requiredPath(input);
    if (target === null) return invalidOutcome("file.openDirReader requires non-empty path");
    const result = await env.openDirReader(target, BACKGROUND_CONTEXT);
    if (!result.ok) return outcomeFromFileError(result.error);
    return { status: "succeeded", result: { handle: this.readers.register("dir", result.value) } };
  }

  private async openLineReader(env: NodeExecutionEnv, input: Record<string, unknown>): Promise<FileActionOutcome> {
    const target = requiredPath(input);
    if (target === null) return invalidOutcome("file.openLineReader requires non-empty path");
    const result = await env.openTextLineReader(target, BACKGROUND_CONTEXT);
    if (!result.ok) return outcomeFromFileError(result.error);
    return { status: "succeeded", result: { handle: this.readers.register("line", result.value) } };
  }

  // ── 原子写（与中枢 RecordingNodeExecutionEnv 同语义的自含实现） ──

  private async atomicWriteResult(env: NodeExecutionEnv, target: string, content: Buffer): Promise<Result<void, FileError>> {
    const resolved = await env.absolutePath(target, BACKGROUND_CONTEXT);
    if (!resolved.ok) return resolved;
    try {
      await this.atomicWrite(resolved.value, content);
      return ok(undefined);
    } catch (error) {
      return err(toFileError(error, resolved.value));
    }
  }

  private async atomicWrite(resolvedTarget: string, content: Buffer): Promise<void> {
    await mkdir(path.dirname(resolvedTarget), { recursive: true });
    // symlink 跟随 + mode 保留：写链接指向的真实文件，不替换链接本身；
    // broken symlink 逐级 readlink 到最终缺失目标后穿透创建（对齐 SDK 基线）
    let target = resolvedTarget;
    let mode: number | undefined;
    try {
      const linkStat = await lstat(target);
      if (linkStat.isSymbolicLink()) {
        try {
          target = await realpath(target);
        } catch {
          target = await resolveBrokenLinkTarget(resolvedTarget);
          await mkdir(path.dirname(target), { recursive: true });
        }
      }
      const existingStat = await lstat(target).catch(() => undefined);
      mode = existingStat && !existingStat.isSymbolicLink() ? existingStat.mode & 0o777 : undefined;
    } catch (error) {
      if (error instanceof FileError) throw error; // 链解析显式失败不吞
      /* 全新文件，默认 mode */
    }
    const tmp = path.join(path.dirname(target), `.otter-tmp-${randomUUID()}`);
    try {
      await writeFile(tmp, content, { mode: mode ?? 0o666 });
      await rename(tmp, target);
    } catch (error) {
      await rm(tmp, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  // ── 台账记录（失败绝不打断真实动作——记录降级语义） ──

  private async recordStart(
    input: Record<string, unknown>,
    actionId: string,
    meta: { kind: ActionKind; target: string; contentHash?: string | null; contentBytes?: number | null },
  ): Promise<{ record: { actionId: string }; deduped: boolean } | null> {
    if (!this.deps.ledger) return null;
    try {
      return await this.deps.ledger.start({
        actionId,
        invokeId: typeof input.invokeId === "string" ? input.invokeId : null,
        conversationId: typeof input.conversationId === "string" ? input.conversationId : null,
        toolCallId: typeof input.toolCallId === "string" ? input.toolCallId : null,
        source: "sdk-env",
        kind: meta.kind,
        target: meta.target,
        contentHash: meta.contentHash ?? null,
        contentBytes: meta.contentBytes ?? null,
      });
    } catch (error) {
      this.deps.log?.("action ledger record failed (non-fatal)", { kind: meta.kind, error: errorMessage(error) });
      return null;
    }
  }

  private async settleQuietly(
    started: { record: { actionId: string } } | null,
    actionId: string,
    verdict: Parameters<ActionLedger["settle"]>[1],
  ): Promise<void> {
    if (!started || !this.deps.ledger) return;
    try {
      await this.deps.ledger.settle(started.record.actionId, verdict);
    } catch (error) {
      this.deps.log?.("action ledger settle failed (non-fatal)", { actionId, error: errorMessage(error) });
    }
  }
}

// ── 纯函数：校验/映射 ──

function requiredString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function optionalString(value: unknown): string | undefined | null {
  if (value === undefined) return undefined;
  return typeof value === "string" ? value : null;
}

function requiredPath(input: Record<string, unknown>): string | null {
  return requiredString(input.path);
}

function decodeContent(input: Record<string, unknown>): Buffer | null {
  if (typeof input.content !== "string") return null;
  if (input.encoding === "base64") return Buffer.from(input.content, "base64");
  if (input.encoding === undefined || input.encoding === "utf8") return Buffer.from(input.content, "utf8");
  return null;
}

function invalidOutcome(message: string): FileActionOutcome {
  return { status: "failed", errorCode: "invalid", error: message };
}

function outcomeOf(result: Result<unknown, FileError>): FileActionOutcome {
  return result.ok ? { status: "succeeded", result: result.value ?? null } : outcomeFromFileError(result.error);
}

/** FileError → 结局：aborted → interrupted（确定性停止）；其余域错误 → failed（errorCode=code 直通） */
function outcomeFromFileError(error: FileError): FileActionOutcome {
  const base = { errorCode: error.code, error: error.message, ...(error.path !== undefined ? { errorPath: error.path } : {}) };
  return error.code === "aborted" ? { status: "interrupted", ...base } : { status: "failed", ...base };
}

/** FileError → 台账裁决（与中枢 RecordingNodeExecutionEnv 同映射） */
function verdictFromFileError(error: FileError): Parameters<ActionLedger["settle"]>[1] {
  if (error.code === "aborted") return { status: "interrupted", error: error.message };
  return { status: "failed", error: `${error.code}: ${error.message}` };
}

function toFileError(error: unknown, fallbackPath: string): FileError {
  if (error instanceof FileError) return error;
  const nodeError = error as NodeJS.ErrnoException | undefined;
  const message = errorMessage(error);
  const target = typeof nodeError?.path === "string" ? nodeError.path : fallbackPath;
  const code = NODE_ERROR_TO_FILE_ERROR[nodeError?.code ?? ""] ?? "unknown";
  return new FileError(code, message, target);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 链式断链逐级 readlink 解析到最终缺失目标（或非链接项）；耗尽 = 循环/超深链 → 显式报错 */
async function resolveBrokenLinkTarget(linkPath: string): Promise<string> {
  let current = linkPath;
  for (let depth = 0; depth < SYMLINK_CHAIN_DEPTH_LIMIT; depth += 1) {
    const raw = await readlink(current);
    current = path.isAbsolute(raw) ? raw : path.resolve(path.dirname(current), raw);
    const next = await lstat(current).catch(() => undefined);
    if (!next || !next.isSymbolicLink()) return current;
  }
  throw new FileError("invalid", `symlink chain too deep or cyclic: ${linkPath}`, linkPath);
}
