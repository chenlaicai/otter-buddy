/**
 * F20261015phys：bash 物理沙箱测试。
 *
 * 覆盖：
 * - profile 构建（单行格式、路径 realpath 解析、白名单语义、deny signal）
 * - escapeCommand 转义语义（$ / 反引号 / 引号 / 混合）
 * - 非 macOS 降级
 * - OTTER_BASH_SANDBOX=off 禁用
 * - spawnHook 包裹语义（sandbox-exec -p <profile> /bin/bash -c <cmd>）
 * - macOS 集成 smoke（真执行 wrapped 命令——发现 5 修复锚）
 */

import { describe, expect, it, vi, afterEach } from "vitest";
import { platform } from "node:os";
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";

// Mock os 模块——控制 platform() 返回值
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return {
    ...actual,
    platform: vi.fn(() => "darwin"),
    tmpdir: vi.fn(() => "/tmp"),
    homedir: vi.fn(() => "/Users/test"),
  };
});

import { buildSandboxProfile, isSandboxEnabled, probeSandboxAvailability, createSandboxSpawnHook, createSandboxedTools } from "@frameworks/agent/bash-sandbox";

describe("bash-sandbox", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe("buildSandboxProfile", () => {
    it("应生成单行 profile（空格分隔，无换行符）——检视发现 1 修复", () => {
      const profile = buildSandboxProfile("/Users/orca/ai/otter-buddy", "/Users/orca/ai/otter-buddy/data");
      expect(profile).not.toContain("\n");
      expect(profile).toContain("(version 1)");
      expect(profile).toContain("(allow default)");
      expect(profile).toContain('(deny file-write* (subpath "/Users/orca/ai/otter-buddy"))');
    });

    it("应使用 (deny signal) 而非 (deny process*)——检视发现 3 修复", () => {
      const profile = buildSandboxProfile("/Users/orca/ai/otter-buddy", "/Users/orca/ai/otter-buddy/data");
      expect(profile).toContain("(deny signal)");
      expect(profile).not.toContain("(deny process");
    });

    it("应包含白名单可写路径（workspaces/worktrees/alpha/tmp），不再包含 .git 整树 allow", async () => {
      const profile = buildSandboxProfile("/Users/orca/ai/otter-buddy", "/Users/orca/ai/otter-buddy/data");
      expect(profile).toContain('(allow file-write* (subpath "/Users/orca/ai/otter-buddy/data/workspaces"))');
      expect(profile).toContain('(allow file-write* (subpath "/Users/orca/ai/otter-buddy/.otter/worktrees"))');
      // F20261027gscv Phase 2：默认 profile 不再 allow .git 整树——Git 写能力由 spawnHook 按 envelope 派生
      expect(profile).not.toContain('(allow file-write* (subpath "/Users/orca/ai/otter-buddy/.git"))');
      expect(profile).toContain('(allow file-write* (subpath "/Users/test/.otter/alpha"))');
      // tmpdir() 的 realpath 结果依赖平台：macOS /tmp → /private/tmp，Linux /tmp 不变
      const { realpathSync } = await import("node:fs");
      const { tmpdir } = await import("node:os");
      const expectedTmp = realpathSync(tmpdir());
      expect(profile).toContain(`(allow file-write* (subpath "${expectedTmp}"))`);
    });

    it("应缓存 profile——同路径重复调用返回同一字符串", () => {
      const p1 = buildSandboxProfile("/Users/orca/ai/otter-buddy", "/Users/orca/ai/otter-buddy/data");
      const p2 = buildSandboxProfile("/Users/orca/ai/otter-buddy", "/Users/orca/ai/otter-buddy/data");
      expect(p1).toBe(p2);
    });
  });

  describe("escapeCommand（检视发现 2 修复）", () => {
    // escapeCommand 不导出——通过 createSandboxSpawnHook 间接测试
    function wrapCommand(cmd: string): string {
      const hook = createSandboxSpawnHook("/Users/orca/ai/otter-buddy", "/Users/orca/ai/otter-buddy/data");
      return hook({ command: cmd, cwd: "/tmp", env: {} }).command;
    }

    it("应转义 $（防外层 bash 命令替换/变量展开）", () => {
      const wrapped = wrapCommand("echo $HOME");
      expect(wrapped).toContain("\\$HOME");
    });

    it("应转义反引号（防外层 bash 命令替换）", () => {
      const wrapped = wrapCommand("echo `whoami`");
      expect(wrapped).toContain("\\`whoami\\`");
    });

    it("应转义双引号（JSON.stringify 语义）", () => {
      const wrapped = wrapCommand('echo "hello"');
      expect(wrapped).toContain('\\"hello\\"');
    });

    it("应处理混合危险字符（$ + 反引号 + 引号）", () => {
      const wrapped = wrapCommand('echo "$(touch /tmp/x)" && `id`');
      expect(wrapped).toContain("\\$");
      expect(wrapped).toContain("\\`");
      // $ 和 ` 被转义后不再与后面的 ( 或命令名直接相连
      expect(wrapped).not.toContain('"$(touch');
      expect(wrapped).not.toContain('"`id');
    });
  });

  describe("isSandboxEnabled", () => {
    it("macOS 默认启用", () => {
      vi.stubEnv("OTTER_BASH_SANDBOX", "");
      expect(isSandboxEnabled()).toBe(true);
    });

    it("OTTER_BASH_SANDBOX=off 禁用", () => {
      vi.stubEnv("OTTER_BASH_SANDBOX", "off");
      expect(isSandboxEnabled()).toBe(false);
    });

    it("非 macOS 禁用", async () => {
      vi.mocked(platform).mockReturnValue("linux");
      const { isSandboxEnabled: enabled } = await import("@frameworks/agent/bash-sandbox");
      expect(enabled()).toBe(false);
      vi.mocked(platform).mockReturnValue("darwin");
    });
  });

  describe("createSandboxSpawnHook", () => {
    it("应将命令包裹为 sandbox-exec -p <profile> /bin/bash -c <cmd>", () => {
      const hook = createSandboxSpawnHook("/Users/orca/ai/otter-buddy", "/Users/orca/ai/otter-buddy/data");
      const ctx = { command: "ls -la", cwd: "/tmp", env: {} };
      const result = hook(ctx);
      expect(result.command).toContain("sandbox-exec -p ");
      expect(result.command).toContain("/bin/bash -c ");
      expect(result.command).toContain('"ls -la"');
      expect(result.cwd).toBe("/tmp");
    });

    it("profile 应为单行（无换行符）", () => {
      const hook = createSandboxSpawnHook("/Users/orca/ai/otter-buddy", "/Users/orca/ai/otter-buddy/data");
      const result = hook({ command: "echo ok", cwd: "/tmp", env: {} });
      // 提取 -p 参数后的 profile 部分（JSON.stringify 包裹的字符串）
      const match = result.command.match(/sandbox-exec -p "(.+?)" \/bin\/bash/);
      expect(match).toBeTruthy();
      // profile 内不应有字面 \n（JSON.stringify 后的换行符）
      expect(match![1]).not.toContain("\\n");
    });
  });

  describe("createSandboxedTools", () => {
    it("应返回 7 个工具 + sandboxGuarded 挂载决策（F20261016gsbx R-2b）", () => {
      const { tools, sandboxGuarded } = createSandboxedTools("/tmp", "/Users/orca/ai/otter-buddy", "/Users/orca/ai/otter-buddy/data");
      expect(Object.keys(tools).sort()).toEqual(["bash", "edit", "find", "grep", "ls", "read", "write"]);
      // 挂载决策与 spawnHook 同一次探测产出——消费方（守卫退役开关）用本值禁止另行探测
      expect(sandboxGuarded).toBe(true);
    });

    it("非 macOS 时 bash 无沙箱包裹，sandboxGuarded=false（写面回位，降级不降安全）", async () => {
      vi.mocked(platform).mockReturnValue("linux");
      const { createSandboxedTools: createTools } = await import("@frameworks/agent/bash-sandbox");
      const { tools, sandboxGuarded } = createTools("/tmp", "/Users/orca/ai/otter-buddy", "/Users/orca/ai/otter-buddy/data");
      expect(tools.bash).toBeDefined();
      expect(sandboxGuarded).toBe(false);
      vi.mocked(platform).mockReturnValue("darwin");
    });
  });

  describe("probeSandboxAvailability（2a 可用性探测，R-2b 同源）", () => {
    it("macOS 默认可用", () => {
      vi.stubEnv("OTTER_BASH_SANDBOX", "");
      expect(probeSandboxAvailability("/Users/orca/ai/otter-buddy", "/Users/orca/ai/otter-buddy/data")).toBe(true);
    });

    it("OTTER_BASH_SANDBOX=off → 不可用", () => {
      vi.stubEnv("OTTER_BASH_SANDBOX", "off");
      expect(probeSandboxAvailability("/Users/orca/ai/otter-buddy", "/Users/orca/ai/otter-buddy/data")).toBe(false);
    });

    it("非 macOS → 不可用", async () => {
      vi.mocked(platform).mockReturnValue("linux");
      const { probeSandboxAvailability: probe } = await import("@frameworks/agent/bash-sandbox");
      expect(probe("/Users/orca/ai/otter-buddy", "/Users/orca/ai/otter-buddy/data")).toBe(false);
      vi.mocked(platform).mockReturnValue("darwin");
    });
  });

  describe("R-2 失败引导文案（包裹层）", () => {
    function wrap(cmd: string): string {
      const hook = createSandboxSpawnHook("/Users/orca/ai/otter-buddy", "/Users/orca/ai/otter-buddy/data");
      return hook({ command: cmd, cwd: "/tmp", env: {} }).command;
    }

    it("包裹文案含失败引导（仅失败分支输出——成功零噪音）", () => {
      const wrapped = wrap("echo hi");
      expect(wrapped).toContain("[bash-sandbox]");
      expect(wrapped).toContain("Operation not permitted");
      expect(wrapped).toContain("worktree");
      // R-2b：exit 65 附条件措辞（不单凭 65 判定沙箱失效）
      expect(wrapped).toContain("diff(1)");
    });

    it.skipIf(process.platform !== "darwin")("集成：拒写 stderr 含 worktree 引导（真执行）", () => {
      // SBPL (with message) 实测不达 stderr——引导只能在包裹层出（scratch-sbx-msg 实验归档）
      const wrapped = wrap(`echo x > /Users/orca/ai/otter-buddy/.sandbox-smoke-probe`);
      let stderr = "";
      try {
        execSync(wrapped, { encoding: "utf-8", timeout: 10000 });
      } catch (e) {
        stderr = String((e as { stderr?: string }).stderr ?? "");
      }
      expect(stderr).toContain("Operation not permitted");
      expect(stderr).toContain("[bash-sandbox]");
      expect(stderr).toContain("worktree");
    });
  });

  // macOS 集成 smoke——真执行 wrapped 命令（检视发现 5 修复锚）。
  // CI 跑 ubuntu 时自动跳过（platform mock 为 darwin 但真实平台是 linux）。
  describe("macOS 集成 smoke（真执行）", () => {
    const isMacOS = process.platform === "darwin";
    const hook = createSandboxSpawnHook("/Users/orca/ai/otter-buddy", "/Users/orca/ai/otter-buddy/data");

    it.skipIf(!isMacOS)("echo 命令在沙箱内正常执行", () => {
      const wrapped = hook({ command: "echo sandbox-alive", cwd: "/tmp", env: {} }).command;
      const output = execSync(wrapped, { encoding: "utf-8", timeout: 10000 }).trim();
      expect(output).toBe("sandbox-alive");
    });

    it.skipIf(!isMacOS)("写保护目录被 OS 拒（Operation not permitted）", () => {
      const wrapped = hook({
        command: "echo x > /Users/orca/ai/otter-buddy/.sandbox-smoke-probe",
        cwd: "/tmp",
        env: {},
      }).command;
      expect(() => execSync(wrapped, { encoding: "utf-8", timeout: 10000 })).toThrow();
    });

    it.skipIf(!isMacOS)("写白名单目录放行", () => {
      const probeFile = `/tmp/sandbox-smoke-${Date.now()}.txt`;
      const wrapped = hook({
        command: `echo ok > ${probeFile} && cat ${probeFile}`,
        cwd: "/tmp",
        env: {},
      }).command;
      const output = execSync(wrapped, { encoding: "utf-8", timeout: 10000 }).trim();
      expect(output).toBe("ok");
    });

    it.skipIf(!isMacOS)("$() 命令替换被推到内层沙箱执行（deny 域仍被保护）", () => {
      // \$ 转义语义：外层 bash 产字面 $ → 传给内层沙箱 bash → 内层看到未转义的 $(...)
      // ——命令替换在沙箱内执行。对 deny 域的写入被 OS 拒（沙箱有效），
      // 对白名单域（/tmp）的写入放行（正确行为）。
      // 检视发现 2 修复验证：逃逸从「外层无沙箱执行」闭合成「内层沙箱内执行」。
      const wrapped = hook({
        command: "echo $(touch /Users/orca/ai/otter-buddy/.escape-marker-should-not-exist)",
        cwd: "/tmp",
        env: {},
      }).command;
      execSync(wrapped, { encoding: "utf-8", timeout: 10000, shell: "/bin/bash" });
      // deny 域的 marker 不应出现——命令替换在沙箱内执行，写主仓被 OS 拒
      expect(existsSync("/Users/orca/ai/otter-buddy/.escape-marker-should-not-exist")).toBe(false);
    });
  });
});
