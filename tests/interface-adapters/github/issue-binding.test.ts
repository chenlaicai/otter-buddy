import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkOpenIssue } from "@interface-adapters/github/issue-binding";

describe("checkOpenIssue 的真实 gh CLI 边界", () => {
  let dir: string;
  let oldPath: string | undefined;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "rhi-issue-state-"));
    oldPath = process.env.PATH;
  });
  afterEach(async () => {
    process.env.PATH = oldPath;
    await rm(dir, { recursive: true, force: true });
  });

  async function fakeGh(script: string) {
    const executable = path.join(dir, "gh");
    await writeFile(executable, script, { mode: 0o755 });
    process.env.PATH = `${dir}:${oldPath ?? ""}`;
  }

  it("OPEN 放行", async () => {
    await fakeGh("#!/bin/sh\nprintf '%s\\n' '{\"state\":\"OPEN\"}'\n");
    expect(await checkOpenIssue(1760)).toEqual({ ok: true });
  });

  it.each(["CLOSED", "MERGED", "UNKNOWN"])("%s 拒绝", async (state) => {
    await fakeGh(`#!/bin/sh\nprintf '%s\\n' '{"state":"${state}"}'\n`);
    const result = await checkOpenIssue(1319);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain(state);
  });

  it("gh 失败时拒绝，不把未知当成 OPEN", async () => {
    await fakeGh("#!/bin/sh\nprintf '%s\\n' 'not found' >&2\nexit 1\n");
    const result = await checkOpenIssue(999999);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("无法核实");
  });

  it("畸形输出时拒绝", async () => {
    await fakeGh("#!/bin/sh\nprintf '%s\\n' 'not-json'\n");
    const result = await checkOpenIssue(1760);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("无法核实");
  });

  it("无效编号不启动 gh 即可拒绝", async () => {
    process.env.PATH = dir;
    expect(await checkOpenIssue(0)).toMatchObject({ ok: false });
  });
});
