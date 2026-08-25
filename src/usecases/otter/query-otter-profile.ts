import type { OtterRepository } from "@usecases/otter/otter-repository";
import type { OtterConfigProvider } from "@usecases/ports/otter-config-provider";
import type { ModelPoolLike } from "@usecases/ports/model-pool-like";
import type { Logger } from "@usecases/ports/logger";
import type { OtterProfileDTO } from "@contract/api/otter";
import { DomainError } from "@entities/errors";

/** ResourceLoader 类型（pi-coding-agent SDK，解耦具体实现） */
interface ResourceLoaderLike {
  getSkills(): { skills: Array<{ name: string; description: string; category: string }> };
}

/** 统计查询接口（解耦具体 DB 实现） */
interface StatsQuery {
  getMessageCountBySender(senderId: string): Promise<number>;
  getArtifactCountByLinkedBy(linkedBy: string): Promise<number>;
  getConversationCountByOtter(otterId: string): Promise<number>;
}

/** 静态工具目录（不侵入 tool-factory，仅提取 name + description + group 供展示） */
const TOOL_DISPLAY_CATALOG: OtterProfileDTO["tools"] = [
  { name: "speak", description: "发言工具——你在聊天室里唯一的发言通道", group: "沟通" },
  { name: "yield", description: "交棒工具——结束你的本轮行动，把行动权交给指定的参与者", group: "沟通" },
  { name: "search_memory", description: "检索记忆：跨会话的历史决策、讨论、F/R 文档与事实", group: "记忆" },
  { name: "get_memory_detail", description: "渐进式披露第二阶段：按 ID 获取记忆条目完整内容", group: "记忆" },
  { name: "link_memory", description: "声明两个记忆条目之间的关系", group: "记忆" },
  { name: "get_related", description: "从一个记忆条目出发遍历关系图", group: "记忆" },
  { name: "unlink_memory", description: "删除一条关系边", group: "记忆" },
  { name: "sync_docs", description: "同步特性/研究文档入库", group: "记忆" },
  { name: "create_otter", description: "创建子 Otter 并让它就位待命", group: "团队" },
  { name: "dissolve_otter", description: "解散指定 Otter", group: "团队" },
  { name: "restart_otter", description: "重启指定 Otter 的獭生", group: "团队" },
  { name: "get_active_participants", description: "获取当前对话所有活跃参与者", group: "团队" },
  { name: "create_linked_resource", description: "创建链接资源（统一产物模型）", group: "产出" },
  { name: "list_artifacts", description: "查询当前对话的产物清单", group: "产出" },
  { name: "update_artifact_status", description: "更新产物生命周期状态", group: "产出" },
  { name: "get_message", description: "按 ID 获取消息详情", group: "消息" },
  { name: "list_messages", description: "分页查询当前对话的消息列表", group: "消息" },
  { name: "search_messages", description: "在当前对话中关键词搜索消息", group: "消息" },
  { name: "get_turn_history", description: "获取当前对话的 Turn 历史链", group: "消息" },
  { name: "get_context", description: "获取当前 Otter 的上下文", group: "上下文" },
  { name: "set_context", description: "设置当前 Otter 的上下文键值对", group: "上下文" },
  { name: "delete_context", description: "删除当前 Otter 的指定上下文 key", group: "上下文" },
  { name: "search_terminology", description: "在术语库中查找项目域内术语的定义", group: "术语" },
  { name: "add_terminology", description: "在术语库中记录新的项目域术语", group: "术语" },
  { name: "get_html_card_contract", description: "获取 HTML 卡片的完整写作契约", group: "UI" },
  { name: "query_dispatch_ledger", description: "查询派工台账", group: "管理" },
  { name: "manage_healing_events", description: "查询和管理 healing events", group: "自愈" },
  { name: "workspace_read", description: "读取工作区中指定文件的内容", group: "工作区" },
  { name: "workspace_write", description: "向工作区写入文件", group: "工作区" },
  { name: "workspace_list", description: "列出工作区中指定目录的内容", group: "工作区" },
  { name: "workspace_info", description: "获取当前对话的工作区信息", group: "工作区" },
  { name: "create_scheduled_task", description: "创建定时任务", group: "调度" },
];

export class QueryOtterProfile {
  constructor(
    private readonly otterRepo: OtterRepository,
    private readonly configProvider: OtterConfigProvider,
    private readonly modelPool: ModelPoolLike,
    private readonly logger: Logger,
    private readonly deps: {
      resourceLoader?: ResourceLoaderLike;
      statsQuery?: StatsQuery;
    } = {},
  ) {}

  async execute(otterId: string): Promise<OtterProfileDTO> {
    const otter = await this.otterRepo.getById(otterId);
    if (!otter) throw new DomainError("Otter not found", "not_found");
    if (otter.status === "dissolved") throw new DomainError("Otter dissolved", "not_found");

    const config = this.configProvider.getConfig(otterId);
    const modelAlias = config?.modelAlias ?? null;

    return {
      id: otter.id,
      name: otter.name,
      type: otter.type as "big" | "small",
      roleName: otter.role?.name ?? null,
      modelAlias,
      modelDescriptor: this.resolveModelDescriptor(modelAlias),
      systemPrompt: this.resolveSystemPrompt(config),
      skills: this.resolveSkills(otterId),
      tools: TOOL_DISPLAY_CATALOG,
      stats: await this.resolveStats(otterId),
    };
  }

  private resolveModelDescriptor(modelAlias: string | null): OtterProfileDTO["modelDescriptor"] {
    if (!modelAlias) return null;
    const desc = this.modelPool.describeModels().find(d => d.alias === modelAlias);
    if (!desc) return null;
    return { alias: desc.alias, description: desc.description, strengths: desc.strengths, weaknesses: desc.weaknesses };
  }

  private resolveSystemPrompt(config: ReturnType<OtterConfigProvider["getConfig"]>): string | null {
    if (!config?.systemPrompt) return null;
    return typeof config.systemPrompt === "string" ? config.systemPrompt : config.systemPrompt.systemPrompt ?? null;
  }

  private resolveSkills(otterId: string): OtterProfileDTO["skills"] {
    try {
      if (!this.deps.resourceLoader) return [];
      return this.deps.resourceLoader.getSkills().skills.map(s => ({ name: s.name, description: s.description, category: s.category }));
    } catch (err) {
      this.logger.warn("Failed to load skills for profile", { otterId, error: err instanceof Error ? err.message : String(err) });
      return [];
    }
  }

  private async resolveStats(otterId: string): Promise<OtterProfileDTO["stats"]> {
    try {
      if (!this.deps.statsQuery) return { messageCount: 0, artifactCount: 0, conversationCount: 0 };
      const [messageCount, artifactCount, conversationCount] = await Promise.all([
        this.deps.statsQuery.getMessageCountBySender(otterId),
        this.deps.statsQuery.getArtifactCountByLinkedBy(otterId),
        this.deps.statsQuery.getConversationCountByOtter(otterId),
      ]);
      return { messageCount, artifactCount, conversationCount };
    } catch (err) {
      this.logger.warn("Failed to load stats for profile", { otterId, error: err instanceof Error ? err.message : String(err) });
      return { messageCount: 0, artifactCount: 0, conversationCount: 0 };
    }
  }
}
