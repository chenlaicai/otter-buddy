/**
 * F20261013cwsp：resolveSessionCwd 纯函数单测（V1 验证项）。
 *
 * 锁定语义：
 * ① 有 conversationId → data/workspaces/<conversationId>
 * ② 无 conversationId（reset/handoff/定时任务）→ data/workspaces/_system 兜底
 * ③ 目录不存在时 mkdir -p（SDK bash.js:57 对不存在 cwd 抛错）
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { resolveSessionCwd } from "@frameworks/agent/session-cwd-resolver";

describe("resolveSessionCwd（F20261013cwsp）", () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cwsp-data-"));
  });

  afterEach(() => {
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it("有 conversationId → workspaces/<id>，目录被预创建", () => {
    const cwd = resolveSessionCwd("conv-123", dataDir);
    expect(cwd).toBe(path.join(dataDir, "workspaces", "conv-123"));
    expect(fs.existsSync(cwd)).toBe(true);
  });

  it("空 conversationId → _system 兜底目录", () => {
    const cwd = resolveSessionCwd("", dataDir);
    expect(cwd).toBe(path.join(dataDir, "workspaces", "_system"));
    expect(fs.existsSync(cwd)).toBe(true);
  });

  it("幂等：重复调用返回同一路径不抛错（mkdir recursive）", () => {
    const a = resolveSessionCwd("conv-x", dataDir);
    const b = resolveSessionCwd("conv-x", dataDir);
    expect(a).toBe(b);
  });
});
