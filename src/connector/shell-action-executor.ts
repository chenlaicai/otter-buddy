/**
 * connector 侧 shell.exec 执行器（协议 v2）。
 *
 * 执行底座：每动作独立 `NodeExecutionEnv`（pi-durable SDK——进程组 kill、timeout、
 * abort、spill 语义复用）+ 独立 AbortController（cancel 只杀该动作进程组）。
 * **刻意不复用中枢侧 SDK 执行环境**：那一层经 `@earendil-works/chord` 主路径
 * 进 connector 产物会破轻量闭包铁律；本模块直接用 SDK env + 既有 SqliteActionLedger
 * 记账（actionId 用 hub 下发值——去重协议本体；conversationId/invokeId 归因透传）。
 *
 * 流式输出：SDK onOutput 逐块回调 → action.output 帧实时回传（sendOutput 由会话层
 * 闭包按当前 sid 发帧）。input.window 设置时由本层做窗口化（SDK NodeExecutionEnv 1.5.0
 * 尚未实现 window——「经慢链路传输输出的环境」正是本层）：只保留尾部
 * maxBytes/maxLines，按 minIntervalMs + bytesPerSecond 节流采样，省略量经
 * action.output.skipped 精确上报；进程结算时 flush 末段（尾部完整 + 省略计数不丢）。
 *
 * 结果五态映射（与台账语义对齐）：非零 exitCode 仍 succeeded（「跑完了」是事实，
 * 退出码是数据）；aborted/timeout → interrupted + errorCode；spawn/shell 不可用等
 * 从未跑起来 → failed + errorCode；成功/失败结果均带 exitCode/spillPath（有则）。
 * spillPath 只是 connector 本机诊断路径，跨机不保证可读。
 */

import { mkdir } from "node:fs/promises";
import path from "node:path";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import type { ActionLedger } from "@usecases/ports/action-ledger";
import { readProcessStart } from "@frameworks/execution/process-identity";
import type {
  ShellExecActionInput,
  ShellExecActionResult,
  ShellOutputSkipSpec,
  ShellOutputWindowSpec,
} from "@entities/execution/connector-protocol";

/** shell.exec 执行结局（dispatcher 映射为 action.result 载荷） */
export type ShellRunOutcome =
  | { status: "succeeded"; result: ShellExecActionResult }
  | { status: "interrupted"; errorCode: string; error: string; spillPath?: string }
  | { status: "failed"; errorCode: string; error: string; spillPath?: string };

/** dispatcher 依赖的 shell 执行面（测试可 fake） */
export interface ShellExecutorLike {
  run(input: ShellExecActionInput, options: { actionId: string }): Promise<ShellRunOutcome>;
  /** 取消指定在途动作（abort → SDK 杀该命令进程组）；动作未知/已完成 → false（no-op） */
  cancel(actionId: string, reason?: string): boolean;
  /** 优雅下线：取消全部在途动作进程组 + 各 env cleanup（先杀进程，台账收尾归调用方） */
  shutdown(reason?: string): Promise<void>;
}

export interface ShellActionExecutorDeps {
  /** 本机动作台账（null = 记录降级关闭，动作照常执行） */
  ledger: ActionLedger | null;
  /** conversationId → 设备工作区根（NodeWorkspaceGateway.getWorkspacePath 语义） */
  resolveWorkspaceRoot: (conversationId: string) => string;
  /** action.output 发帧（会话层闭包按当前 sid/版本封装；本层只供载荷） */
  sendOutput: (data: { actionId: string; stream: "stdout" | "stderr"; text: string; skipped?: ShellOutputSkipSpec }) => void;
  log?: (message: string, meta?: Record<string, unknown>) => void;
}

interface InflightShell {
  controller: AbortController;
  env: NodeExecutionEnv;
}

export class ShellActionExecutor implements ShellExecutorLike {
  /** 在途动作：actionId → 独立 env + AbortController（cancel 只杀该动作进程组） */
  private readonly inflight = new Map<string, InflightShell>();
  get inflightCount(): number { return this.inflight.size; }

  constructor(private readonly deps: ShellActionExecutorDeps) {}

