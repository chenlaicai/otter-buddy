/**
 * connector 侧 shell.exec 执行器（协议 v2）。
 *
 * 执行底座：每动作独立 `NodeExecutionEnv`（pi-durable SDK——进程组 kill、timeout、
 * abort、spill 语义复用）+ 独立 AbortController（cancel 只杀该动作进程组）。
 * **刻意不复用 RecordingNodeExecutionEnv**：那一层经 `@earendil-works/chord` 主路径
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
    // 输入校验（协议面 fail-closed：不合法输入不产生副作用、不入账）
    const conversationId = typeof input?.conversationId === "string" ? input.conversationId : "";
    const command = input?.command;
    const commandOk = typeof command === "string"
      ? command.length > 0
      : Array.isArray(command) && command.length > 0 && command.every(part => typeof part === "string");
    if (!conversationId || !commandOk) {
      return { early: { status: "failed", errorCode: "invalid_input", error: "shell.exec requires non-empty conversationId and command" } };
    }
    // B1：conversationId → 设备工作区根（<connector dataRoot>/workspaces/<id>）；
    // 确保根存在（会话首次 shell 时工作区可能尚未落盘——与 workspace 写动作的 mkdir 语义对齐）。
    let root: string;
    try {
      root = this.deps.resolveWorkspaceRoot(conversationId);
      await mkdir(root, { recursive: true });
    } catch (error) {
      return { early: { status: "failed", errorCode: "workspace_unavailable", error: `workspace root unavailable: ${errorMessage(error)}` } };
    }
    // cwd 映射（设备侧语义——hub 下发前已完成跨机映射）：缺省/相对 → 相对设备工作区根；
    // 绝对路径显式保留（不存在的 cwd 由 SDK spawn_error 诚实回报）。
    const cwd = input.cwd === undefined ? root : path.isAbsolute(input.cwd) ? input.cwd : path.resolve(root, input.cwd);
    return { cwd, display: displayCommand(command) };
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
        source: "sdk-env", // hub 侧 SDK bash 面的远程投影——与 RecordingNodeExecutionEnv 的 exec 入账同源
        kind: "shell.exec",
        target: display,
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

/** argv 形态的展示用命令行（台账 target 用——与 RecordingNodeExecutionEnv 同规则引用） */
function displayCommand(command: string | string[]): string {
  if (typeof command === "string") return command;
  return command.map(part => (/[^\w.,:/=@%-]/.test(part) ? `'${part.replace(/'/g, `'\\''`)}'` : part)).join(" ");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 窗口化输出泵（window 模式）：只保留尾部 maxBytes/maxLines，按
 * minIntervalMs + bytesPerSecond 节流采样发帧；被砍头部累计为 skipped（UTF-8 字节/
 * 换行数/是否以换行结尾——与 SDK ShellOutputSkip 同构）挂到下一帧。
 * 无窗口时调用方直发（本类不参与）。所有计量在 UTF-8 字节域进行（Buffer），
 * 切割时跳过 UTF-8 continuation byte，不产出 U+FFFD 破字符。
 */
class WindowedOutputPump {
  private pending = Buffer.alloc(0);
  private lastStream: "stdout" | "stderr" = "stdout";
  private skippedBytes = 0;
  private skippedNewlines = 0;
  private skippedEndsWithNewline = false;
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
    this.trimToWindow();
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

  private sample(): void {
    if (this.pending.length === 0) return; // 无文本时 skipped 计数挂到下一帧（不产空帧）
    const text = this.pending.toString("utf-8");
    const stream = this.lastStream;
    const skipped = this.skippedBytes > 0
      ? { bytes: this.skippedBytes, newlines: this.skippedNewlines, endsWithNewline: this.skippedEndsWithNewline }
      : undefined;
    this.pending = Buffer.alloc(0);
    this.skippedBytes = 0;
    this.skippedNewlines = 0;
    this.skippedEndsWithNewline = false;
    this.lastSentAt = Date.now();
    this.lastSentBytes = Buffer.byteLength(text, "utf-8");
    this.emit(text, stream, skipped);
  }

  /** 砍头部到窗口内：先按行窗（保留尾部 maxLines 个换行），再按字节窗（对齐 UTF-8 边界） */
  private trimToWindow(): void {
    let buf = this.pending;
    const maxLines = Math.max(0, this.window.maxLines);
    let newlines = 0;
    for (let i = buf.length - 1; i >= 0; i--) {
      if (buf[i] === 0x0a) {
        newlines += 1;
        if (newlines > maxLines) {
          this.drop(buf.subarray(0, i + 1));
          buf = buf.subarray(i + 1);
          break;
        }
      }
    }
    const maxBytes = Math.max(1, this.window.maxBytes);
    if (buf.length > maxBytes) {
      let start = buf.length - maxBytes;
      while (start < buf.length && (buf[start]! & 0xc0) === 0x80) start += 1; // UTF-8 continuation byte 不对齐切割点
      this.drop(buf.subarray(0, start));
      buf = buf.subarray(start);
    }
    this.pending = buf;
  }

  /** 省略量累计（endsWithNewline 取最后一段被省略文本的结尾——累计省略文本的尾部语义） */
  private drop(omitted: Buffer): void {
    if (omitted.length === 0) return;
    let newlines = 0;
    for (const byte of omitted) if (byte === 0x0a) newlines += 1;
    this.skippedBytes += omitted.length;
    this.skippedNewlines += newlines;
    this.skippedEndsWithNewline = omitted[omitted.length - 1] === 0x0a;
  }
}
