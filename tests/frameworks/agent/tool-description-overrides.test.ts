/**
 * F20260904cg77（#776）：工具描述覆写测试。
 *
 * A 类测试：验证 buildToolDescriptionOverrides 的纯函数行为——
 * 1. 覆写仅在白名单内的工具上生效
 * 2. description = 原文 + 追加文本（不替换、不快照——pi 基线变化自然带入）
 * 3. execute/parameters 等其他字段与 builtin 原样同一引用（零行为变化）
 * 4. readOnly 场景由调用方控制（不传），本模块不感知
 */
import { describe, it, expect } from "vitest";
import { buildToolDescriptionOverrides, OVERRIDABLE_TOOL_NAMES } from "@frameworks/agent/tool-description-overrides";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createBashToolDefinition, createReadToolDefinition, createGrepToolDefinition, createFindToolDefinition, createLsToolDefinition } from "@earendil-works/pi-coding-agent";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("buildToolDescriptionOverrides", () => {
  const cwd = mkdtempSync(join(tmpdir(), "tool-desc-override-"));

  function buildBase(): Record<string, ToolDefinition> {
    return {
      read: createReadToolDefinition(cwd) as unknown as ToolDefinition,
      bash: createBashToolDefinition(cwd) as unknown as ToolDefinition,
      grep: createGrepToolDefinition(cwd) as unknown as ToolDefinition,
      find: createFindToolDefinition(cwd) as unknown as ToolDefinition,
      ls: createLsToolDefinition(cwd) as unknown as ToolDefinition,
    };
  }

  it("7 工具白名单中 5 个可覆写工具均产出覆写定义", () => {
    const base = buildBase();
    const overrides = buildToolDescriptionOverrides(base, ["read", "write", "edit", "bash", "grep", "find", "ls"]);
    const names = overrides.map(o => o.name).sort();
    // write/edit 无覆写（它们的用途无歧义，不需要选择引导）
    expect(names).toEqual(["bash", "find", "grep", "ls", "read"]);
  });

  it("description 为原文追加（不替换）——pi 基线更新自然带入", () => {
    const base = buildBase();
    const overrides = buildToolDescriptionOverrides(base, ["bash"]);
    expect(overrides).toHaveLength(1);
    expect(overrides[0].description).toContain(base.bash.description);
    expect(overrides[0].description!.length).toBeGreaterThan(base.bash.description.length);
    // bash 引导必须包含核心选择规则（专用工具优先 + bash 保留场景）
    expect(overrides[0].description).toContain("grep tool");
    expect(overrides[0].description).toContain("git");
  });

  it("read/grep/find/ls 覆写各含反 bash 引导", () => {
    const base = buildBase();
    const overrides = buildToolDescriptionOverrides(base, ["read", "grep", "find", "ls"]);
    expect(overrides).toHaveLength(4);
    for (const o of overrides) {
      expect(o.description).toContain("bash");
    }
  });

  it("execute/parameters 与 builtin 同一引用（零行为变化）", () => {
    const base = buildBase();
    const overrides = buildToolDescriptionOverrides(base, ["bash", "read"]);
    for (const o of overrides) {
      // bash 覆写后 execute 是包装函数（F20260922scwd 感知对齐），不再同一引用
      if (o.name === "bash") {
        expect(o.execute).not.toBe(base.bash.execute);
        expect(o.parameters).toBe(base.bash.parameters);
      } else {
        expect(o.execute).toBe(base[o.name].execute);
        expect(o.parameters).toBe(base[o.name].parameters);
      }
    }
  });

  it("bash 覆写注入 [cwd:...] 前缀（F20260922scwd 感知对齐）", async () => {
    const base = buildBase();
    const overrides = buildToolDescriptionOverrides(base, ["bash"], cwd);
    expect(overrides).toHaveLength(1);
    const bashOverride = overrides[0];
    // 描述含无状态架构声明
    expect(bashOverride.description).toContain("independent shell");
    expect(bashOverride.description).toContain("cd` does NOT persist");
    // execute 包装后输出含 [cwd:...] 前缀
    const result = await bashOverride.execute("test-call", { command: "pwd" }, undefined, undefined, undefined as never);
    expect(result.content[0].type).toBe("text");
    const text = (result.content[0] as { type: "text"; text: string }).text;
    expect(text).toMatch(/^\[cwd: .+\]\n/);
    expect(text).toContain(cwd);
  });

  it("bash 覆写错误路径也注入 [cwd:...] 前缀（失败命令需要知道在哪跑的）", async () => {
    const base = buildBase();
    const overrides = buildToolDescriptionOverrides(base, ["bash"], cwd);
    const bashOverride = overrides[0];
    await expect(
      bashOverride.execute("test-call", { command: "exit 42" }, undefined, undefined, undefined as never)
    ).rejects.toThrow(/^\[cwd: .+\]\n/);
  });

  it("无 sessionCwd 时 bash 覆写退化为纯描述覆写（向后兼容）", () => {
    const base = buildBase();
    const overrides = buildToolDescriptionOverrides(base, ["bash"]);
    expect(overrides).toHaveLength(1);
    expect(overrides[0].execute).toBe(base.bash.execute);
    expect(overrides[0].description).not.toContain("independent shell");
  });

  it("白名单外的工具名不产出覆写", () => {
    const base = buildBase();
    const overrides = buildToolDescriptionOverrides(base, ["write", "edit", "speak"]);
    expect(overrides).toHaveLength(0);
  });

  it("OVERRIDABLE_TOOL_NAMES 与实现一致", () => {
    expect(OVERRIDABLE_TOOL_NAMES.sort()).toEqual(["bash", "find", "grep", "ls", "read"]);
  });
});
