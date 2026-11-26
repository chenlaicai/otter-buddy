import { closeSync, fstatSync, mkdirSync, openSync, write } from "node:fs";
import os from "node:os";
import path from "node:path";

export type ConnectorLogWriter = (
  fd: number,
  data: string,
  callback: (error: NodeJS.ErrnoException | null) => void,
) => void;

export interface ConnectorLoggerDeps {
  /** 打开日志文件（truncate=true 时截断），返回 fd */
  openFile?: (path: string, truncate: boolean) => number;
  /** 异步追加写（默认 fs.write——本地文件不反压；队列仍有界防慢盘堆积） */
  writeFn?: ConnectorLogWriter;
  /** 当前文件大小（字节），用于启动截断判定 */
  fileSize?: (fd: number) => number;
  /** 关闭文件（截断轮转用） */
  closeFile?: (fd: number) => void;
}

/** 单文件上限：超过即启动时截断（运行中不轮转——单实例日均 MB 级，够用且零维护面） */
export const CONNECTOR_LOG_MAX_BYTES = 5 * 1024 * 1024;

/** 日志文件与 device.json/instance.lock 同目录（~/.otter/connector/） */
export function connectorLogFilePath(): string {
  return path.join(os.homedir(), ".otter", "connector", "connector.log");
}

const defaultOpen = (p: string, truncate: boolean): number => {
  mkdirSync(path.dirname(p), { recursive: true }); // 目录缺失（logger 早于 instance-lock 初始化）自建
  return openSync(p, truncate ? "w" : "a");
};
const defaultWriter: ConnectorLogWriter = (fd, data, callback) => {
  write(fd, data, error => callback(error));
};

/**
 * 运行日志写文件而非 stdout——根因（实验五连 + sample 栈）：
 * stdout 接无人消费的 PTY 时 write 必卡内核（macOS TTY 对 O_NONBLOCK 不保证 EAGAIN），
 * 同步写卡主循环（原始冻结形态），fs.write 异步则把卡转移到 libuv 线程池，
 * process.exit() 卡 uv__threadpool_cleanup 等线程池排空 → 优雅退出失败被看门狗 SIGKILL。
 * 唯一治本路是让日志目的地本身不是反压源：本地文件。
 * 单在途 + 单 pending 仍是有界降级契约：防慢盘堆积；写错误（ENOSPC/EIO）永久停用——
 * 宁可无日志不冻结主循环。构造/打开失败同样停用（日志打不开不该挡设备上线）。
 */
export class ConnectorLogger {
  private active = false;
  private pending: string | null = null;
  private dropped = 0;
  private isDisabled = false;
  private fd: number | null = null;

  constructor(
    private readonly filePath: string,
    private readonly deps: ConnectorLoggerDeps = {},
  ) {
    const openFile = deps.openFile ?? defaultOpen;
    const fileSize = deps.fileSize ?? (fd => fstatSync(fd).size);
    const closeFile = deps.closeFile ?? closeSync;
    try {
      this.fd = openFile(filePath, false);
      if (fileSize(this.fd) > CONNECTOR_LOG_MAX_BYTES) {
        closeFile(this.fd);
        this.fd = openFile(filePath, true);
      }
    } catch {
      this.isDisabled = true; // 文件打不开（权限/磁盘）：宁无日志不冻结
      this.fd = null;
    }
  }

  get pendingCount(): number { return this.pending === null ? 0 : 1; }
  get droppedCount(): number { return this.dropped; }
  get disabled(): boolean { return this.isDisabled; }
  get logFilePath(): string { return this.filePath; }

  log(message: string, meta?: Record<string, unknown>): void {
    this.enqueue(formatLine(message, meta));
  }

  private enqueue(line: string): void {
    if (this.isDisabled || this.fd === null) return;
    if (this.active) {
      if (this.pending !== null) this.dropped += 1;
      this.pending = line;
      return;
    }
    this.active = true;
    const fd = this.fd;
    (this.deps.writeFn ?? defaultWriter)(fd, line, error => {
      this.active = false;
      if (error) {
        // EIO/ENOSPC 等都不能拖死业务；错误后停用，避免快速失败形成重试风暴。
        this.isDisabled = true;
        this.pending = null;
        this.dropped = 0;
        return;
      }
      const latest = this.pending;
      this.pending = null;
      if (this.dropped > 0) {
        const summary = formatLine("file logger backpressure dropped log lines", { dropped: this.dropped });
        this.dropped = 0;
        this.enqueue(summary + (latest ?? ""));
      } else if (latest !== null) {
        this.enqueue(latest);
      }
    });
  }
}

function formatLine(message: string, meta?: Record<string, unknown>): string {
  return `${JSON.stringify({ ts: new Date().toISOString(), msg: message, ...meta })}\n`;
}
