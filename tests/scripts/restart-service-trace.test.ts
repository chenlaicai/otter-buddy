/**
 * F20261023ktru（#1069）：restart-service.mjs 执行级使用痕迹单测。
 *
 * 背景：issue #1069 验证断言②「restart-service.mjs 至少被使用 1 次」无执行级数据源
 * （regression-verify 2026-10-23 到期回查判「无法判定」的缺口：无运行日志表）。
 * traceUsage 落 append-only JSONL（data/metrics/restart-service-usage.jsonl），
 * 成功/拒绝双通道留痕——「正道走了但被拒」正是死链的自动取证通道
 * （2026-10-22 colink 现场只能事后人工回查）。写失败静默：留痕是可观测性副产物，
 * 不得反过来让受控终止更脆。
 */
import { afterAll, describe, expect, it } from "vitest";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { traceUsage } from "../../scripts/restart-service.mjs";

const tmpRoot = join(tmpdir(), `restart-service-trace-${process.pid}`);

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("F20261023ktru traceUsage 执行留痕", () => {
  it("写一行 JSONL（ts/action/outcome 字段齐），目录不存在自动创建", () => {
    const tracePath = join(tmpRoot, "nested", "usage.jsonl");
    traceUsage({ action: "kill-by-pid", outcome: "killed", pid: 4242 }, tracePath);
    expect(existsSync(tracePath)).toBe(true);
    const rec = JSON.parse(readFileSync(tracePath, "utf-8").trim());
    expect(rec.action).toBe("kill-by-pid");
    expect(rec.outcome).toBe("killed");
    expect(rec.pid).toBe(4242);
    expect(typeof rec.ts).toBe("string");
  });

  it("append-only：多次调用追加不覆盖", () => {
    const tracePath = join(tmpRoot, "append.jsonl");
    traceUsage({ action: "kill-by-pid", outcome: "rejected" }, tracePath);
    traceUsage({ action: "restart-port", outcome: "killed" }, tracePath);
    const lines = readFileSync(tracePath, "utf-8").trim().split("\n");
    expect(lines).toHaveLength(2);
  });

  it("写失败静默不抛（留痕不得反噬受控终止主流程）", () => {
    expect(() => traceUsage({ action: "x", outcome: "killed" }, "/dev/null/impossible/usage.jsonl")).not.toThrow();
  });
});
