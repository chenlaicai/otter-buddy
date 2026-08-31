/**
 * 测试 getCodingToolsForOtterType 和 getOtterToolNamesForType
 * 
 * A 类测试：验证工具列表的正确性
 */
import { describe, it, expect } from "vitest";
import { join } from "node:path";
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
    // F20260813mren: 记忆关系层工具
    expect(tools).toContain("link_memory");
    expect(tools).toContain("get_related");
    expect(tools).toContain("unlink_memory");
    expect(tools).toContain("yield");
    expect(tools).toContain("query_dispatch_ledger");
    expect(tools).toContain("query_signals"); // F20260826mwrd C1
    expect(tools).toContain("resolve_signal"); // F20260826mwrd C2：裁决写路径（big）
    expect(tools).toHaveLength(35);
  });

  it("small otter 应包含消息/记忆/上下文/术语/产物/参与者/工作区/定时任务/自愈管理/自身重启工具，不含管理类工具", () => {
    const tools = getOtterToolNamesForType("small");
    expect(tools).toContain("speak");
    expect(tools).toContain("yield");
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
    // F20260813mren: 记忆关系层工具（大小獭都能用）
    expect(tools).toContain("link_memory");
    expect(tools).toContain("get_related");
    expect(tools).toContain("unlink_memory");
    expect(tools).toContain("query_signals"); // F20260826mwrd C1：小獭可查信号台账
    expect(tools).not.toContain("resolve_signal"); // F20260826mwrd C2：裁决仅 big
    expect(tools).toHaveLength(30);
    // halt_otter / resolve_signal 是编排/裁决动作，仅 big 型
    expect(tools).not.toContain("halt_otter");
    expect(tools).not.toContain("resolve_signal"); // F20260826mwrd C2
    // 管理类工具不包含
    expect(tools).not.toContain("create_otter");
    expect(tools).not.toContain("dissolve_otter");
  });

  // F20260827c2sg 审视处置（严重发现 1）：生产环境走 manifest 路径（pi-session-factory 传 process.cwd()），
  // 此前断言未传 projectRoot 走的是 fallback——断言面与生产面不是同一个面，隔离在生产失效。
  // 本组断言走真实 manifest（仓库根 config/tool-manifest.json），与生产同构。
  // F20260831tumv：原路径多算一级（../../../../ 落在 .claude/worktrees/ 上，无 config/ 目录），
  // 导致本组「生产路径」断言实际从未走过 manifest，一直在测 fallback（碰巧也绿）。
  // 修正为 3 级，现在真正走 worktree 根的 config/tool-manifest.json。
  it("生产路径（manifest）：small 型不得含 halt_otter/resolve_signal（编排/裁决仅 big）", () => {
    const projectRoot = join(import.meta.dirname, "../../../"); // worktree 根
    const tools = getOtterToolNamesForType("small", undefined, projectRoot);
    expect(tools).toContain("query_signals"); // 信号台账查询开放给 small
    expect(tools).toContain("stock_data"); // F20260831tumv：small 走 groups 展开，含 stock/paper 块
    expect(tools).toContain("paper_trade");
    expect(tools).not.toContain("halt_otter");
    expect(tools).not.toContain("resolve_signal");
    expect(tools).not.toContain("create_otter");
    expect(tools).not.toContain("dissolve_otter");
  });

  it("生产路径（manifest）：big 型应含编排/裁决工具", () => {
    const projectRoot = join(import.meta.dirname, "../../../"); // worktree 根
    const allToolNames = [
      "speak", "yield", "halt_otter", "resolve_signal", "query_signals",
      "create_otter", "dissolve_otter", "search_memory",
    ];
    const tools = getOtterToolNamesForType("big", allToolNames, projectRoot);
    expect(tools).toContain("halt_otter");
    expect(tools).toContain("resolve_signal");
    expect(tools).toEqual(allToolNames); // "*" 展开为全部
  });

  it("undefined otterType 应按 big otter 处理", () => {
    const tools = getOtterToolNamesForType(undefined);
    expect(tools).toContain("create_otter");
    expect(tools).toContain("dissolve_otter");
    expect(tools).toContain("restart_otter");
    expect(tools).toContain("yield");
    expect(tools).toContain("query_dispatch_ledger");
    expect(tools).toContain("query_signals"); // F20260826mwrd C1
    expect(tools).toHaveLength(35);
  });
});
