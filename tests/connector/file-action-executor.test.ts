import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { NodeWorkspaceGateway } from "@frameworks/file-system/node-workspace-gateway";
import { SqliteActionLedger } from "@frameworks/execution/ledger/sqlite-action-ledger";
import { FileActionExecutor } from "../../src/connector/file-action-executor";

/**
 * FileActionExecutor 真执行测试（真 NodeExecutionEnv + 真 SqliteActionLedger + 临时
 * dataRoot）——文件动作语义/台账五态/幂等/读器句柄生命周期全链。
 * 台账行（status/resultSummary/归因）为机器侧真相源断言面。
 */

async function makeExecutor(opts: { withLedger?: boolean } = {}) {
  const dataRoot = await mkdtemp(path.join(tmpdir(), "file-exec-test-"));
  const gateway = new NodeWorkspaceGateway(dataRoot);
  const ledger = opts.withLedger === false
    ? null
    : new SqliteActionLedger(path.join(dataRoot, "action-ledger.sqlite"), { deviceId: "file-test" });
  const executor = new FileActionExecutor({
    ledger,
    resolveWorkspaceRoot: conversationId => gateway.getWorkspacePath(conversationId),
    log: () => {},
  });
  const workspaceOf = (conversationId: string) => gateway.getWorkspacePath(conversationId);
  return { dataRoot, gateway, ledger, executor, workspaceOf };
}

function input(extra: Record<string, unknown>): Record<string, unknown> {
  return { conversationId: "c1", invokeId: "inv-1", toolCallId: "tool-1", ...extra };
}

