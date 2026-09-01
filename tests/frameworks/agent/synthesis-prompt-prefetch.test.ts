/**
 * F20260901mbfx：机械/LLM 分工边界修复测试
 *
 * 覆盖四项修复：
 * 1. §④/§⑥ 机械预取注入（prefetch 参数渲染）
 * 2. meta 行 gen N 谱系代数机械推导
 * 3. §⑤ 优先注入全量 B1-B6 渲染文本（件④一次聚合两用）
 * 4. readOnly 合成自定义工具白名单内容安全
 *
 * 断言策略（D7）：验证输出结构与内容，不绑定实现细节。
 */
import { describe, it, expect } from "vitest";
import {
  buildSynthesisPrompt,
  SYNTHESIS_READ_ONLY_TOOL_WHITELIST,
} from "@frameworks/agent/synthesis-prompt-builder";

describe("F20260901mbfx §④/⑥ 机械预取", () => {
  it("prefetch 数据注入 §④：context keys 与 active 产物逐项出现", () => {
    const prompt = buildSynthesisPrompt({
      otterName: "大獭",
      oldSessionId: "sess1234-xxxx",
      trigger: "70%阈值",
      prefetch: {
        contextKeys: ["task_status", "next_step"],
        activeArtifacts: [
          { id: "res-abcd1234efgh", resourceType: "pr", title: "边界修复 PR" },
          { id: "res-ffff8888aaaa", resourceType: "fact" },
        ],
      },
    });

    expect(prompt).toContain("otter_context keys: task_status, next_step");
    expect(prompt).toContain("pr res-abcd「边界修复 PR」");
    expect(prompt).toContain("fact res-ffff");
    expect(prompt).toContain("active 产物（2 个）");
  });

  it("prefetch 空产物时明说'无'，不留歧义", () => {
    const prompt = buildSynthesisPrompt({
      otterName: "大獭",
      oldSessionId: "sess1234-xxxx",
      trigger: "70%阈值",
      prefetch: { contextKeys: [], activeArtifacts: [] },
    });

    expect(prompt).toContain("otter_context keys: （空）");
    expect(prompt).toContain("active 产物: 无");
  });

  it("无 prefetch 时 §④ 提示可用只读工具自查", () => {
    const prompt = buildSynthesisPrompt({
      otterName: "大獭",
      oldSessionId: "sess1234-xxxx",
      trigger: "70%阈值",
    });

    expect(prompt).toContain("无预取数据，可用只读工具自查");
  });

  it("recentUserMessages 注入 §⑥：带序号、时间正序", () => {
    const prompt = buildSynthesisPrompt({
      otterName: "大獭",
      oldSessionId: "sess1234-xxxx",
      trigger: "70%阈值",
      prefetch: {
        recentUserMessages: ["先看审计报告", "修了"],
      },
    });

    expect(prompt).toContain("1. 先看审计报告");
    expect(prompt).toContain("2. 修了");
  });

  it("规则区不再指示 LLM 自行调 get_context/list_artifacts", () => {
    const prompt = buildSynthesisPrompt({
      otterName: "大獭",
      oldSessionId: "sess1234-xxxx",
      trigger: "70%阈值",
    });

    // 旧规则「使用 get_context 获取结构化工作状态」应已被机械供料指令取代
    expect(prompt).not.toContain("使用 get_context");
    expect(prompt).not.toContain("使用 list_artifacts");
    expect(prompt).toContain("机械预取数据已在下方提供");
  });
});

describe("F20260901mbfx meta 行 gen N", () => {
  it("无 lineage 时 gen1", () => {
    const prompt = buildSynthesisPrompt({
      otterName: "大獭",
      oldSessionId: "sess1234-xxxx",
      trigger: "手动",
    });

    expect(prompt).toMatch(/meta: 大獭 \| gen 1 \|/);
  });

  it("lineage 2 行时 gen3（代数 = 行数 + 1）", () => {
    const prompt = buildSynthesisPrompt({
      otterName: "大獭",
      oldSessionId: "sess1234-xxxx",
      trigger: "手动",
      lineage: "- gen1 aaaabbbb: 审计分析\n- gen2 ccccdddd: 修复实施",
    });

    expect(prompt).toMatch(/meta: 大獭 \| gen 3 \|/);
    // 谱系继承 + 追加占位
    expect(prompt).toContain("- gen1 aaaabbbb: 审计分析\n- gen2 ccccdddd: 修复实施");
    expect(prompt).toContain("- gen3 sess1234: {{一句话干了什么}}");
  });
});

describe("F20260901mbfx §⑤ 全量 B1-B6 注入", () => {
  it("有 stateInventoryText 时优先注入全量渲染文本（裁掉标题行）", () => {
    const prompt = buildSynthesisPrompt({
      otterName: "大獭",
      oldSessionId: "sess1234-xxxx",
      trigger: "70%阈值",
      stateInventoryText:
        "## 活状态盘点\n- 发言石：在大獭手中\n- 调度任务：1 个 active\n- 工作区：3 个文件\n- Healing：无 open",
    });

    // B2/B3/B5 内容对合成 LLM 可见（此前只有 B1/B6 结构化数据）
    expect(prompt).toContain("调度任务：1 个 active");
    expect(prompt).toContain("工作区：3 个文件");
    expect(prompt).toContain("Healing：无 open");
    // 标题行（含时间戳）被裁掉
    expect(prompt).not.toContain("## 活状态盘点");
  });
});

describe("F20260901mbfx readOnly 白名单内容安全", () => {
  it("白名单不含任何写操作/发言/交棒/实体管理工具", () => {
    const dangerous = [
      // 发言与交棒（聊天室副作用）
      "speak", "yield",
      // 文件写
      "write", "edit", "workspace_write",
      // bash（任意副作用）
      "bash",
      // 产物与记忆写
      "create_linked_resource", "update_artifact_status", "add_terminology",
      "create_otter", "dissolve_otter", "restart_otter", "halt_otter",
      // 上下文/调度写
      "set_context", "delete_context", "create_scheduled_task",
      // 关系写
      "link_memory", "unlink_memory",
      // 信号裁决
      "resolve_signal",
    ];
    for (const tool of dangerous) {
      expect(SYNTHESIS_READ_ONLY_TOOL_WHITELIST.has(tool)).toBe(false);
    }
  });

  it("白名单包含核心只读查询工具", () => {
    for (const tool of ["read", "get_context", "list_artifacts", "search_memory", "get_message", "get_active_participants"]) {
      expect(SYNTHESIS_READ_ONLY_TOOL_WHITELIST.has(tool)).toBe(true);
    }
  });
});
