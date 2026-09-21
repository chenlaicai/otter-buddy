/**
 * F20260921urdo 判定换轨回归：已读触发点退役清单锁——
 * 旧「滚动几何判定」机制（scheduleMarkReadIfAtBottom / handleMarkRead /
 * markReadTimerMapRef / markReadDebounceRef / onReachBottom prop）不得复活。
 * 若本测试红，说明有人把滚动几何判定加回来了（修补闭环复发）。
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));
const INDEX = path.resolve(dir, "index.tsx");
const MESSAGELIST = path.resolve(dir, "MessageList.tsx");
const CHATVIEW = path.resolve(dir, "ChatView.tsx");

describe("F20260921urdo 判定换轨：旧滚动几何判定机制已退役", () => {
  it("index.tsx 不再定义/调用旧滚动几何判定机制", () => {
    const src = fs.readFileSync(INDEX, "utf-8");
    // 去注释后检查（退役说明注释允许保留，代码复活不允许）
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    expect(code).not.toContain("scheduleMarkReadIfAtBottom");
    expect(code).not.toContain("handleMarkRead");
    expect(code).not.toContain("markReadTimerMapRef");
    expect(code).not.toContain("markReadDebounceRef");
  });

  it("index.tsx 含新判定接法（ackActiveRead + focus/visibility 监听）", () => {
    const src = fs.readFileSync(INDEX, "utf-8");
    expect(src).toContain("ackActiveRead");
    expect(src).toContain("addEventListener('focus'");
    expect(src).toContain("addEventListener('visibilitychange'");
  });

  it("MessageList/ChatView 的 onReachBottom prop 已删除", () => {
    for (const p of [MESSAGELIST, CHATVIEW]) {
      const src = fs.readFileSync(p, "utf-8");
      const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
      expect(code).not.toContain("onReachBottom");
    }
  });
});
