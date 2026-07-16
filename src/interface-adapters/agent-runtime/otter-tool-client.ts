import type { Message } from "@entities/conversation/message";
import type { ConversationParticipant } from "@entities/conversation/conversation";
import type { Otter } from "@entities/otter/otter";
import type { LinkedResource } from "@entities/conversation/conversation";
import type { TurnHistoryEntry } from "@usecases/conversation/conversation-repository";

/** 渐进式披露：detail_level 控制返回详细程度 */
export type DetailLevel = "summary" | "snippet" | "full";

/** 记忆条目（search_memory 返回结构，渐进式披露） */
export interface MemorySearchEntry {
  id: string;
  content: string;
  score: number;
  layer: string;
  /** detail_level="snippet" 时的匹配片段 */
  snippet?: string;
  contentType?: string;
  metadata?: Record<string, unknown>;
  createdAt?: string;
}

/** 记忆存储输入 */
export interface StoreMemoryInput {
  content: string;
  otterId: string;
  conversationId?: string;
}

/** 创建 Otter 输入 */
export interface CreateOtterInput {
  name: string;
  type: "big" | "small";
  systemPrompt: string;
  parentOtterId: string;
}

/** 链接资源输入 */
export interface LinkResourceInput {
  conversationId: string;
  url: string;
  title?: string;
  linkedBy: string;
}

/**
 * OtterToolClient：工具访问 Otter 数据的统一门面。
 * 不是机制层，是便利层——替代每个工具各自注入 use case 的模式。
 * main.ts 装配时创建，包装所有 use case 实例。
 */
export interface OtterToolClient {
  conversation: {
    message: {
      send(params: {
        conversationId: string;
        senderId: string;
        body: string;
        talkingStonePassedTo?: string[];
      }): Promise<Message>;
      getById(id: string): Promise<Message | null>;
      list(conversationId: string, opts?: { limit?: number; before?: string }): Promise<Message[]>;
      search(conversationId: string, query: string, limit?: number): Promise<Message[]>;
      getTurnHistory(conversationId: string, opts?: { includeMessages?: boolean }): Promise<TurnHistoryEntry[]>;
    };
    participant: {
      join(conversationId: string, otterId: string): Promise<ConversationParticipant>;
      getActive(conversationId: string): Promise<ConversationParticipant[]>;
    };
  };
  memory: {
    search(query: string, limit?: number, detailLevel?: DetailLevel): Promise<MemorySearchEntry[]>;
    /** 按 ID 批量获取完整记忆条目（渐进式披露 get_memory_detail） */
    getDetails(ids: string[]): Promise<MemorySearchEntry[]>;
    store(entry: StoreMemoryInput): Promise<string>;
  };
  otter: {
    create(params: CreateOtterInput): Promise<Otter>;
    dissolve(otterId: string): Promise<void>;
    getById(id: string): Promise<Otter | null>;
  };
  context: {
    get(otterId: string, key?: string): Promise<Record<string, string>>;
    set(otterId: string, key: string, value: string): Promise<void>;
  };
  resource: {
    link(params: LinkResourceInput): Promise<LinkedResource>;
  };
}