describe("FileActionExecutor", () => {
  let ctx: Awaited<ReturnType<typeof makeExecutor>>;
  beforeEach(async () => {
    ctx = await makeExecutor();
  });
  afterEach(async () => {
    await ctx.executor.closeAllResources("test teardown").catch(() => {});
    ctx.ledger?.close();
    await rm(ctx.dataRoot, { recursive: true, force: true }).catch(() => {});
  });

  it("写读全链：write 落盘（父目录自动创建）+ 台账五态与 hash；read/readBinary/stat 回读", async () => {
    const write = await ctx.executor.run("file.write", input({ path: "sub/a.txt", content: "hello 文件" }), { actionId: "fw-1" });
    expect(write).toEqual({ status: "succeeded", result: null });
    // 物理落盘于设备工作区
    const physical = path.join(ctx.workspaceOf("c1"), "sub", "a.txt");
    expect(await readFile(physical, "utf8")).toBe("hello 文件");
    // 台账：kind/target/contentHash/归因/五态
    const rowWrite = await ctx.ledger!.getByActionId("fw-1");
    expect(rowWrite).toMatchObject({
      actionId: "fw-1", kind: "file.write", status: "succeeded",
      conversationId: "c1", invokeId: "inv-1", toolCallId: "tool-1",
    });
    expect(rowWrite?.target).toBe(physical);
    expect(rowWrite?.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(rowWrite?.contentBytes).toBe(Buffer.byteLength("hello 文件", "utf8"));
    expect(JSON.parse(rowWrite?.resultSummary ?? "{}")).toEqual({ bytes: Buffer.byteLength("hello 文件", "utf8") });

    const read = await ctx.executor.run("file.read", input({ path: "sub/a.txt" }), { actionId: "fr-1" });
    expect(read).toEqual({ status: "succeeded", result: "hello 文件" });
    const readBin = await ctx.executor.run("file.readBinary", input({ path: "sub/a.txt" }), { actionId: "fr-2" });
    expect(readBin.status).toBe("succeeded");
    expect(Buffer.from((readBin as { result: string }).result, "base64").toString("utf8")).toBe("hello 文件");
    const statOutcome = await ctx.executor.run("file.stat", input({ path: "sub/a.txt" }), { actionId: "fr-3" });
    expect(statOutcome.status).toBe("succeeded");
    expect((statOutcome as { result: { kind: string; size: number } }).result).toMatchObject({ kind: "file" });
    // 读类不入账
    expect(await ctx.ledger!.getByActionId("fr-1")).toBeNull();
  });

  it("base64 二进制写读字节级一致；append/truncate/rename/remove/mkdir 语义与台账 kind", async () => {
    const bytes = Buffer.from([0x00, 0xff, 0x10, 0x80, 0x61]);
    const write = await ctx.executor.run("file.write", input({ path: "bin.dat", content: bytes.toString("base64"), encoding: "base64" }), { actionId: "fb-1" });
    expect(write.status).toBe("succeeded");
    expect(new Uint8Array(await readFile(path.join(ctx.workspaceOf("c1"), "bin.dat")))).toEqual(new Uint8Array(bytes));

    await ctx.executor.run("file.write", input({ path: "t.txt", content: "abcdef" }), { actionId: "fa-0" });
    const append = await ctx.executor.run("file.append", input({ path: "t.txt", content: "gh" }), { actionId: "fa-1" });
    expect(append.status).toBe("succeeded");
    expect(await readFile(path.join(ctx.workspaceOf("c1"), "t.txt"), "utf8")).toBe("abcdefgh");
    const trunc = await ctx.executor.run("file.truncate", input({ path: "t.txt", size: 3 }), { actionId: "ft-1" });
    expect(trunc.status).toBe("succeeded");
    expect(await readFile(path.join(ctx.workspaceOf("c1"), "t.txt"), "utf8")).toBe("abc");
    // rename 与 POSIX 语义一致：不自动创建目标父目录（先 mkdir）
    await ctx.executor.run("file.mkdir", input({ path: "u" }), { actionId: "fmd-0" });
    const renamed = await ctx.executor.run("file.rename", input({ source: "t.txt", destination: "u/v.txt" }), { actionId: "frn-1" });
    expect(renamed.status).toBe("succeeded");
    expect(await readFile(path.join(ctx.workspaceOf("c1"), "u", "v.txt"), "utf8")).toBe("abc");
    const removed = await ctx.executor.run("file.remove", input({ path: "u/v.txt" }), { actionId: "frm-1" });
    expect(removed.status).toBe("succeeded");
    const mkdirOutcome = await ctx.executor.run("file.mkdir", input({ path: "d1/d2", recursive: true }), { actionId: "fmd-1" });
    expect(mkdirOutcome.status).toBe("succeeded");
    expect((await stat(path.join(ctx.workspaceOf("c1"), "d1", "d2"))).isDirectory()).toBe(true);

    const kinds = new Map<string, string>();
    for (const id of ["fa-1", "ft-1", "frn-1", "frm-1", "fmd-1"]) {
      const record = await ctx.ledger!.getByActionId(id);
      if (record) kinds.set(id, `${record.kind}:${record.status}`);
    }
    expect(kinds.get("fa-1")).toBe("file.append:succeeded");
    expect(kinds.get("ft-1")).toBe("file.truncate:succeeded");
    expect(kinds.get("frn-1")).toBe("file.rename:succeeded");
    expect(kinds.get("frm-1")).toBe("file.remove:succeeded");
    expect(kinds.get("fmd-1")).toBe("file.mkdir:succeeded");
  });

  it("幂等：同 actionId 的 write 重放不重执行（台账 deduped）", async () => {
    const first = await ctx.executor.run("file.write", input({ path: "i.txt", content: "v1" }), { actionId: "fw-dup" });
    expect(first.status).toBe("succeeded");
    // 外部改内容后重放同 actionId——deduped 直接成功，不回写
    await writeFile(path.join(ctx.workspaceOf("c1"), "i.txt"), "external");
    const replay = await ctx.executor.run("file.write", input({ path: "i.txt", content: "v2" }), { actionId: "fw-dup" });
    expect(replay).toEqual({ status: "succeeded", result: null });
    expect(await readFile(path.join(ctx.workspaceOf("c1"), "i.txt"), "utf8")).toBe("external");
  });

  it("域错误直通：not_found / is_directory / invalid 的 errorCode 与 errorPath", async () => {
    const missing = await ctx.executor.run("file.read", input({ path: "nope.txt" }), { actionId: "fe-1" });
    expect(missing).toMatchObject({ status: "failed", errorCode: "not_found" });
    await ctx.executor.run("file.write", input({ path: "plain.txt", content: "x" }), { actionId: "fe-3" });
    const listFile = await ctx.executor.run("file.list", input({ path: "plain.txt" }), { actionId: "fe-4" });
    expect(listFile.status).toBe("failed");
    expect(["not_directory", "invalid"]).toContain((listFile as { errorCode: string }).errorCode);
    const badTruncate = await ctx.executor.run("file.truncate", input({ path: "plain.txt", size: -1 }), { actionId: "fe-5" });
    expect(badTruncate).toMatchObject({ status: "failed", errorCode: "invalid" });
    // 写类失败也落台账（五态：failed + 错误摘要；plain.txt/child 的父径为文件——mkdir 报 EEXIST，与本地同语义）
    const failedWrite = await ctx.executor.run("file.write", input({ path: "plain.txt/child", content: "x" }), { actionId: "fe-6" });
    expect(failedWrite.status).toBe("failed");
    const row = await ctx.ledger!.getByActionId("fe-6");
    expect(row?.status).toBe("failed");
    expect(row?.error).toBeTruthy();
  });

  it("路径解析：joinPath/absolutePath/canonicalPath/exists/createTempDir/createTempFile", async () => {
    const joined = await ctx.executor.run("file.joinPath", input({ parts: ["/device/root", "a", "b.txt"] }), { actionId: "fp-1" });
    expect(joined).toEqual({ status: "succeeded", result: path.join("/device/root", "a", "b.txt") });
    const abs = await ctx.executor.run("file.absolutePath", input({ path: "rel/x.txt" }), { actionId: "fp-2" });
    expect(abs).toEqual({ status: "succeeded", result: path.join(ctx.workspaceOf("c1"), "rel", "x.txt") });
    await ctx.executor.run("file.write", input({ path: "real.txt", content: "x" }), { actionId: "fp-3" });
    const canonical = await ctx.executor.run("file.canonicalPath", input({ path: "real.txt" }), { actionId: "fp-4" });
    expect(canonical.status).toBe("succeeded");
    expect((canonical as { result: string }).result).toContain("real.txt");
    const existsYes = await ctx.executor.run("file.exists", input({ path: "real.txt" }), { actionId: "fp-5" });
    expect(existsYes).toEqual({ status: "succeeded", result: true });
    const existsNo = await ctx.executor.run("file.exists", input({ path: "ghost.txt" }), { actionId: "fp-6" });
    expect(existsNo).toEqual({ status: "succeeded", result: false });
    const tempDir = await ctx.executor.run("file.createTempDir", input({ prefix: "otter-test-" }), { actionId: "fp-7" });
    expect(tempDir.status).toBe("succeeded");
    expect((await stat((tempDir as { result: string }).result)).isDirectory()).toBe(true);
    await rm((tempDir as { result: string }).result, { recursive: true, force: true });
    const tempFile = await ctx.executor.run("file.createTempFile", input({ prefix: "otter-test-", suffix: ".txt" }), { actionId: "fp-8" });
    expect(tempFile.status).toBe("succeeded");
    await rm((tempFile as { result: string }).result, { force: true });
    // 路径类/读类不入账
    expect(await ctx.ledger!.getByActionId("fp-1")).toBeNull();
  });

  it("读器句柄：open→info/read/scanLines→close 全链；close 幂等；关后操作 invalid", async () => {
    await ctx.executor.run("file.write", input({ path: "reader.txt", content: "l1\nl2\nl3\n" }), { actionId: "rh-0" });
    const opened = await ctx.executor.run("file.openReader", input({ path: "reader.txt" }), { actionId: "rh-1" });
    expect(opened.status).toBe("succeeded");
    const { handle, info } = (opened as { result: { handle: string; info: { kind: string; size: number } } }).result;
    expect(info).toMatchObject({ kind: "file", size: 9 });
    const chunk = await ctx.executor.run("file.readerRead", input({ handle, position: 3, length: 3 }), { actionId: "rh-2" });
    expect(Buffer.from((chunk as { result: string }).result, "base64").toString("utf8")).toBe("l2\n");
    const scan = await ctx.executor.run("file.readerScanLines", input({ handle, startLine: 1, endLine: 3 }), { actionId: "rh-3" });
    expect(scan.status).toBe("succeeded");
    // 行区 [1,3) = "l2\nl3\n"：起始偏移 3、选中 5 字节（"l2\nl3" 解码长）
    expect(scan as { result: unknown }).toMatchObject({ result: { start: 3, selectedBytes: 5, firstLineBytes: 2 } });
    const liveInfo = await ctx.executor.run("file.readerInfo", input({ handle }), { actionId: "rh-4" });
    expect((liveInfo as { result: { size: number } }).result.size).toBe(9);
    // close 幂等
    const closed = await ctx.executor.run("file.resourceClose", input({ handle }), { actionId: "rh-5" });
    expect(closed.status).toBe("succeeded");
    const closedAgain = await ctx.executor.run("file.resourceClose", input({ handle }), { actionId: "rh-6" });
    expect(closedAgain.status).toBe("succeeded");
    // 关后读 → invalid
    const afterClose = await ctx.executor.run("file.readerRead", input({ handle, position: 0, length: 1 }), { actionId: "rh-7" });
    expect(afterClose).toMatchObject({ status: "failed", errorCode: "invalid" });
    // 未知句柄 → invalid
    const unknown = await ctx.executor.run("file.readerRead", input({ handle: "no-such", position: 0, length: 1 }), { actionId: "rh-8" });
    expect(unknown).toMatchObject({ status: "failed", errorCode: "invalid" });
    // 读器动作不入账
    expect(await ctx.ledger!.getByActionId("rh-1")).toBeNull();
  });

  it("目录读器与行读器：next 翻页到 done；readLine 到 EOF(null)", async () => {
    await ctx.executor.run("file.mkdir", input({ path: "dir" }), { actionId: "dr-0" });
    await ctx.executor.run("file.write", input({ path: "dir/a.txt", content: "aa\nbb\n" }), { actionId: "dr-1" });
    await ctx.executor.run("file.write", input({ path: "dir/b.txt", content: "cc" }), { actionId: "dr-2" });
    const openedDir = await ctx.executor.run("file.openDirReader", input({ path: "dir" }), { actionId: "dr-3" });
    const dirHandle = (openedDir as { result: { handle: string } }).result.handle;
    const names: string[] = [];
    for (;;) {
      const page = await ctx.executor.run("file.dirReaderNext", input({ handle: dirHandle, maxEntries: 1 }), { actionId: `dr-n${names.length}` });
      const { entries, done } = (page as { result: { entries: Array<{ name: string }>; done: boolean } }).result;
      names.push(...entries.map(e => e.name));
      if (done) break;
    }
    expect(names.sort()).toEqual(["a.txt", "b.txt"]);

    const openedLine = await ctx.executor.run("file.openLineReader", input({ path: "dir/a.txt" }), { actionId: "dr-4" });
    const lineHandle = (openedLine as { result: { handle: string } }).result.handle;
    const first = await ctx.executor.run("file.lineReaderRead", input({ handle: lineHandle }), { actionId: "dr-5" });
    expect((first as { result: { text: string; terminated: boolean } }).result).toEqual({ text: "aa", terminated: true });
    const second = await ctx.executor.run("file.lineReaderRead", input({ handle: lineHandle }), { actionId: "dr-6" });
    expect((second as { result: { text: string } }).result.text).toBe("bb");
    const eof = await ctx.executor.run("file.lineReaderRead", input({ handle: lineHandle }), { actionId: "dr-7" });
    expect(eof).toEqual({ status: "succeeded", result: null }); // EOF 线形化为 null
  });

  it("closeAllResources 全量关柄（会话更替/下线清理路径）", async () => {
    await ctx.executor.run("file.write", input({ path: "x.txt", content: "x" }), { actionId: "ca-0" });
    await ctx.executor.run("file.openReader", input({ path: "x.txt" }), { actionId: "ca-1" });
    await ctx.executor.run("file.openDirReader", input({ path: "." }), { actionId: "ca-2" });
    expect(ctx.executor.openHandleCount).toBe(2);
    await ctx.executor.closeAllResources("session replaced");
    expect(ctx.executor.openHandleCount).toBe(0);
  });

  it("输入校验：缺 conversationId / 缺 path / 坏 content 编码 → invalid", async () => {
    const noConv = await ctx.executor.run("file.read", { path: "x" }, { actionId: "iv-1" });
    expect(noConv).toMatchObject({ status: "failed", errorCode: "invalid" });
    const noPath = await ctx.executor.run("file.read", input({}), { actionId: "iv-2" });
    expect(noPath).toMatchObject({ status: "failed", errorCode: "invalid" });
    const badEncoding = await ctx.executor.run("file.write", input({ path: "x", content: "a", encoding: "hex" }), { actionId: "iv-3" });
    expect(badEncoding).toMatchObject({ status: "failed", errorCode: "invalid" });
  });
});
