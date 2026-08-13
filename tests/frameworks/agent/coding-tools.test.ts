/**
 * 测试 getCodingToolsForOtterType 和 getOtterToolNamesForType
 * 
 * A 类测试：验证工具列表的正确性
 */
import { describe, it, expect } from "vitest";
import { getCodingToolsForOtterType, getOtterToolNamesForType } from "@frameworks/agent/session-helpers";

describe("getCodingToolsForOtterType", () => {
  // Why: 函数现在返回常量数组，但测试多个输入确保没有隐藏的分支逻辑
  // 如果未来有人恢复了 otterType 分支，这些测试会捕获回归
  it("big otter 应包含全部编码工具", () => {
    const tools = getCodingToolsForOtterType("big");
    expect(tools).toContain("read");
    expect(tools).toContain("write");
    expect(tools).toContain("edit");
    expect(tools).toContain("bash");
    expect(tools).toHaveLength(4);
  });

  it("small otter 应包含全部编码工具", () => {
    const tools = getCodingToolsForOtterType("small");
    expect(tools).toContain("read");
    expect(tools).toContain("write");
    expect(tools).toContain("edit");
    expect(tools).toContain("bash");
    expect(tools).toHaveLength(4);
  });

  it("undefined otterType 应按 big otter 处理", () => {
    const tools = getCodingToolsForOtterType(undefined);
    expect(tools).toContain("read");
    expect(tools).toContain("write");
    expect(tools).toContain("edit");
    expect(tools).toContain("bash");
    expect(tools).toHaveLength(4);
  });

  it("空字符串 otterType 应按 big otter 处理", () => {
    const tools = getCodingToolsForOtterType("");
    expect(tools).toContain("read");
    expect(tools).toContain("write");
    expect(tools).toContain("edit");
    expect(tools).toContain("bash");
    expect(tools).toHaveLength(4);
  });
});

describe("getOtterToolNamesForType", () => {
  it("big otter 应包含所有工具", () => {
    const tools = getOtterToolNamesForType("big");
    expect(tools).toContain("speak");
    expect(tools).toContain("create_otter");
    expect(tools).toContain("dissolve_otter");
    expect(tools).toContain("search_memory");
    expect(tools).toContain("create_linked_resource");
    expect(tools).toContain("get_memory_detail");
    expect(tools).toContain("get_message");
    expect(tools).toContain("list_messages");
    expect(tools).toContain("search_messages");
    expect(tools).toContain("get_turn_history");
    expect(tools).toContain("get_context");
    expect(tools).toContain("set_context");
    expect(tools).toContain("delete_context");
    expect(tools).toContain("search_terminology");
    expect(tools).toContain("add_terminology");
    expect(tools).toContain("list_artifacts");
    expect(tools).toContain("update_artifact_status");
    expect(tools).toContain("get_active_participants");
    expect(tools).toContain("get_html_card_contract");
    expect(tools).toContain("manage_healing_events");
    expect(tools).toContain("create_scheduled_task");
    expect(tools).toContain("restart_otter");
    expect(tools).toContain("workspace_info");
    expect(tools).toContain("workspace_list");
    expect(tools).toContain("workspace_read");
    expect(tools).toContain("workspace_write");
    // F20260813mrel: 记忆关系层工具
    expect(tools).toContain("link_memory");
    expect(tools).toContain("get_related");
    expect(tools).toContain("unlink_memory");
    expect(tools).toHaveLength(30);
  });

  it("small otter 应包含消息/记忆/上下文/术语/产物/参与者/工作区/定时任务/自愈管理/自身重启工具，不含管理类工具", () => {
    const tools = getOtterToolNamesForType("small");
    expect(tools).toContain("speak");
    expect(tools).toContain("search_memory");
    expect(tools).toContain("create_linked_resource");
    expect(tools).toContain("get_memory_detail");
    expect(tools).toContain("get_message");
    expect(tools).toContain("list_messages");
    expect(tools).toContain("search_messages");
    expect(tools).toContain("get_turn_history");
    expect(tools).toContain("get_context");
    expect(tools).toContain("set_context");
    expect(tools).toContain("delete_context");
    expect(tools).toContain("search_terminology");
    expect(tools).toContain("add_terminology");
    expect(tools).toContain("list_artifacts");
    expect(tools).toContain("update_artifact_status");
    expect(tools).toContain("get_active_participants");
    expect(tools).toContain("get_html_card_contract");
    expect(tools).toContain("create_scheduled_task");
    expect(tools).toContain("manage_healing_events");
    expect(tools).toContain("restart_otter");
    expect(tools).toContain("workspace_info");
    expect(tools).toContain("workspace_list");
    expect(tools).toContain("workspace_read");
    expect(tools).toContain("workspace_write");
    // F20260813mrel: 记忆关系层工具（大小獭都能用）
    expect(tools).toContain("link_memory");
    expect(tools).toContain("get_related");
    expect(tools).toContain("unlink_memory");
    expect(tools).toHaveLength(28);
    // 管理类工具不包含
    expect(tools).not.toContain("create_otter");
    expect(tools).not.toContain("dissolve_otter");
  });

  it("undefined otterType 应按 big otter 处理", () => {
    const tools = getOtterToolNamesForType(undefined);
    expect(tools).toContain("create_otter");
    expect(tools).toContain("dissolve_otter");
    expect(tools).toContain("restart_otter");
    expect(tools).toHaveLength(30);
  });
});
