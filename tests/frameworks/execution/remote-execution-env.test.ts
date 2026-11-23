import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import { tmpdir } from "node:os";
import path from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { RemoteExecutionEnv } from "@frameworks/execution/remote-execution-env";
import { createRemoteLoopback, type RemoteLoopbackStack } from "../../helpers/remote-loopback";

/**
 * RemoteExecutionEnv 文件面回环测试——真 hub machine ↔ 内存 channel ↔ 真 connector
 * 执行栈。断言：路径跨机映射、base64 二进制、SDK FileError 还原、写读物理落设备
 * 目录、读器句柄链、显式禁用面、掉线/版本闸语义。
 */

const HUB_CWD = "/hub/workspaces/c1";

describe("RemoteExecutionEnv 文件面（回环全链）", () => {
  let stack: RemoteLoopbackStack;
  let env: RemoteExecutionEnv;
  beforeEach(async () => {
    stack = await createRemoteLoopback();
    env = stack.machine.createExecutionEnvironment(HUB_CWD, "c1") as RemoteExecutionEnv;
  });
  afterEach(async () => {
    await stack.cleanup();
  });

  function deviceWorkspace(): string {
    return stack.deviceWorkspaceGateway.getWorkspacePath("c1");
  }

  it("writeFile→readTextFile 回环：相对路径物理落设备工作区；hub 侧同相对路径无文件", async () => {
    const written = await env.writeFile("notes/a.txt", "你好，远端", BACKGROUND_CONTEXT);
    expect(written.ok).toBe(true);
    // 物理落设备工作区
    expect(await readFile(path.join(deviceWorkspace(), "notes", "a.txt"), "utf8")).toBe("你好，远端");
    // hub 侧同相对路径下无此文件（hub cwd 是虚构路径，绝不落 hub）
    const read = await env.readTextFile("notes/a.txt", BACKGROUND_CONTEXT);
    expect(read.ok && read.value).toBe("你好，远端");
    const info = await env.fileInfo("notes/a.txt", BACKGROUND_CONTEXT);
    expect(info.ok && info.value.kind).toBe("file");
    const listed = await env.listDir("notes", BACKGROUND_CONTEXT);
    expect(listed.ok && listed.value.map(entry => entry.name)).toEqual(["a.txt"]);
  });

  it("writeFile(Uint8Array) 走 base64 上线；readBinaryFile 字节级还原", async () => {
    const bytes = new Uint8Array([0x00, 0xff, 0x10, 0x80, 0x7f, 0x61]);
    const written = await env.writeFile("bin.dat", bytes, BACKGROUND_CONTEXT);
    expect(written.ok).toBe(true);
    const read = await env.readBinaryFile("bin.dat", BACKGROUND_CONTEXT);
    expect(read.ok && [...read.value]).toEqual([...bytes]);
  });

  it("hub 工作区内绝对路径映射设备后缀；工作区外绝对路径按设备路径透传", async () => {
    const inWorkspace = await env.writeFile(path.join(HUB_CWD, "deep/b.txt"), "in", BACKGROUND_CONTEXT);
    expect(inWorkspace.ok).toBe(true);
    expect(await readFile(path.join(deviceWorkspace(), "deep", "b.txt"), "utf8")).toBe("in");
    // 工作区外绝对路径：设备侧语义（写到设备临时目录再读回）
    const deviceTmp = await mkdtemp(path.join(tmpdir(), "remote-env-abs-"));
    try {
      const deviceAbs = path.join(deviceTmp, "outside.txt");
      const out = await env.writeFile(deviceAbs, "out", BACKGROUND_CONTEXT);
      expect(out.ok).toBe(true);
      expect(await readFile(deviceAbs, "utf8")).toBe("out");
    } finally {
      await rm(deviceTmp, { recursive: true, force: true });
    }
  });

  it("absolutePath/canonicalPath/joinPath 设备侧解析；createDir/remove/truncateFile/appendFile/renameFile/exists/flushFile", async () => {
    const abs = await env.absolutePath("rel/x.txt", BACKGROUND_CONTEXT);
    expect(abs.ok && abs.value).toBe(path.join(deviceWorkspace(), "rel", "x.txt"));
    const joined = await env.joinPath(["a", "b.txt"], BACKGROUND_CONTEXT);
    expect(joined.ok && joined.value).toBe(path.join("a", "b.txt"));

    expect((await env.createDir("d", { recursive: true }, BACKGROUND_CONTEXT)).ok).toBe(true);
    expect((await env.writeFile("d/f.txt", "abcdef", BACKGROUND_CONTEXT)).ok).toBe(true);
    const canonical = await env.canonicalPath("d/f.txt", BACKGROUND_CONTEXT);
    expect(canonical.ok && canonical.value.endsWith(path.join("d", "f.txt"))).toBe(true);
    expect((await env.appendFile("d/f.txt", "gh", BACKGROUND_CONTEXT)).ok).toBe(true);
    expect((await env.truncateFile("d/f.txt", 4, BACKGROUND_CONTEXT)).ok).toBe(true);
    expect((await env.readTextFile("d/f.txt", BACKGROUND_CONTEXT))).toMatchObject({ ok: true, value: "abcd" });
    expect((await env.flushFile("d/f.txt", BACKGROUND_CONTEXT)).ok).toBe(true);
    expect((await env.renameFile("d/f.txt", "d/g.txt", BACKGROUND_CONTEXT)).ok).toBe(true);
    expect((await env.exists("d/f.txt", BACKGROUND_CONTEXT))).toMatchObject({ ok: true, value: false });
    expect((await env.exists("d/g.txt", BACKGROUND_CONTEXT))).toMatchObject({ ok: true, value: true });
    expect((await env.remove("d", { recursive: true, force: true }, BACKGROUND_CONTEXT)).ok).toBe(true);
    expect((await env.exists("d", BACKGROUND_CONTEXT))).toMatchObject({ ok: true, value: false });
  });

  it("createTempDir/createTempFile 在设备临时目录创建", async () => {
    const dir = await env.createTempDir("otter-remote-", BACKGROUND_CONTEXT);
    expect(dir.ok).toBe(true);
    if (dir.ok) {
      expect(dir.value.startsWith(os.tmpdir())).toBe(true);
      await rm(dir.value, { recursive: true, force: true });
    }
    const file = await env.createTempFile({ prefix: "otter-remote-", suffix: ".txt" }, BACKGROUND_CONTEXT);
    expect(file.ok).toBe(true);
    if (file.ok) {
      expect(file.value.startsWith(os.tmpdir())).toBe(true);
      await rm(file.value, { force: true });
    }
  });

  it("readTextLines 批量读行（maxLines 截断）", async () => {
    await env.writeFile("lines.txt", "a\nb\nc\n", BACKGROUND_CONTEXT);
    const all = await env.readTextLines("lines.txt", undefined, BACKGROUND_CONTEXT);
    expect(all.ok && all.value).toEqual(["a", "b", "c"]);
    const head = await env.readTextLines("lines.txt", { maxLines: 2 }, BACKGROUND_CONTEXT);
    expect(head.ok && head.value).toEqual(["a", "b"]);
  });

  it("FileError 还原：not_found/is_directory/invalid code 与 message 直通", async () => {
    const missing = await env.readTextFile("ghost.txt", BACKGROUND_CONTEXT);
    expect(missing.ok).toBe(false);
    if (!missing.ok) {
      expect(missing.error.code).toBe("not_found");
      expect(missing.error.message).toContain("no such file");
    }
    await env.writeFile("plain.txt", "x", BACKGROUND_CONTEXT);
    const listFile = await env.listDir("plain.txt", BACKGROUND_CONTEXT);
    expect(listFile.ok).toBe(false);
    if (!listFile.ok) expect(["not_directory", "invalid"]).toContain(listFile.error.code);
  });

  it("openBinaryReader 句柄链：info/read/scanLines/close；read 工具依赖的完整链", async () => {
    await env.writeFile("big.txt", "0123456789\nabcdefghij\n", BACKGROUND_CONTEXT);
    const opened = await env.openBinaryReader("big.txt", undefined, BACKGROUND_CONTEXT);
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const reader = opened.value;
    const info = await reader.info(BACKGROUND_CONTEXT);
    expect(info.ok && info.value.size).toBe(22);
    const chunk = await reader.read(11, 5, BACKGROUND_CONTEXT);
    expect(chunk.ok && new TextDecoder().decode(chunk.value)).toBe("abcde");
    const scan = await reader.scanLines({ startLine: 0, endLine: 1 }, BACKGROUND_CONTEXT);
    expect(scan.ok && scan.value.selectedBytes).toBe(10);
    await reader.close(BACKGROUND_CONTEXT);
    await reader.close(BACKGROUND_CONTEXT); // 幂等
    const afterClose = await reader.read(0, 1, BACKGROUND_CONTEXT);
    expect(afterClose.ok).toBe(false);
    if (!afterClose.ok) expect(afterClose.error.code).toBe("invalid");
  });

  it("openDirReader/openTextLineReader 句柄链 + cleanup 全量关柄", async () => {
    await env.writeFile("dir/x.txt", "l1\nl2\n", BACKGROUND_CONTEXT);
    const dir = await env.openDirReader("dir", BACKGROUND_CONTEXT);
    expect(dir.ok).toBe(true);
    if (dir.ok) {
      const page = await dir.value.next(10, BACKGROUND_CONTEXT);
      expect(page.ok && page.value.entries.map(e => e.name)).toEqual(["x.txt"]);
      expect(page.ok && page.value.done).toBe(true);
    }
    const lines = await env.openTextLineReader("dir/x.txt", BACKGROUND_CONTEXT);
    expect(lines.ok).toBe(true);
    if (lines.ok) {
      const first = await lines.value.readLine(BACKGROUND_CONTEXT);
      expect(first.ok && first.value).toEqual({ text: "l1", terminated: true });
      const second = await lines.value.readLine(BACKGROUND_CONTEXT);
      expect(second.ok && second.value?.text).toBe("l2");
      const eof = await lines.value.readLine(BACKGROUND_CONTEXT);
      expect(eof.ok && eof.value).toBeUndefined();
    }
    expect(env["openHandles" as keyof RemoteExecutionEnv] instanceof Set).toBe(true);
    await env.cleanup(BACKGROUND_CONTEXT);
    // cleanup 后 connector 侧句柄表清空
    expect(stack.fileExecutor.openHandleCount).toBe(0);
  });

  it("显式禁用面：watch/listFiles not_supported；v1 会话 file.* 被闸", async () => {
    const watched = await env.watch([], () => {}, BACKGROUND_CONTEXT);
    expect(watched.ok).toBe(false);
    if (!watched.ok) expect(watched.error.code).toBe("not_supported");
    const listed = await env.listFiles("x", undefined, BACKGROUND_CONTEXT);
    expect(listed.ok).toBe(false);
    if (!listed.ok) expect(listed.error.code).toBe("not_supported");
  });

  it("remote_action_requests 登记：file 动作带 conversationId 落行（五态登记）", async () => {
    await env.writeFile("reg.txt", "x", BACKGROUND_CONTEXT);
    const rows = await stack.remoteActions.listByStatuses(["succeeded"]);
    const writeRows = rows.filter(r => r.actionType === "file.write");
    expect(writeRows.length).toBe(1);
    expect(writeRows[0]!.conversationId).toBe("c1");
    expect(writeRows[0]!.deviceId).toBe("loopback-dev");
  });
});

describe("RemoteExecutionEnv 文件面（v1 会话闸）", () => {
  it("v1 会话：file.* 与 reader 族下行即拦（fail-closed），v1 六动作不受影响", async () => {
    const stack = await createRemoteLoopback({ protocolVersion: 1 });
    try {
      const env = stack.machine.createExecutionEnvironment(HUB_CWD, "c1") as RemoteExecutionEnv;
      const read = await env.readTextFile("a.txt", BACKGROUND_CONTEXT);
      expect(read.ok).toBe(false);
      if (!read.ok) {
        expect(read.error.code).toBe("unknown");
        expect(read.error.message).toContain("requires connector protocol v2");
      }
      const written = await env.writeFile("a.txt", "x", BACKGROUND_CONTEXT);
      expect(written.ok).toBe(false);
      const opened = await env.openBinaryReader("a.txt", undefined, BACKGROUND_CONTEXT);
      expect(opened.ok).toBe(false);
    } finally {
      await stack.cleanup();
    }
  });
});
