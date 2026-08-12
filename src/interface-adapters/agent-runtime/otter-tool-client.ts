import type { Message } from "@entities/conversation/message";
import type { ArtifactStatus, ConversationParticipant } from "@entities/conversation/conversation";
import type { Otter } from "@entities/otter/otter";
import type { OtterSession } from "@entities/otter/otter-session";
import type { LinkedResource } from "@entities/conversation/conversation";
import type { TurnHistoryEntry } from "@usecases/conversation/conversation-repository";
import type { DetailLevel, MemoryContentType } from "@entities/memory/memory-entry";

/** 记忆条目（search_memory 返回结构，渐进式披露） */
export interface MemorySearchEntry {
  id: string;
  content: string;
  /** 检索分数（getDetails 返回时无此字段） */
  score?: number;
  layer: string;
  /** detail_level="snippet" 时的匹配片段 */
  snippet?: string;
  contentType?: string;
  metadata?: Record<string, unknown>;
  createdAt?: string;
}

/** 创建 Otter 输入 */
export interface CreateOtterInput {
  name: string;
  type: "big" | "small";
  systemPrompt: string;
  parentOtterId: string;
  /** 模型别名（多模型路由，可选） */
  modelAlias?: string;
}

/** 链接资源输入 */
export interface LinkResourceInput {
  conversationId: string;
  url?: string;
  title?: string;
  content?: string;
  category?: string;
  linkedBy: string;
  resourceType?: string;
  groupId?: string;
}

/**
 * OtterToolClient：工具访问 Otter 数据的统一门面。
 * 不是机制层，是便利层——替代每个工具各自注入 use case 的模式。
 * main.ts 装配时创建，包装所有 use case 实例。
 */
export interface OtterToolClient {
  conversation: {
    message: {
      /** 开始发言：streaming → speaking，暂存 body + 发言石目标（speak 工具调用） */
      startSpeaking(messageId: string, params: {
        body: string;
        talkingStonePassedTo: string[];
      }): Promise<Message>;
      /** 完成消息：speaking → completed */
      complete(messageId: string, params?: {
        body?: string;
        talkingStonePassedTo?: string[];
      }): Promise<{ message: Message; turnClose: { closed: boolean; aggregatedTargets: string[] } }>;
      getById(id: string): Promise<Message | null>;
      list(conversationId: string, opts?: { limit?: number; before?: string }): Promise<Message[]>;
      search(conversationId: string, query: string, limit?: number): Promise<Message[]>;
      getTurnHistory(conversationId: string, opts?: { includeMessages?: boolean }): Promise<TurnHistoryEntry[]>;
    };
    participant: {
      join(conversationId: string, otterId: string): Promise<ConversationParticipant>;
      getActive(conversationId: string): Promise<Array<ConversationParticipant & { otterName: string }>>;
      /** 标记 otter 在指定对话中已离开（dissolve_otter 顺带修） */
      leave(conversationId: string, otterId: string): Promise<void>;
    };
    getActiveTurnNumber(conversationId: string): Promise<number>;
  };
  memory: {
    getById(id: string): Promise<MemorySearchEntry | null>;
    search(query: string, limit?: number, detailLevel?: DetailLevel, library?: string, createdAfter?: string, contentType?: MemoryContentType[], expandContext?: boolean): Promise<MemorySearchEntry[]>;
    /** 按 ID 批量获取完整记忆条目（渐进式披露 get_memory_detail） */
    getDetails(ids: string[]): Promise<MemorySearchEntry[]>;
  };
  terminology: {
    search(query: string, limit?: number): Promise<Array<{ id: string; term: string; definition: string; aliases: string[]; category: string | null; context: string | null }>>;
    addTerm(params: { term: string; definition: string; aliases?: string[]; category?: string; context?: string }): Promise<{ id: string; term: string }>;
  };
  otter: {
    create(params: CreateOtterInput): Promise<Otter>;
    dissolve(otterId: string): Promise<void>;
    getById(id: string): Promise<Otter | null>;
    /** 重启獭生：归档当前 session + 创建新 session（含前情摘要）。F20260810rstart */
    restart(otterId: string, summary?: string): Promise<OtterSession>;
  };
  context: {
    get(otterId: string, key?: string): Promise<Record<string, string>>;
    set(otterId: string, key: string, value: string): Promise<void>;
    delete(otterId: string, key: string): Promise<void>;
  };
  resource: {
    link(params: LinkResourceInput, currentTurnNumber?: number): Promise<LinkedResource>;
    list(conversationId: string, filters?: { status?: ArtifactStatus; resourceType?: string }): Promise<LinkedResource[]>;
    listByGroup(conversationId: string, groupId: string): Promise<LinkedResource[]>;
    updateStatus(id: string, status: ArtifactStatus, statusChangedAtTurnNumber: number, supersededBy?: string): Promise<void>;
    supersede(existingId: string, newInput: LinkResourceInput, currentTurnNumber: number): Promise<LinkedResource>;
    archive(id: string, conversationId: string, currentTurnNumber: number): Promise<void>;
  };
}
