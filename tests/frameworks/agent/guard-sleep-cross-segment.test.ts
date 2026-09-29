/**
 * #1216：sleep 拦截跨段求和的回归测试。
 *
 * 判定面：guard-model-judge judgeSleepCommand（经 checkWithModel 入口）——
 * 原逐段独立判定可被 sleep 3 && sleep 3 拆分绕过，本 PR 改命令内跨段累计。
 *
 * 生产误拦面依据（issue #1216 认领评论）：合法微 sleep 全为 kill/端口检查功能性等待，
 * 单命令累计实测最大 3s，门槛 5s 有 2s 余量。
 */
import { describe, it, expect } from "vitest";
import { checkWithModel } from "@frameworks/agent/guard-model-judge";

const MAIN_PID = 99999;

/** 命中 sleep 拦截（bash_sleep 前缀文案） */
function isSleepBlock(result: string | null): boolean {
  return result !== null && result.includes("检测到你使用了 sleep 等待");
}

describe("#1216 sleep 拦截跨段求和", () => {
  it("跨段拆分累计 ≥5s：拦（sleep 3 && sleep 3）", () => {
    expect(isSleepBlock(checkWithModel("sleep 3 && sleep 3", MAIN_PID))).toBe(true);
  });

  it("跨段拆分累计 ≥5s：拦（sleep 2 && curl -s x && sleep 3，混合段）", () => {
    expect(isSleepBlock(checkWithModel("sleep 2 && curl -s http://x && sleep 3", MAIN_PID))).toBe(true);
  });

  it("四段拆分累计 ≥5s：拦（sleep 2; sleep 1; sleep 1; sleep 1）", () => {
    expect(isSleepBlock(checkWithModel("sleep 2; sleep 1; sleep 1; sleep 1", MAIN_PID))).toBe(true);
  });

  it("段内快路径保留：单段 sleep 5 仍拦", () => {
    expect(isSleepBlock(checkWithModel("sleep 5", MAIN_PID))).toBe(true);
  });

  it("段内多参数求和保留：sleep 2 3 = 5s 拦", () => {
    expect(isSleepBlock(checkWithModel("sleep 2 3", MAIN_PID))).toBe(true);
  });

  it("合法微 sleep 不拦：kill 后功能等待（生产实测形态，累计 3s < 5s）", () => {
    expect(isSleepBlock(checkWithModel("kill 12345 2>/dev/null; sleep 2; lsof -i :3001", MAIN_PID))).toBe(false);
  });

  it("合法微 sleep 不拦：sleep 1 && sleep 2（累计 3s）", () => {
    expect(isSleepBlock(checkWithModel("sleep 1 && sleep 2", MAIN_PID))).toBe(false);
  });

  it("unparseable 段保守放行：sleep $X 不计入求和（宁漏勿误，#1126 同口径）", () => {
    // sleep $X 不可解析段放行 + sleep 3 可解析段 <5s → 整体放行
    expect(isSleepBlock(checkWithModel("sleep $X && sleep 3", MAIN_PID))).toBe(false);
  });

  it("infinity 段仍拦（跨段形态）", () => {
    expect(isSleepBlock(checkWithModel("sleep 1 && sleep infinity", MAIN_PID))).toBe(true);
  });

  it("单位换算参与跨段求和：sleep 2s && sleep 3s = 5s 拦", () => {
    expect(isSleepBlock(checkWithModel("sleep 2s && sleep 3s", MAIN_PID))).toBe(true);
  });
});
