/**
 * F20261026gobs delta-r1（检视獭1646 S1 生产面）：kill 族不随 mainPid 缺失静默退役。
 *
 * 案发现场：CI（无主仓 .otter-buddy.pid）上 readMainProcessPid 返回 null → 旧口径
 * checkWhenMainPidMissing 整族保守放行 kill（#1038 记档）→ `pkill -f otter-buddy` 漏放。
 * kill 目标语义的主体（按名目标 pkill/killall、间接 PID、PID 文件引用）是纯文本语义，
 * 不依赖 PID 值——不应随 PID 文件不可读而退役；仅「字面 PID = 主 PID」等值一条需要
 * mainPid（缺失时跳过，与已知 PID 时「非主 PID 放行」同口径）。
 */
import { describe, it, expect } from "vitest";
import { checkBashCommandSafety } from "@frameworks/agent/bash-safety-guard";

const ctx = { projectRoot: "/tmp/nonexistent-guard-root", sessionCwd: "/tmp/guard-ws" };

describe("kill 族在 mainPid 缺失时不退役（S1 生产面）", () => {
  it("按名 kill（pkill -f otter-buddy）在 mainPid=null 仍拦", () => {
    const r = checkBashCommandSafety("pkill -f otter-buddy", null, undefined, ctx);
    expect(r).not.toBeNull();
  });

  it("killall node 在 mainPid=null 仍拦", () => {
    const r = checkBashCommandSafety("killall node", null, undefined, ctx);
    expect(r).not.toBeNull();
  });

  it("间接 PID 目标（kill $VAR）在 mainPid=null 仍拦", () => {
    const r = checkBashCommandSafety("kill $TARGET_PID", null, undefined, ctx);
    expect(r).not.toBeNull();
  });

  it("字面 PID kill（kill 12345）在 mainPid=null 与已知 mainPid 同口径（等值一条不可判即同非主 PID 放行）", () => {
    const withNull = checkBashCommandSafety("kill 12345", null, undefined, ctx);
    const withKnown = checkBashCommandSafety("kill 12345", 4242, undefined, ctx);
    expect(withNull).toBe(withKnown); // 同判——不因 PID 缺失产生判定分歧
  });

  it("已知 mainPid 时 kill <mainPid> 仍拦（保护零削弱）", () => {
    const r = checkBashCommandSafety("kill 4242", 4242, undefined, ctx);
    expect(r).not.toBeNull();
  });

  it("良性命令在 mainPid=null 不受影响（不误伤）", () => {
    expect(checkBashCommandSafety("git log --oneline -5", null, undefined, ctx)).toBeNull();
    expect(checkBashCommandSafety("ls -la", null, undefined, ctx)).toBeNull();
  });
});
