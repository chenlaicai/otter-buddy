/**
 * F20261015phys：bash 物理沙箱测试。
 *
 * 覆盖：
 * - profile 构建（路径 realpath 解析、白名单语义）
 * - 非 macOS 降级
 * - OTTER_BASH_SANDBOX=off 禁用
 * - spawnHook 包裹语义（sandbox-exec -p <profile> /bin/bash -c <cmd>）
 */

import { describe, expect, it, vi, afterEach } from "vitest";
import { platform } from "node:os";

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

import { buildSandboxProfile, isSandboxEnabled, createSandboxSpawnHook, createSandboxedTools } from "@frameworks/agent/bash-sandbox";

describe("bash-sandbox", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe("buildSandboxProfile", () => {
    it("应生成包含 deny file-write* 主仓的 profile", () => {
      const profile = buildSandboxProfile("/Users/orca/ai/otter-buddy", "/Users/orca/ai/otter-buddy/data");
      expect(profile).toContain("(version 1)");
      expect(profile).toContain("(allow default)");
      expect(profile).toContain('(deny file-write* (subpath "/Users/orca/ai/otter-buddy"))');
      expect(profile).toContain("(deny process*)");
    });

    it("应包含白名单可写路径（workspaces/worktrees/alpha/tmp）", () => {
      const profile = buildSandboxProfile("/Users/orca/ai/otter-buddy", "/Users/orca/ai/otter-buddy/data");
      expect(profile).toContain('(allow file-write* (subpath "/Users/orca/ai/otter-buddy/data/workspaces"))');
      expect(profile).toContain('(allow file-write* (subpath "/Users/orca/ai/otter-buddy/.otter/worktrees"))');
      expect(profile).toContain('(allow file-write* (subpath "/Users/test/.otter/alpha"))');
      // tmpdir() 返回 /tmp，但 realpathSync 解析为 /private/tmp（macOS 符号链接）
      expect(profile).toContain('(allow file-write* (subpath "/private/tmp"))');
    });

    it("应缓存 profile——同路径重复调用返回同一字符串", () => {
      const p1 = buildSandboxProfile("/Users/orca/ai/otter-buddy", "/Users/orca/ai/otter-buddy/data");
      const p2 = buildSandboxProfile("/Users/orca/ai/otter-buddy", "/Users/orca/ai/otter-buddy/data");
      expect(p1).toBe(p2);
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
      // 重新导入以应用 mock
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

    it("应正确处理含引号的命令（JSON.stringify 转义）", () => {
      const hook = createSandboxSpawnHook("/Users/orca/ai/otter-buddy", "/Users/orca/ai/otter-buddy/data");
      const ctx = { command: 'echo "hello world"', cwd: "/tmp", env: {} };
      const result = hook(ctx);
      expect(result.command).toContain('"echo \\"hello world\\""');
    });
  });

  describe("createSandboxedTools", () => {
    it("应返回 7 个工具（read/write/edit/bash/grep/find/ls）", () => {
      const tools = createSandboxedTools("/tmp", "/Users/orca/ai/otter-buddy", "/Users/orca/ai/otter-buddy/data");
      expect(Object.keys(tools).sort()).toEqual(["bash", "edit", "find", "grep", "ls", "read", "write"]);
    });

    it("非 macOS 时 bash 无沙箱包裹", async () => {
      vi.mocked(platform).mockReturnValue("linux");
      const { createSandboxedTools: createTools } = await import("@frameworks/agent/bash-sandbox");
      const tools = createTools("/tmp", "/Users/orca/ai/otter-buddy", "/Users/orca/ai/otter-buddy/data");
      expect(tools.bash).toBeDefined();
      vi.mocked(platform).mockReturnValue("darwin");
    });
  });
});