  async run(input: ShellExecActionInput, options: { actionId: string }): Promise<ShellRunOutcome> {
    const { actionId } = options;
    const prepared = await this.prepare(input);
    if (prepared.early) return prepared.early; // 输入校验/工作区不可用的早期 failed

    // 台账记账（actionId=hub 下发值；deduped=已 succeeded → 直接回已记录结果，不重执行）
    const started = await this.recordStart(actionId, input, prepared.display);
    if (started?.deduped) {
      const summary = started.record.resultSummary
        ? JSON.parse(started.record.resultSummary) as { exitCode?: number; spillPath?: string }
        : {};
      return {
        status: "succeeded",
        result: { exitCode: summary.exitCode ?? 0, ...(summary.spillPath ? { spillPath: summary.spillPath } : {}) },
      };
    }
    return this.executeTracked(actionId, input, prepared.cwd, started);
  }

  /** 输入校验 + 设备工作区根定位 + cwd 映射（早期 failed 结局不经台账——从未开始） */
  private async prepare(input: ShellExecActionInput): Promise<
    { early: ShellRunOutcome } | { early?: never; cwd: string; display: string }
  > {
    const valid = validateShellInput(input);
    if ("early" in valid) return valid;
    // conversationId 映射设备工作区根（<connector dataRoot>/workspaces/<id>）；
    // 确保根存在（会话首次 shell 时工作区可能尚未落盘——与 workspace 写动作的 mkdir 语义对齐）。
    let root: string;
    try {
      root = this.deps.resolveWorkspaceRoot(valid.conversationId);
      await mkdir(root, { recursive: true });
    } catch (error) {
      return { early: { status: "failed", errorCode: "workspace_unavailable", error: `workspace root unavailable: ${errorMessage(error)}` } };
    }
    // cwd 映射（设备侧语义——hub 下发前已完成跨机映射）：缺省/相对 → 相对设备工作区根；
    // 绝对路径显式保留（不存在的 cwd 由 SDK spawn_error 诚实回报）。
    const cwd = input.cwd === undefined ? root : path.isAbsolute(input.cwd) ? input.cwd : path.resolve(root, input.cwd);
    return { cwd, display: displayCommand(valid.command) };
  }

  /** 在途跟踪执行：独立 env + AbortController 进表 → exec → 结局映射；finally 清理进程组 */
  private async executeTracked(
    actionId: string,
    input: ShellExecActionInput,
    cwd: string,
    started: { record: { actionId: string; resultSummary: string | null }; deduped: boolean } | null,
  ): Promise<ShellRunOutcome> {
    const env = new NodeExecutionEnv({ cwd });
    const controller = new AbortController();
    this.inflight.set(actionId, { controller, env });
    const pump = input.window
      ? new WindowedOutputPump(input.window, (text, stream, skipped) => this.emitOutput(actionId, text, stream, skipped))
      : null;
    try {
      const result = await env.exec(input.command, {
        cwd,
        ...(input.env !== undefined ? { env: input.env } : {}),
        ...(input.inheritEnv !== undefined ? { inheritEnv: input.inheritEnv } : {}),
        ...(input.timeout !== undefined ? { timeout: input.timeout } : {}),
        onSpawn: pid => this.recordSpawnedProcess(actionId, pid),
        onOutput: (text, _context, info) => {
          // onOutput 抛出会被 SDK 记 callback_error 并杀进程——发帧失败绝不断送动作
          try {
            if (pump) pump.feed(text, info.stream);
            else this.emitOutput(actionId, text, info.stream);
          } catch (error) {
            this.deps.log?.("action.output emit failed (non-fatal)", { actionId, error: errorMessage(error) });
          }
        },
        ...(input.spill !== undefined ? { spill: input.spill } : {}),
        // window 由本层实现（SDK 1.5.0 的 NodeExecutionEnv 未实现）——不下传防省略量重复计数
      }, withAbortSignal(controller.signal, BACKGROUND_CONTEXT));
      pump?.flush(); // 末段尾部 + 省略计数必须送达（进程结算后 SDK 不再吐输出）
      return await this.settleOutcome(started, actionId, result);
    } catch (error) {
      // env.exec 契约上不抛（Result 语义）——防御性兜底：意外异常按 failed 记账回报
      pump?.flush();
      const message = errorMessage(error);
      await this.settleQuietly(started, actionId, { status: "failed", error: `unknown: ${message}` });
      return { status: "failed", errorCode: "unknown", error: message };
    } finally {
      this.inflight.delete(actionId);
      // 本动作 env 收尾：杀残留进程组成员（如持有 stdio 的后台子孙——正常完成后是 no-op）
      await env.cleanup(BACKGROUND_CONTEXT).catch(() => undefined);
    }
  }

