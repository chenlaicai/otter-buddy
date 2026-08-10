/**
 * 测试 getCodingToolsForOtterType 和 getOtterToolNamesForType
 * 
 * A 类测试：验证工具列表的正确性
 */
import { describe, it, expect } from "vitest";
import { getCodingToolsForOtterType, getOtterToolNamesForType } from "@frameworks/agent/session-helpers";

describe("getCodingToolsForOtterType", () => {
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
    expect(tools).toContain("invite_participant");
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
    expect(tools).toContain("workspace_info");
    expect(tools).toContain("workspace_list");
    expect(tools).toContain("workspace_read");
    expect(tools).toContain("workspace_write");
    expect(tools).toHaveLength(25);
  });

  it("small otter 应包含消息/记忆/上下文/术语/产物/参与者/工作区工具，不含管理类工具", () => {
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
    expect(tools).toContain("workspace_info");
    expect(tools).toContain("workspace_list");
    expect(tools).toContain("workspace_read");
    expect(tools).toContain("workspace_write");
    expect(tools).toHaveLength(21);
    // 管理类工具不包含
    expect(tools).not.toContain("invite_participant");
    expect(tools).not.toContain("create_otter");
    expect(tools).not.toContain("dissolve_otter");
    expect(tools).not.toContain("manage_healing_events");
  });

  it("undefined otterType 应按 big otter 处理", () => {
    const tools = getOtterToolNamesForType(undefined);
    expect(tools).toContain("invite_participant");
    expect(tools).toContain("create_otter");
    expect(tools).toContain("dissolve_otter");
    expect(tools).toHaveLength(25);
  });
});
