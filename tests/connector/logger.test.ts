import { describe, expect, it, vi } from "vitest";
import { ConnectorLogger, CONNECTOR_LOG_MAX_BYTES, type ConnectorLoggerDeps } from "../../src/connector/logger";

vi.setConfig({ testTimeout: 20_000 });

type PendingWrite = { data: string; callback: (error: NodeJS.ErrnoException | null) => void };

function makeBlockedWriter() {
  const writes: PendingWrite[] = [];
  const writeFn: ConnectorLoggerDeps["writeFn"] = (_fd, data, callback) => {
    writes.push({ data, callback });
  };
  return { writes, writeFn };
}

/** 固定 fake 文件层：open 记录 truncate 形态，size 可控 */
function makeFakeFileLayer(initialSize = 0) {
  const opens: { truncate: boolean }[] = [];
  let closed = 0;
  let size = initialSize;
  const deps: ConnectorLoggerDeps = {
    openFile: (_path, truncate) => {
      opens.push({ truncate });
      if (truncate) size = 0;
      return 7;
    },
    fileSize: () => size,
    closeFile: () => { closed += 1; },
  };
  return { deps, opens, sizeRef: { get: () => size }, closeCount: () => closed };
}

describe("ConnectorLogger", () => {
  it("目的地是日志文件（构造即打开，stdout 不再承载运行日志）", () => {
    const { writeFn } = makeBlockedWriter();
    const { deps, opens } = makeFakeFileLayer();
    const logger = new ConnectorLogger("/tmp/fake/connector.log", { ...deps, writeFn });
    logger.log("first");
    expect(opens).toEqual([{ truncate: false }]);
    expect(logger.logFilePath).toBe("/tmp/fake/connector.log");
    expect(logger.pendingCount).toBe(0); // 首条直接在途，无 pending 积压
  });

  it("启动时文件超上限则截断重开（close + truncate open）", () => {
    const { writeFn } = makeBlockedWriter();
    const { deps, opens, closeCount } = makeFakeFileLayer(CONNECTOR_LOG_MAX_BYTES + 1);
    new ConnectorLogger("/tmp/fake/connector.log", { ...deps, writeFn });
    expect(closeCount()).toBe(1);
    expect(opens).toEqual([{ truncate: false }, { truncate: true }]);
  });

  it("文件打不开（权限/磁盘）时停用且不抛错——日志不可用不挡设备上线", () => {
    const deps: ConnectorLoggerDeps = {
      openFile: () => { throw Object.assign(new Error("EACCES"), { code: "EACCES" }); },
    };
    const logger = new ConnectorLogger("/root/forbidden/connector.log", deps);
    expect(() => logger.log("nope")).not.toThrow();
    expect(logger.disabled).toBe(true);
  });

  it("写入期间只有一项在途写和一条最新 pending，丢行计数有界且准确", () => {
    const { writes, writeFn } = makeBlockedWriter();
    const { deps } = makeFakeFileLayer();
    const logger = new ConnectorLogger("/tmp/fake/connector.log", { ...deps, writeFn });
    logger.log("first");
    for (let i = 0; i < 1_000; i += 1) logger.log("flood", { i });
    expect(writes).toHaveLength(1);
    expect(logger.pendingCount).toBe(1);
    expect(logger.droppedCount).toBe(999);
    expect(JSON.parse(writes[0]!.data).msg).toBe("first");
  });

  it("排水后输出丢弃汇总与最后一条日志，不追补整个离线队列", () => {
    const { writes, writeFn } = makeBlockedWriter();
    const { deps } = makeFakeFileLayer();
    const logger = new ConnectorLogger("/tmp/fake/connector.log", { ...deps, writeFn });
    logger.log("first");
    logger.log("old-pending");
    logger.log("latest", { value: 42 });
    writes[0]!.callback(null);
    expect(writes).toHaveLength(2);
    const lines = writes[1]!.data.trim().split("\n").map(line => JSON.parse(line) as { msg: string; dropped?: number; value?: number });
    expect(lines[0]).toMatchObject({ msg: "file logger backpressure dropped log lines", dropped: 1 });
    expect(lines[1]).toMatchObject({ msg: "latest", value: 42 });
    expect(logger.pendingCount).toBe(0);
    expect(logger.droppedCount).toBe(0);
  });

  it("文件写错误后永久停用该日志面，不形成错误重试风暴", () => {
    const { writes, writeFn } = makeBlockedWriter();
    const { deps } = makeFakeFileLayer();
    const logger = new ConnectorLogger("/tmp/fake/connector.log", { ...deps, writeFn });
    logger.log("first");
    logger.log("queued");
    const error = Object.assign(new Error("ENOSPC"), { code: "ENOSPC" });
    writes[0]!.callback(error);
    logger.log("after-error");
    expect(writes).toHaveLength(1);
    expect(logger.disabled).toBe(true);
    expect(logger.pendingCount).toBe(0);
  });
});