  /** 崩溃恢复需要动作自己的 PGID，不是 connector PID。回调返回后 SDK 才接驳 stdout，
   *  因此 PGID 与启动时间都在动作输出前落账；启动时间不可用时宁可后续不回收也不猜杀。 */
  private recordSpawnedProcess(actionId: string, pgid: number): void {
    const ledger = this.deps.ledger;
    if (!ledger?.recordProcessGroup) return;
    void ledger.recordProcessGroup(actionId, { pgid, processStartedAt: null }).catch(error => {
      this.deps.log?.("action process group record failed (non-fatal)", { actionId, error: errorMessage(error) });
    });
    const processStartedAt = readProcessStart(pgid);
    if (!processStartedAt) return;
    void ledger.recordProcessGroup(actionId, { pgid, processStartedAt }).catch(error => {
      this.deps.log?.("action process start record failed (non-fatal)", { actionId, error: errorMessage(error) });
    });
  }

  /** SDK Result → 结局 + 台账裁决（五态映射的唯一点） */
  private async settleOutcome(
    started: { record: { actionId: string } } | null,
    actionId: string,
    result: Awaited<ReturnType<NodeExecutionEnv["exec"]>>,
  ): Promise<ShellRunOutcome> {
    if (result.ok) {
      const value: ShellExecActionResult = {
        exitCode: result.value.exitCode,
        ...(result.value.spillPath !== undefined ? { spillPath: result.value.spillPath } : {}),
      };
      await this.settleQuietly(started, actionId, { status: "succeeded", resultSummary: { ...value } });
      return { status: "succeeded", result: value };
    }
    const code = result.error.code;
    const spillPath = result.error.spillPath;
    // aborted/timeout = 确定性停止（我们主动杀/超时杀）→ interrupted（重做合法）；
    // spawn/shell 不可用等从未跑起来 → failed；崩溃丢失回执由开机清扫落 unknown。
    if (code === "aborted" || code === "timeout") {
      await this.settleQuietly(started, actionId, { status: "interrupted", error: `${code}: ${result.error.message}` });
      return { status: "interrupted", errorCode: code, error: result.error.message, ...(spillPath !== undefined ? { spillPath } : {}) };
    }
    await this.settleQuietly(started, actionId, { status: "failed", error: `${code}: ${result.error.message}` });
    return { status: "failed", errorCode: code, error: result.error.message, ...(spillPath !== undefined ? { spillPath } : {}) };
  }

  cancel(actionId: string, _reason?: string): boolean {
    const entry = this.inflight.get(actionId);
    if (!entry) return false;
    entry.controller.abort(); // SDK 监听 abort → 杀该命令进程组（其他动作不受影响）
    return true;
  }

  async shutdown(_reason = "connector shutting down"): Promise<void> {
    const entries = [...this.inflight.values()];
    for (const entry of entries) entry.controller.abort();
    await Promise.all(entries.map(entry => entry.env.cleanup(BACKGROUND_CONTEXT).catch(() => undefined)));
  }

  private emitOutput(actionId: string, text: string, stream: "stdout" | "stderr", skipped?: ShellOutputSkipSpec): void {
    if (text === "") return;
    this.deps.sendOutput({ actionId, stream, text, ...(skipped ? { skipped } : {}) });
  }

