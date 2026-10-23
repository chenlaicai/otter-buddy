/**
 * F20261023ktru（#1069）：kill 族/自有项目正道指引绝对路径化锚。
 *
 * 背景：指引 `node scripts/restart-service.mjs …` 是仓根相对路径，外部项目对话
 * （colink/guangdongdianlitest 等）的獭 cwd 不在仓内，照做即 Cannot find module——
 * 2026-10-22 colink 獭 09:45Z 被拦后二拦 bounce（healing_events self_kill_nonliteral）
 * 实证「正道指引死链」。修复面：kill-block-messages 双文案 + circuit-breaker-helpers
 * appendDevServerGuidance 双分支（白名单/无白名单），全部改仓根绝对路径。
 *
 * 锚点设计：期望串独立计算（getRepoRoot + join，不引模块常量防自证），并断言
 * 脚本真实存在（可执行性）+ 相对形态不回退 + 分类锚片段不丢
 * （guard-intercept-classify.ts:44-45 指纹契约，改动需同步 classifier）。
 */
import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getRepoRoot } from "../../../src/frameworks/repo-root";
import {
  INDIRECT_KILL_BLOCK_MSG,
  PKILL_BYNAME_BLOCK_MSG,
} from "../../../src/frameworks/agent/kill-block-messages";
import { appendDevServerGuidance } from "../../../src/frameworks/agent/circuit-breaker-helpers";

const SCRIPT_ABS = join(getRepoRoot(), "scripts", "restart-service.mjs");
const EXPECTED_EXAMPLE = `node ${SCRIPT_ABS} kill-by-pid <pid> --project /abs/path`;
const RELATIVE_FORM = "node scripts/restart-service.mjs";

describe("F20261023ktru kill 族正道指引绝对路径化", () => {
  it("指引脚本是仓根绝对路径且真实存在（可执行性锚）", () => {
    expect(SCRIPT_ABS.startsWith("/")).toBe(true);
    expect(existsSync(SCRIPT_ABS)).toBe(true);
  });

  it("nonliteral 文案：kill-by-pid 指引为绝对路径完整示例，且不回退相对形态", () => {
    expect(INDIRECT_KILL_BLOCK_MSG).toContain(EXPECTED_EXAMPLE);
    expect(INDIRECT_KILL_BLOCK_MSG).not.toContain(RELATIVE_FORM);
  });

  it("pkill 文案：kill-by-pid 指引为绝对路径完整示例，且不回退相对形态", () => {
    expect(PKILL_BYNAME_BLOCK_MSG).toContain(EXPECTED_EXAMPLE);
    expect(PKILL_BYNAME_BLOCK_MSG).not.toContain(RELATIVE_FORM);
  });

  it("分类锚片段保留（guard-intercept-classify 指纹契约，改动需同步 classifier）", () => {
    expect(INDIRECT_KILL_BLOCK_MSG).toContain("终止进程的目标为变量或命令替换");
    expect(PKILL_BYNAME_BLOCK_MSG).toContain("按名匹配的批量终止命令");
  });
});

describe("F20261023ktru 自有项目 dev-server 指引绝对路径化（appendDevServerGuidance）", () => {
  it("白名单分支：脚本指引为绝对路径，不回退相对形态", () => {
    const root = mkdtempSync(join(tmpdir(), "ktru-with-"));
    mkdirSync(join(root, ".otter"), { recursive: true });
    writeFileSync(
      join(root, ".otter", "allowed-service-ports.json"),
      JSON.stringify({ services: [{ port: 31100, projectDir: "/Users/orca/ai/others/colink" }] }),
    );
    const result = appendDevServerGuidance("拦截原因", root, "lsof -ti:31100 | xargs kill");
    expect(result).toContain(EXPECTED_EXAMPLE);
    expect(result).toContain(`node ${SCRIPT_ABS} <port>`);
    expect(result).not.toContain(RELATIVE_FORM);
  });

  it("无白名单分支：脚本指引为绝对路径，不回退相对形态", () => {
    const root = mkdtempSync(join(tmpdir(), "ktru-without-"));
    const result = appendDevServerGuidance("拦截原因", root, "lsof -ti:31100 | xargs kill");
    expect(result).toContain(`node ${SCRIPT_ABS} <port> --project /abs/path --add`);
    expect(result).toContain(EXPECTED_EXAMPLE);
    expect(result).not.toContain(RELATIVE_FORM);
  });

  it("非进程操作形态不附加 dev-server 指引（#1207 命令感知回归）", () => {
    const result = appendDevServerGuidance("拦截原因", "/nonexistent-root", "cat foo.txt > bar.txt");
    expect(result).toBe("拦截原因");
  });
});
