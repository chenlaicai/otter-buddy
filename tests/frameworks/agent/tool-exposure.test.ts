/**
 * F20261008tecn（EazoTack 工具瘦身 v1）：toolExposure 打标逻辑测试。
 *
 * 断言点：
 * 1. manifest toolExposure 标 deferred 的工具 → pi ToolDefinition 带 exposure: "deferred"
 * 2. 未列出的工具 → 无 exposure 字段（pi 默认 direct，现状行为）
 * 3. 标 direct 显式值 → 也无 exposure 字段（与缺省等价，避免 SDK 端差异）
 * 4. 不传 toolExposure 参数 → 全部 direct（向后兼容）
 * 5. deferred 工具的 description 保留（tool_search BM25 索引语料，不可丢）
 */
import { describe, it, expect } from "vitest";
import { buildCustomTools, createInvokeRegister } from "@frameworks/agent/tool-builder";
import type { AgentTool, ToolContext } from "@usecases/ports/agent-tools";
import { textResponse } from "@usecases/ports/agent-tools";

function makeTools(toolExposure?: Record<string, "direct" | "deferred">) {
  return buildCustomTools({
    otterId: "test-otter",
    conversationId: "test-conv",
    allowedNames: ["speak", "add_terminology", "halt_otter"],
    register: createInvokeRegister(),
    otterToolClient: {} as never,
    createTools: (_ctx: ToolContext): AgentTool[] => [ // eslint-disable-line @typescript-eslint/no-unused-vars -- 签名要求 ctx 参数，测试不读
      {
        name: "speak",
        description: "发言工具",
        parameters: { type: "object", properties: {} },
        execute: async () => textResponse("ok"),
      },
      {
        name: "add_terminology",
        description: "术语入库：记录项目域术语定义",
        parameters: { type: "object", properties: {} },
        execute: async () => textResponse("ok"),
      },
      {
        name: "halt_otter",
        description: "对运行中小獭发出停手指令",
        parameters: { type: "object", properties: {} },
        execute: async () => textResponse("ok"),
      },
    ],
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as never,
    ...(toolExposure ? { toolExposure } : {}),
  });
}

describe("F20261008tecn: toolExposure 打标", () => {
  it("deferred 工具带 exposure 字段，direct 工具不带", () => {
    const { tools } = makeTools({
      add_terminology: "deferred",
      halt_otter: "deferred",
      speak: "direct",
    });
    const speak = tools.find(t => t.name === "speak");
    const terminology = tools.find(t => t.name === "add_terminology");
    const halt = tools.find(t => t.name === "halt_otter");
    expect(speak?.exposure).toBeUndefined();
    expect(terminology?.exposure).toBe("deferred");
    expect(halt?.exposure).toBe("deferred");
  });

  it("不传 toolExposure 时全部 direct（向后兼容）", () => {
    const { tools } = makeTools();
    for (const t of tools) {
      expect(t.exposure).toBeUndefined();
    }
  });

  it("deferred 工具的 description 保留（tool_search 索引语料）", () => {
    const { tools } = makeTools({ add_terminology: "deferred" });
    const terminology = tools.find(t => t.name === "add_terminology");
    expect(terminology?.description).toContain("术语入库");
  });

  it("exposure 不影响 execute 路径（激活后行为不变）", async () => {
    const { tools } = makeTools({ add_terminology: "deferred" });
    const terminology = tools.find(t => t.name === "add_terminology");
    const result = await terminology!.execute("call-1", {});
    const text = result.content.find(c => c.type === "text")?.text ?? "";
    expect(text).toBe("ok");
  });
});

/**
 * F20261008tecn（检视发现 2 修复）：激活集计算纯函数测试。
 * 锁死核心语义：激活集 = coding ∪ direct 自定义 ∪（有 deferred 时）tool_search，
 * deferred 永不进激活集。防 pi SDK 升级改变 _isActivatable/_isDeclarable 语义时无护栏。
 */
import { computeActiveToolNames } from "@frameworks/agent/pi-session-factory";

describe("F20261008tecn: computeActiveToolNames 激活集语义", () => {
  it("有 deferred 工具：激活集 = coding + direct 自定义 + tool_search，deferred 排除", () => {
    const custom = [
      { name: "speak" },
      { name: "add_terminology", exposure: "deferred" as const },
      { name: "halt_otter", exposure: "deferred" as const },
      { name: "search_memory" },
    ];
    const active = computeActiveToolNames(["bash", "read"], custom);
    expect(active).toEqual(["bash", "read", "speak", "search_memory", "tool_search"]);
    expect(active).not.toContain("add_terminology");
    expect(active).not.toContain("halt_otter");
  });

  it("无 deferred 工具：不注入 tool_search，行为与现状等价", () => {
    const custom = [{ name: "speak" }, { name: "search_memory" }];
    const active = computeActiveToolNames(["bash", "read"], custom);
    expect(active).toEqual(["bash", "read", "speak", "search_memory"]);
    expect(active).not.toContain("tool_search");
  });

  it("全 deferred：只剩 coding + tool_search（极端边界）", () => {
    const custom = [{ name: "add_terminology", exposure: "deferred" as const }];
    const active = computeActiveToolNames(["bash"], custom);
    expect(active).toEqual(["bash", "tool_search"]);
  });
});