  /** 台账 start（失败绝不打断真实动作——记录降级语义） */
  private async recordStart(
    actionId: string,
    input: ShellExecActionInput,
    display: string,
  ): Promise<{ record: { actionId: string; resultSummary: string | null }; deduped: boolean } | null> {
    if (!this.deps.ledger) return null;
    try {
      return await this.deps.ledger.start({
        actionId,
        invokeId: typeof input.invokeId === "string" ? input.invokeId : null,
        conversationId: input.conversationId,
        toolCallId: typeof input.toolCallId === "string" ? input.toolCallId : null,
        source: "sdk-env", // hub 侧 SDK bash 面的远程投影——与中枢执行环境的 exec 入账同源
        kind: "shell.exec",
        target: display,
        pid: null,
        processStartedAt: null,
      });
    } catch (error) {
      this.deps.log?.("action ledger record failed (non-fatal)", { kind: "shell.exec", error: errorMessage(error) });
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

/** argv 形态的展示用命令行（台账 target 用——与中枢执行环境同规则引用） */
function displayCommand(command: string | string[]): string {
  if (typeof command === "string") return command;
  return command.map(part => (/[^\w.,:/=@%-]/.test(part) ? `'${part.replace(/'/g, `'\\''`)}'` : part)).join(" ");
}

/** shell.exec 输入校验（协议面 fail-closed：不合法输入不产生副作用、不入账）。
 *  空 argv 按 SDK 契约是 spawn_error（env-conformance 锚定）；缺 conversationId/坏类型才是 invalid_input */
function validateShellInput(input: ShellExecActionInput):
  | { early: ShellRunOutcome }
  | { conversationId: string; command: string | string[] } {
  const conversationId = typeof input?.conversationId === "string" ? input.conversationId : "";
  const command = input?.command;
  if (conversationId && Array.isArray(command) && command.length === 0) {
    return { early: { status: "failed", errorCode: "spawn_error", error: "shell.exec empty argv (spawn error)" } };
  }
  const commandOk = typeof command === "string"
    ? command.length > 0
    : Array.isArray(command) && command.length > 0 && command.every(part => typeof part === "string");
  if (!conversationId || !commandOk) {
    return { early: { status: "failed", errorCode: "invalid_input", error: "shell.exec requires non-empty conversationId and command" } };
  }
  return { conversationId, command };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 窗口化输出泵（window 模式）：按 minIntervalMs + bytesPerSecond 节流采样发帧；
 * 采样时 pending 超窗则省略「使剩余后缀仍严格超窗的最长前缀」，后缀连同 skipped
 * （UTF-8 字节/换行数/是否以换行结尾——与 SDK ShellOutputSkip 同构）一帧发出。
 * 契约锚点（SDK ShellOutputInfo.skipped）：带 skipped 的块必须超窗——被省略文本
 * 绝不在调用方保留尾内；块永不按窗口截断。进程结算时 flush 末段（同一逻辑）。
 * 无窗口时调用方直发（本类不参与）。计量在 UTF-8 字节域进行（Buffer），
 * 切割只在字符边界（UTF-8 lead byte 前）——不切字符即无 U+FFFD，原始字节数 =
 * 解码文本字节数（与 skipped 的解码域计量同值）。
 */
class WindowedOutputPump {
  private pending = Buffer.alloc(0);
  private lastStream: "stdout" | "stderr" = "stdout";
  private lastSentAt = Date.now(); // 首帧同样受采样闸约束（minIntervalMs 自足量起计）
  private lastSentBytes = 0;
  private timer: NodeJS.Timeout | null = null;
  private flushed = false;

  constructor(
    private readonly window: ShellOutputWindowSpec,
    private readonly emit: (text: string, stream: "stdout" | "stderr", skipped?: ShellOutputSkipSpec) => void,
  ) {}

  feed(text: string, stream: "stdout" | "stderr"): void {
    if (this.flushed || text === "") return;
    this.pending = Buffer.concat([this.pending, Buffer.from(text, "utf-8")]);
    this.lastStream = stream;
    const delay = this.gateDelayMs();
    if (delay <= 0) this.sample();
    else this.ensureTimer(delay);
  }

  /** 进程结算后末段冲刷（绕过节流闸——尾部完整性与省略计数精确性优先） */
  flush(): void {
    this.flushed = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.sample();
  }

  /** 采样闸：距上一帧 ≥ max(minIntervalMs, 上一帧字节数 / bytesPerSecond) */
  private gateDelayMs(): number {
    const paceMs = this.window.bytesPerSecond > 0 ? (this.lastSentBytes / this.window.bytesPerSecond) * 1000 : 0;
    const nextAt = this.lastSentAt + Math.max(this.window.minIntervalMs, paceMs);
    return Math.max(0, nextAt - Date.now());
  }

  private ensureTimer(delay: number): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.sample();
    }, delay);
    this.timer.unref?.();
  }

  /** 采样发帧：pending ≤ 窗口 → 全发；超窗 → 省略最长可省前缀，后缀带 skipped 发出 */
  private sample(): void {
    if (this.pending.length === 0) return;
    const { emitBuf, omitted } = splitForWindow(this.pending, this.window);
    const text = emitBuf.toString("utf-8");
    const stream = this.lastStream;
    const skipped = omitted ? skipSpecOf(omitted) : undefined;
    this.pending = Buffer.alloc(0);
    this.lastSentAt = Date.now();
    this.lastSentBytes = Buffer.byteLength(text, "utf-8");
    this.emit(text, stream, skipped);
  }
}

/** 窗口分割：超窗时省略前缀，后缀连同 skipped 一帧发出。后缀必须严格超窗
 *  （契约：带 skipped 的块 > 窗口——被省略文本绝不在调用方保留尾内）。
 *  候选起点（取最大 = 省略最多）：字节候选（maxBytes+1 后缀，字符边界后对齐）；
 *  行候选 A（maxLines+1 个完整行，行边界对齐——优先于同效的贴换行变体）；
 *  行候选 B（含第 maxLines+1 个换行的最短后缀——行数刚够时的冏底）。
 *  无合规候选（超窗但无法构造严格超窗后缀）→ 不省略全发（无 skipped 的块不受限）。 */
function splitForWindow(
  pending: Buffer,
  window: ShellOutputWindowSpec,
): { emitBuf: Buffer; omitted: Buffer | null } {
  const maxBytes = Math.max(1, window.maxBytes);
  const maxLines = Math.max(0, window.maxLines);
  const totalNewlines = countNewlines(pending);
  if (pending.length <= maxBytes && totalNewlines <= maxLines) return { emitBuf: pending, omitted: null };
  const candidates = windowSplitCandidates(pending, maxBytes, maxLines);
  if (candidates.length === 0) return { emitBuf: pending, omitted: null }; // 无合规省略 → 全发
  const start = Math.max(...candidates);
  return { emitBuf: pending.subarray(start), omitted: start > 0 ? pending.subarray(0, start) : null };
}

/** 超窗分割的候选起点集（字节/行边界/贴换行变体）；空 = 无法构造合规省略 */
function windowSplitCandidates(pending: Buffer, maxBytes: number, maxLines: number): number[] {
  const candidates: number[] = [];
  if (pending.length > maxBytes) {
    let start = pending.length - (maxBytes + 1);
    while (start > 0 && (pending[start]! & 0xc0) === 0x80) start -= 1; // 后对齐到字符边界（保足量）
    candidates.push(start);
  }
  // 行候选：从尾数第 k 个换行——起点取其后（k-1 个换行入后缀，且行边界对齐）
  const lineAligned = suffixStartAfterNthNewlineFromEnd(pending, maxLines + 2);
  if (lineAligned !== null) candidates.push(lineAligned);
  if (candidates.length === 0) {
    // 贴换行变体：后缀含第 maxLines+1 个换行（起点在该换行本身——会劈开该行，仅冏底用）
    const atNewline = suffixStartAtNewlineFromEnd(pending, maxLines + 1);
    if (atNewline !== null) candidates.push(atNewline);
  }
  return candidates;
}

function countNewlines(buf: Buffer): number {
  let count = 0;
  for (const byte of buf) if (byte === 0x0a) count += 1;
  return count;
}

/** 从尾数第 n 个换行之后的偏移（后缀含 n-1 个换行且行边界对齐）；不足 n 个换行 → null */
function suffixStartAfterNthNewlineFromEnd(buf: Buffer, n: number): number | null {
  let seen = 0;
  for (let i = buf.length - 1; i >= 0; i--) {
    if (buf[i] === 0x0a) {
      seen += 1;
      if (seen === n) return i + 1;
    }
  }
  return null;
}

/** 从尾数第 n 个换行本身的偏移（后缀含 n 个换行，首字符是换行——劈行变体）；不足 → null */
function suffixStartAtNewlineFromEnd(buf: Buffer, n: number): number | null {
  let seen = 0;
  for (let i = buf.length - 1; i >= 0; i--) {
    if (buf[i] === 0x0a) {
      seen += 1;
      if (seen === n) return i;
    }
  }
  return null;
}

/** 省略量计量（解码域：不切字符 → 原始字节数即解码字节数） */
function skipSpecOf(omitted: Buffer): ShellOutputSkipSpec {
  let newlines = 0;
  for (const byte of omitted) if (byte === 0x0a) newlines += 1;
  return { bytes: omitted.length, newlines, endsWithNewline: omitted[omitted.length - 1] === 0x0a };
}
