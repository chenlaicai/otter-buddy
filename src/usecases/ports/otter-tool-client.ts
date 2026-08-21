/**
 * OtterToolClient 端口（R20260817arnt PR-A：自 interface-adapters/agent-runtime/otter-tool-client.ts
 * 整体上移）——usecase 门面：agent 工具经此访问对话/记忆/文档领域查询，bootstrap/clients.ts
 * 装配具体实现。其 import 全部落在 entities/usecases（上移合法的前提）。
 */
import type { Message, MessageSegment } from "@entities/conversation/message";
import type { ArtifactStatus, ConversationParticipant } from "@entities/conversation/conversation";
import type { Otter } from "@entities/otter/otter";
import type { OtterSession } from "@entities/otter/otter-session";
import type { LinkedResource } from "@entities/conversation/conversation";
import type { TurnHistoryEntry } from "@usecases/conversation/conversation-repository";
import type { DetailLevel, MemoryContentType } from "@entities/memory/memory-entry";
import type { EdgeType, RelatedEntryItem } from "@entities/memory/memory-edge";

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
      /** 开始发言（yield 交棒）：streaming → speaking，设置发言石目标；body 可选（拆分后内容由 speak 的 appendSegment 落库） */
      startSpeaking(messageId: string, params: {
        body?: string;
        talkingStonePassedTo: string[];
      }): Promise<Message>;
      /** 追加一条 speak 片段到消息 */
      appendSegment(messageId: string, body: string): Promise<MessageSegment>;
      /** 完成消息：speaking → completed */
      complete(messageId: string, params?: {
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
    search(query: string, limit?: number, detailLevel?: DetailLevel, library?: string, createdAfter?: string, contentType?: MemoryContentType[], expandContext?: boolean): Promise<{ entries: MemorySearchEntry[]; contextEntries?: MemorySearchEntry[] }>;
    /** 按 ID 批量获取完整记忆条目（渐进式披露 get_memory_detail） */
    getDetails(ids: string[]): Promise<MemorySearchEntry[]>;
    /** F20260813mren: 声明两个记忆条目之间的关系（LLM 自主判断） */
    linkMemory(params: { fromId: string; toId: string; edgeType: EdgeType; note?: string }, createdBy?: string): Promise<{ edgeId: string }>;
    /** F20260813mren: 从某 entry 出发 BFS 遍历关系图，返回结构化 path */
    getRelated(params: { entryId: string; depth?: number; edgeTypes?: EdgeType[]; direction?: "out" | "in"; limit?: number }): Promise<RelatedEntryItem[]>;
    /** F20260813mren: 删除一条关系边（纠错用） */
    unlinkEdge(edgeId: string): Promise<void>;
    /**
     * F20260813mren Part 2: 查文档 provenance——该文档由哪段对话产出 + 该对话的消息。
     * 只对 feature/research 文档有效；非文档或无 provenance 返回 conversationId=null。
     */
    getDocProvenance(entryId: string): Promise<{ conversationId: string | null; messages: MemorySearchEntry[] }>;
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
  /**
   * F20260813mren 审视二轮：文档同步工具。
   * 海獭写完 docs/features|research 下的文档后调用，立即入库（不等重启），
   * 让文档立刻可被 search_memory 检索 + provenance 立即可查。
   * 审视三轮 A-10：rootDir 可选——worktree 流程下文槛在 worktree 里，
   * 海獭应传 worktree 绝对路径，否则默认扫主仓根扫不到刚写的文档。
   */
  docs: {
    sync(rootDir?: string): Promise<{ synced: number; updated: number; skipped: number; archived: number; errors: number }>;
  };
  /**
   * F20260821i336：派工台账工具。
   * 大獭派工时创建记录，小獭完成时更新状态，汇报前可核对。
   */
  dispatch: {
    createRecord(params: { conversationId: string; otterId: string; otterName: string; task: string }): Promise<{ id: string }>;
    updateRecord(params: { otterId: string; conversationId: string; status: 'pending' | 'in_progress' | 'completed' | 'failed'; resultPr?: string; resultSummary?: string }): Promise<void>;
    queryRecords(params: { conversationId: string; status?: 'pending' | 'in_progress' | 'completed' | 'failed'; otterId?: string }): Promise<Array<{
      id: string; conversationId: string; otterId: string; otterName: string; task: string;
      status: 'pending' | 'in_progress' | 'completed' | 'failed';
      createdAt: string; updatedAt: string; completedAt?: string; resultPr?: string; resultSummary?: string;
    }>>;
  };
}
