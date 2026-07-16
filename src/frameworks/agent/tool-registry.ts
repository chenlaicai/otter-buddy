/** Otter 工具配置（按 Otter 类型配置工具可见性） */
export interface OtterToolConfig {
  otterType: string;
  activeToolNames: string[];
}

/** AgentTool 最小类型（pi-agent-core 的 TTool，frameworks 层不重新定义完整类型） */
export interface TTool {
  name?: string;
  id?: string;
  [key: string]: unknown;
}

/**
 * AgentTool 注册表。
 * 所有工具统一注册，每个 Otter 类型有不同的 activeToolNames 子集。
 * 运行时通过 harness.setActiveTools() 动态切换。
 */
export class ToolRegistry {
  private readonly tools = new Map<string, TTool>();
  private readonly otterToolConfigs = new Map<string, OtterToolConfig>();

  /** 注册工具到全局工具池 */
  register(tool: TTool): void {
    const key = tool.name ?? tool.id;
    if (key === undefined) {
      throw new Error("Tool must have a name or id");
    }
    this.tools.set(key, tool);
  }

  /** 注销工具（使用与 register 相同的键计算逻辑） */
  unregister(tool: TTool): void {
    const key = tool.name ?? tool.id;
    if (key !== undefined) {
      this.tools.delete(key);
    }
  }

  /** 配置 Otter 类型的工具可见性 */
  configureOtterTools(config: OtterToolConfig): void {
    this.otterToolConfigs.set(config.otterType, config);
  }

  /** 获取该 Otter 类型可见的工具列表（未知类型返回空数组，最小权限） */
  getActiveTools(otterType: string): TTool[] {
    const toolConfig = this.otterToolConfigs.get(otterType);
    if (!toolConfig) {
      return [];
    }

    return toolConfig.activeToolNames
      .map(name => this.tools.get(name))
      .filter((t): t is TTool => t !== undefined);
  }

  /** 获取全部已注册工具 */
  getAllTools(): TTool[] {
    return Array.from(this.tools.values());
  }
}

/** 默认 Otter 工具配置（研究文档第 5 节） */
export const DEFAULT_OTTER_TOOL_CONFIGS: OtterToolConfig[] = [
  {
    otterType: "big",
    activeToolNames: [
      "send_message",
      "pass_talking_stone",
      "search_memory",
      "get_memory_detail",
      "store_memory",
      "create_otter",
      "dissolve_otter",
    ],
  },
  {
    otterType: "small",
    activeToolNames: ["send_message", "search_memory", "get_memory_detail", "create_linked_resource"],
  },
];
