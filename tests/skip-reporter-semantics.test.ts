import { describe, expect, it, vi } from "vitest";
import CapabilitySkipReporter from "./capability/helpers/skip-reporter";

/**
 * skip-reporter 计数语义固化测试（delta-2 审视处置，2026-09-28）。
 *
 * 语义锚点来自检视獭在 vitest 5.0.1 下的全域探针实测（5 类用例）。本测试驱动生产类直接断言，
 * 锁定的是本仓库计数语义（合成输入为固定字段组合，不能替代上游真实运行时——上游升级若改语义，
 * 需配合 golden-selftest / capability 套件的真探针复核）。位于主套件（tests/ 根，CI 执行面）。
 *
 * | 用例形态          | task.mode | options.mode | state     | 应计数 |
 * |-------------------|-----------|--------------|-----------|--------|
 * | normal            | run       | run          | passed    | 否     |
 * | it.skip           | skip      | skip         | skipped   | 是     |
 * | ctx.skip()        | skip      | run          | skipped   | 是     |
 * | it.todo           | todo      | todo         | skipped   | 否     |
 * | describe.skip 内层 | skip      | skip         | skipped   | 是     |
 */

interface ProbeCase {
  name: string;
  taskMode?: string;
  optionsMode?: string;
  state?: string;
  counted: boolean;
}

const PROBE_TABLE: ProbeCase[] = [
  { name: "normal pass", taskMode: "run", optionsMode: "run", state: "passed", counted: false },
  { name: "declared it.skip", taskMode: "skip", optionsMode: "skip", state: "skipped", counted: true },
  { name: "runtime ctx.skip()", taskMode: "skip", optionsMode: "run", state: "skipped", counted: true },
  { name: "it.todo（不是 skip，不计数）", taskMode: "todo", optionsMode: "todo", state: "skipped", counted: false },
  { name: "suite-level skip 内层用例", taskMode: "skip", optionsMode: "skip", state: "skipped", counted: true },
];

/** v6 假想：运行时私有表面 .task 被上游收掉——公开字段兜底是否仍正确 */
const V6_TABLE: ProbeCase[] = PROBE_TABLE.map((c) => ({ ...c, taskMode: undefined }));

function makeModule(cases: ProbeCase[]): Parameters<CapabilitySkipReporter["onTestRunEnd"]>[0] {
  const tests = cases.map((c) => ({
    name: c.name,
    options: c.optionsMode ? { mode: c.optionsMode } : undefined,
    result: c.state ? () => ({ state: c.state }) : undefined,
    task: c.taskMode || c.state ? { mode: c.taskMode, result: c.state ? { state: c.state } : undefined } : undefined,
  }));
  return [{ children: { allTests: () => tests } }] as never;
}

function runReporter(cases: ProbeCase[]): string {
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  try {
    new CapabilitySkipReporter().onTestRunEnd(makeModule(cases));
    return log.mock.calls.map((args) => args.join(" ")).join("\n");
  } finally {
    log.mockRestore();
  }
}

describe("skip-reporter 计数语义（vitest 5 全域探针表固化）", () => {
  it.each(PROBE_TABLE)("$name → counted=$counted", (c) => {
    const out = runReporter([c]);
    if (c.counted) {
      expect(out).toContain("SKIP REPORT: 1 个用例被跳过");
    } else {
      expect(out).not.toContain("SKIP REPORT");
      expect(out).toContain("全部用例真实执行，无跳过");
    }
  });

  it("全域混合：2 skip + 1 todo + 1 normal → 计数恰为 2", () => {
    const out = runReporter([
      PROBE_TABLE[0], // normal
      PROBE_TABLE[1], // it.skip
      PROBE_TABLE[2], // ctx.skip()
      PROBE_TABLE[3], // todo
    ]);
    expect(out).toContain("SKIP REPORT: 2 个用例被跳过");
  });

  describe("v6 回退安全网（假想 .task 运行时属性被收掉）", () => {
    it.each(V6_TABLE)("$name → counted=$counted（仅公开字段）", (c) => {
      const out = runReporter([c]);
      if (c.counted) {
        expect(out).toContain("SKIP REPORT: 1 个用例被跳过");
      } else {
        expect(out).not.toContain("SKIP REPORT");
      }
    });
  });

  it("死分支哨兵：state 值域无 \"skip\"（只有 skipped）——旧 === \"skip\" 写法若回潮，本用例提醒语义已变", () => {
    // 纯 "skip" state（无 task.mode/options.mode）在真实值域中不存在；
    // 若上游真出现该值，兜底语义按"非 skipped"处理，不计入。
    const out = runReporter([{ name: "phantom state", state: "skip", counted: false }]);
    expect(out).toContain("全部用例真实执行，无跳过");
  });
});
