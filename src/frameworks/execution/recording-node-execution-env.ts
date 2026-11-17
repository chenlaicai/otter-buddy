import { mkdir, lstat, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { FileError, ok, err, type ExecutionError, type Result, type ShellExecOptions, type ShellExecResult } from "@earendil-works/pi-durable/env";
import { otterInvokeStorage } from "@entities/execution/otter-invoke-context";
import type { ActionLedger } from "@usecases/ports/action-ledger";
import type { ActionKind, ActionRecord, SettleVerdict, StartActionInput } from "@entities/execution/action-record";
import { sha256 } from "./ledger/sqlite-action-ledger";

/** R-1：链式断链逐级 readlink 解析到最终缺失目标（或非链接项）——深度上限防循环链；
 *  耗尽时仍指向链接 = 循环链或超深链——显式报错对齐 SDK 基线的 ELOOP（不猜、不静默替换链接）。
 *  返回应写入的真实路径（可能仍不存在，由调用方 mkdir+创建）。 */
/** 链式断链解析深度上限（对齐 OS realpath/ELOOP 常见配额 40；耗尽=循环或超深链→显式报错） */
const SYMLINK_CHAIN_DEPTH_LIMIT = 40;

async function resolveBrokenLinkTarget(linkPath: string): Promise<string> {
  const { readlink } = await import("node:fs/promises");
  let current = linkPath;
  for (let depth = 0; depth < SYMLINK_CHAIN_DEPTH_LIMIT; depth += 1) {
    const raw = await readlink(current);
    current = path.isAbsolute(raw) ? raw : path.resolve(path.dirname(current), raw);
    const next = await lstat(current).catch(() => undefined);
    if (!next || !next.isSymbolicLink()) return current; // 最终 referent 缺失或非链接：在此创建
  }
  throw new FileError("invalid", `symlink chain too deep or cyclic: ${linkPath}`, linkPath);
}

/** node:fs 错误码 → SDK FileError code（对齐 env/node.js 的 toFileError 映射） */
const NODE_ERROR_TO_FILE_ERROR: Record<string, "aborted" | "not_found" | "permission_denied" | "not_directory" | "is_directory" | "invalid"> = {
  ABORT_ERR: "aborted",
  ENOENT: "not_found",
  EACCES: "permission_denied",
  EPERM: "permission_denied",
  ENOTDIR: "not_directory",
  EISDIR: "is_directory",
  EINVAL: "invalid",
};

/**
 * F20261116actlg：带台账记录的本机执行环境。
 *
 * 拦截副作用操作（写/追加/截断/改名/删除/建目录/exec）落动作台账；只读操作直通不入账
 * （幂等可安全重做，入账只加倍写负载）。分层定位：pi-durable 的 transcript 回答
 * 「哪些调用发出过」，本层回答「磁盘上到底成了没」——SDK 自己的中断结算也只敢说
 * "may have partially run"（tool.js:152），副作用验证不在对话持久层手里。
 *
 * 原子写：writeFile 不走 SDK 的直接覆写（非原子，崩溃留半截文件），改为
 * 同目录临时文件 → rename 原子落位；已存在目标保留 mode；symlink 目标先
 * realpath 跟随（写链接指向的真实文件，不替换链接本身）。
 *
 * 归属：invokeId/toolCallId 经 AsyncLocalStorage 传播（DurableSession.prompt/beforeTool
 * 写入）；ALS 之外的调用（如 SDK 内部整理）记 source 对应 internal 归属。
 *
 * 失败语义：台账是恢复增强面不是控制面——记录失败绝不打断真实动作（recordQuietly）。
 */
export class RecordingNodeExecutionEnv extends NodeExecutionEnv {
  /** 单调全局序（dspro minor：不再按 attribution 分桶——Map 键随 toolCall 无界增长；
   *  全局序保证同 boot 内唯一性，归属信息在 invoke/toolCall 列里完整保留） */
  private opSeq = 0;
  /** 实例标签（dspro RESIDUAL-1：SDK 每次工具调用新铸 env，实例间 opSeq 各自从 0 起——
   *  internal 归属拼入实例标签，杜绝同进程多实例同 id 铸造） */
  private readonly instanceTag = randomUUID().slice(0, 8);

  constructor(
    options: { cwd: string; shellPath?: string; shellEnv?: NodeJS.ProcessEnv },
    private readonly ledger: ActionLedger | null,
    private readonly warn?: (message: string, meta?: Record<string, unknown>) => void,
    /** 当前 boot 纪元（MAJOR-1 修复：自铸 actionId 必含纪元，防跨 boot 同序号碰撞错误去重；
     *  显式传入的 actionId 不受影响——那才是去重协议的本体） */
    private readonly bootEpoch = 0,
  ) {
    super(options);
  }

  override async writeFile(
    filePath: string,
    content: string | Uint8Array,
    context: Context,
  ): Promise<Result<void, FileError>> {
    const resolved = await this.resolveForWrite(filePath, context);
    if (!resolved.ok) return resolved;
    const bytes = typeof content === "string" ? Buffer.byteLength(content, "utf-8") : content.byteLength;
    const record = await this.recordQuietly({
      kind: "file.write",
      target: resolved.value,
      contentHash: sha256(typeof content === "string" ? Buffer.from(content, "utf-8") : content),
      contentBytes: bytes,
    });
    if (record?.deduped) return ok(undefined);
    try {
      await this.atomicWrite(resolved.value, content, context);
      await this.settleQuietly(record, { status: "succeeded", resultSummary: { bytes } });
      return ok(undefined);
    } catch (error) {
      // atomicWrite 自身的 catch 已精确清理本次临时文件（MINOR-2：不做目录级扫删，防误删并发者的 tmp）
      const fileError = this.toFileError(error, resolved.value);
      await this.settleQuietly(record, settleFromFileError(fileError, { bytes }));
      return err(fileError);
    }
  }

  override async appendFile(
    filePath: string,
    content: string | Uint8Array,
    context: Context,
  ): Promise<Result<void, FileError>> {
    const bytes = typeof content === "string" ? Buffer.byteLength(content, "utf-8") : content.byteLength;
    const record = await this.recordQuietly({
      kind: "file.append",
      target: await this.tryDisplayPath(filePath),
      contentHash: sha256(typeof content === "string" ? Buffer.from(content, "utf-8") : content),
      contentBytes: bytes,
    });
    if (record?.deduped) return ok(undefined);
    const result = await super.appendFile(filePath, content, context);
    await this.settleQuietly(record, settleFromFileResult(result, { bytes }));
    return result;
  }

  override async truncateFile(
    filePath: string,
    size: number,
    context: Context,
  ): Promise<Result<void, FileError>> {
    const record = await this.recordQuietly({ kind: "file.truncate", target: await this.tryDisplayPath(filePath), contentBytes: size });
    if (record?.deduped) return ok(undefined);
    const result = await super.truncateFile(filePath, size, context);
    await this.settleQuietly(record, settleFromFileResult(result, { bytes: size }));
    return result;
  }

  override async renameFile(
    sourcePath: string,
    destinationPath: string,
    context: Context,
  ): Promise<Result<void, FileError>> {
    const record = await this.recordQuietly({
      kind: "file.rename",
      target: await this.tryDisplayPath(destinationPath),
      resultSummaryHint: { source: await this.tryDisplayPath(sourcePath) },
    });
    if (record?.deduped) return ok(undefined);
    const result = await super.renameFile(sourcePath, destinationPath, context);
    await this.settleQuietly(record, settleFromFileResult(result));
    return result;
  }

  override async remove(
    filePath: string,
    options: { recursive?: boolean; force?: boolean } | undefined,
    context: Context,
  ): Promise<Result<void, FileError>> {
    const record = await this.recordQuietly({ kind: "file.remove", target: await this.tryDisplayPath(filePath) });
    if (record?.deduped) return ok(undefined);
    const result = await super.remove(filePath, options, context);
    await this.settleQuietly(record, settleFromFileResult(result));
    return result;
  }

  override async createDir(
    dirPath: string,
    options: { recursive?: boolean } | undefined,
    context: Context,
  ): Promise<Result<void, FileError>> {
    const record = await this.recordQuietly({ kind: "file.mkdir", target: await this.tryDisplayPath(dirPath) });
    if (record?.deduped) return ok(undefined);
    const result = await super.createDir(dirPath, options, context);
    await this.settleQuietly(record, settleFromFileResult(result));
    return result;
  }

  override async exec(
    command: string | readonly string[],
    options: ShellExecOptions | undefined,
    context: Context,
  ): Promise<Result<ShellExecResult, ExecutionError>> {
    const display = typeof command === "string" ? command : command.map(part => /[^\w.,:/=@%-]/.test(part) ? `'${part.replace(/'/g, `'\\''`)}'` : part).join(" ");
    const record = await this.recordQuietly({ kind: "shell.exec", target: display });
    if (record?.deduped) {
      // MINOR-5：重放返回已记录的 exitCode + spillPath（大输出的真实结果位置；
      // 小输出本体在 durable transcript，不在台账重复存储——台账不是第二份主记忆）
      const summary = record.record.resultSummary ? (JSON.parse(record.record.resultSummary) as { exitCode?: number; spillPath?: string }) : {};
      return ok({ exitCode: summary.exitCode ?? 0, ...(summary.spillPath ? { spillPath: summary.spillPath } : {}) });
    }
    const result = await super.exec(command, options, context);
    if (result.ok) {
      await this.settleQuietly(record, {
        status: "succeeded",
        resultSummary: { exitCode: result.value.exitCode, ...(result.value.spillPath ? { spillPath: result.value.spillPath } : {}) },
      });
    } else {
      // 确定性停止（我们主动杀）→ interrupted（未完成是确定的，重做合法）；
      // 从未跑起来（spawn/shell 不可用）→ failed；崩溃丢失回执由开机清扫裁决为 unknown。
      const code = result.error.code;
      const verdict: SettleVerdict = code === "aborted" || code === "timeout"
        ? { status: "interrupted", error: `${code}: ${result.error.message}` }
        : { status: "failed", error: `${code}: ${result.error.message}` };
      await this.settleQuietly(record, verdict);
    }
    return result;
  }

  // ── 原子写实现 ──

  private async resolveForWrite(filePath: string, context: Context): Promise<Result<string, FileError>> {
    const resolved = await this.absolutePath(filePath, context);
    if (!resolved.ok) return resolved;
    if (context.abortSignal?.aborted) {
      return err(new FileError("aborted", "aborted before write", resolved.value));
    }
    return ok(resolved.value);
  }

  private async atomicWrite(resolvedTarget: string, content: string | Uint8Array, context: Context): Promise<void> {
    await mkdir(path.dirname(resolvedTarget), { recursive: true });
    if (context.abortSignal?.aborted) throw new FileError("aborted", "aborted before write", resolvedTarget);
    // symlink 跟随 + mode 保留：写链接指向的真实文件，不替换链接本身。
    // MINOR-3/R-1：broken symlink（realpath ENOENT）不能落到 rename 覆盖链接——回退 SDK
    // 语义（穿透链创建/覆写最终 referent），对齐 node.js env/node.js writeFile 基线；
    // 链式断链逐级 readlink 解析到最终缺失目标（深度上限防循环链）。
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
      const existingStat = await stat(target).catch(() => undefined);
      mode = existingStat ? existingStat.mode & 0o777 : undefined;
    } catch (error) {
      if (error instanceof FileError) throw error; // 链解析显式失败（循环/超深）不吞——fail-loud
      /* 全新文件，默认 mode */
    }
    const tmp = path.join(path.dirname(target), `.otter-tmp-${randomUUID()}`);
    try {
      // 新文件用 0o666（SUGG-2：与 SDK 基线一致，实际权限由 umask 决定）；已有文件保留原 mode
      await writeFile(tmp, content, { mode: mode ?? 0o666, signal: context.abortSignal });
      if (context.abortSignal?.aborted) throw new FileError("aborted", "aborted before rename", target);
      await rename(tmp, target);
    } catch (error) {
      await rm(tmp, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  // ── 台账记录（失败绝不打断真实动作） ──

  private async recordQuietly(input: {
    kind: ActionKind;
    target?: string;
    contentHash?: string;
    contentBytes?: number;
    resultSummaryHint?: Record<string, unknown>;
  }): Promise<RecordedAction | null> {
    if (!this.ledger) return null;
    try {
      const started = await this.ledger.start(this.buildStartInput(input));
      return { ...started, hint: input.resultSummaryHint };
    } catch (error) {
      this.warn?.("action ledger record failed (non-fatal)", { kind: input.kind, error: String(error) });
      return null;
    }
  }

  private buildStartInput(input: {
    kind: ActionKind;
    target?: string;
    contentHash?: string;
    contentBytes?: number;
  }): StartActionInput {
    const attribution = this.currentAttribution();
    const store = otterInvokeStorage.getStore();
    this.opSeq += 1;
    return {
      actionId: `${attribution}:${this.bootEpoch}:${this.opSeq}`,
      invokeId: store?.currentInvokeId ?? null,
      toolCallId: store?.currentToolCallId ?? null,
      source: store?.currentToolCallId ? "sdk-env" : "internal",
      conversationId: null,
      kind: input.kind,
      target: input.target,
      contentHash: input.contentHash ?? null,
      contentBytes: input.contentBytes ?? null,
    };
  }

  private async settleQuietly(recorded: RecordedAction | null, verdict: SettleVerdict): Promise<void> {
    if (!recorded || !this.ledger) return;
    try {
      const merged = recorded.hint ? { ...(verdict.resultSummary ?? {}), ...recorded.hint } : verdict.resultSummary;
      await this.ledger.settle(recorded.record.actionId, { ...verdict, resultSummary: merged });
    } catch (error) {
      this.warn?.("action ledger settle failed (non-fatal)", { actionId: recorded.record.actionId, error: String(error) });
    }
  }

  private async tryDisplayPath(filePath: string): Promise<string | undefined> {
    const resolved = await this.absolutePath(filePath, BACKGROUND_CONTEXT);
    return resolved.ok ? resolved.value : filePath;
  }

  /** 归属链（RESIDUAL-1）：toolCallId → invokeId → internal-实例标签（实例间唯一） */
  private currentAttribution(): string {
    const store = otterInvokeStorage.getStore();
    return store?.currentToolCallId ?? store?.currentInvokeId ?? `internal-${this.instanceTag}`;
  }

  private toFileError(error: unknown, fallbackPath: string): FileError {
    if (error instanceof FileError) return error;
    const nodeError = error as NodeJS.ErrnoException | undefined;
    const message = error instanceof Error ? error.message : String(error);
    const target = typeof nodeError?.path === "string" ? nodeError.path : fallbackPath;
    const code = NODE_ERROR_TO_FILE_ERROR[nodeError?.code ?? ""] ?? "unknown";
    return new FileError(code, message, target);
  }
}

function settleFromFileResult(result: Result<unknown, FileError>, extra?: Record<string, unknown>): SettleVerdict {
  if (result.ok) return { status: "succeeded", ...(extra ? { resultSummary: extra } : {}) };
  return settleFromFileError(result.error, extra);
}

function settleFromFileError(error: FileError, extra?: Record<string, unknown>): SettleVerdict {
  const summary = extra ? { resultSummary: extra } : {};
  if (error.code === "aborted") {
    return { status: "interrupted", error: error.message, ...summary };
  }
  return { status: "failed", error: `${error.code}: ${error.message}`, ...summary };
}

/** recordQuietly 返回形态：台账行 + 去重标记 + settle 时合并的提示信息 */
interface RecordedAction {
  record: ActionRecord;
  deduped: boolean;
  hint?: Record<string, unknown>;
}
